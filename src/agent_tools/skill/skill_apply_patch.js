/**
 * OpenAI Responses API 官方 apply_patch operation 的 skill 包执行器。
 *
 * 这里不定义模型工具 schema，也不解析旧 `*** Begin Patch` 多文件格式。模型侧只会
 * 收到官方 `{ type: "apply_patch" }`；本模块负责把单文件 V4A operation 原子地应用到
 * 已持久化的 skill 虚拟文件包。
 */

import {
  buildStoredSkillRecord,
  inferSkillFileKindForPath,
  SKILL_VIRTUAL_MANIFEST_PATH,
  normalizeSkillFilePath,
  parseSkillVirtualManifestContent,
  normalizeStoredSkillRecord,
  pickDefaultSkillInstructionPath,
  pickDefaultSkillRuntimeEntryPath,
  serializeSkillVirtualManifest
} from './registry_tool.js';
import {
  applyOpenAIApplyPatchDiff,
  normalizeOpenAIApplyPatchOperation
} from '../virtual_file_io/openai_apply_patch.js';

function cloneFiles(files) {
  return (Array.isArray(files) ? files : []).map((file) => ({ ...file }));
}

function findFileIndex(files, filePath) {
  return files.findIndex((file) => file.path === filePath);
}

/**
 * 将一个官方单文件 operation 应用到 skill 包快照。
 *
 * - manifest.json 只能 update，不能 create/delete；
 * - create 遇到同名文件严格失败；
 * - update 使用 OpenAI 官方 V4A applyDiff；
 * - delete 会同步修正 instruction/runtime 指针，并禁止删除最后一个真实文件。
 */
export function applyOpenAIApplyPatchOperationToSkillPackage(record, rawOperation) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) {
    throw new Error('Cannot apply OpenAI patch operation to an invalid skill record.');
  }

  const operation = normalizeOpenAIApplyPatchOperation(rawOperation);
  const path = normalizeSkillFilePath(operation.path);
  const normalizedOperation = { ...operation, path };
  const nextFiles = cloneFiles(skill.files);
  const affectedFiles = {
    added: [],
    modified: [],
    deleted: []
  };

  if (path === SKILL_VIRTUAL_MANIFEST_PATH) {
    if (operation.type !== 'update_file') {
      throw new Error('manifest.json 是保留虚拟文件，只支持 update_file。');
    }
    const currentManifest = serializeSkillVirtualManifest(skill);
    const nextManifest = applyOpenAIApplyPatchDiff(currentManifest, normalizedOperation);
    const manifestInput = parseSkillVirtualManifestContent(nextManifest, skill);
    const nextRecord = buildStoredSkillRecord({
      ...skill,
      ...manifestInput,
      files: nextFiles
    }, skill);
    affectedFiles.modified.push(path);
    return {
      operation: normalizedOperation,
      affected_files: affectedFiles,
      record: nextRecord
    };
  }

  const existingIndex = findFileIndex(nextFiles, path);
  let instructionPath = skill.instruction.path;
  let runtimeEntryPath = skill.runtime.entry_path;

  if (operation.type === 'create_file') {
    if (existingIndex >= 0) {
      throw new Error(`技能 ${skill.name} 中已存在文件 ${path}，无法 create_file。`);
    }
    const content = applyOpenAIApplyPatchDiff('', normalizedOperation);
    nextFiles.push({
      path,
      kind: inferSkillFileKindForPath(path, {
        instructionPath,
        runtimeEntryPath
      }),
      content
    });
    affectedFiles.added.push(path);
  } else if (operation.type === 'update_file') {
    if (existingIndex < 0) {
      throw new Error(`技能 ${skill.name} 中不存在文件 ${path}，无法 update_file。`);
    }
    const existingFile = nextFiles[existingIndex];
    nextFiles[existingIndex] = {
      ...existingFile,
      content: applyOpenAIApplyPatchDiff(existingFile.content, normalizedOperation)
    };
    affectedFiles.modified.push(path);
  } else {
    if (existingIndex < 0) {
      throw new Error(`技能 ${skill.name} 中不存在文件 ${path}，无法 delete_file。`);
    }
    if (nextFiles.length <= 1) {
      throw new Error(`技能 ${skill.name} 只剩最后一个文件，不能删除。`);
    }
    nextFiles.splice(existingIndex, 1);
    if (instructionPath === path) {
      instructionPath = pickDefaultSkillInstructionPath(nextFiles);
    }
    if (runtimeEntryPath === path) {
      runtimeEntryPath = pickDefaultSkillRuntimeEntryPath(nextFiles);
    }
    affectedFiles.deleted.push(path);
  }

  const nextRecord = buildStoredSkillRecord({
    ...skill,
    instruction: {
      path: instructionPath || pickDefaultSkillInstructionPath(nextFiles)
    },
    runtime: {
      entry_path: runtimeEntryPath
    },
    files: nextFiles
  }, skill);

  return {
    operation: normalizedOperation,
    affected_files: affectedFiles,
    record: nextRecord
  };
}
