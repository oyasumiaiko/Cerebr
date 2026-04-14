/**
 * 将 Codex `apply_patch` 的核心解析与文本替换逻辑移植到微型 skill 的虚拟文件模型中。
 *
 * 这里刻意保留 Codex 原始补丁格式：
 * - `*** Begin Patch` / `*** End Patch`
 * - `*** Add File:` / `*** Delete File:` / `*** Update File:`
 * - `*** Move to:`
 * - `@@` 更新块与 `+` / `-` / ` ` 行前缀
 *
 * 在 Cerebr 里，文件用途不再靠额外枚举驱动，而是靠：
 * - manifest 指针：`instruction.path`、`runtime.entry_path`
 * - 路径约定：例如 `src/`、`templates/`、`references/`
 *
 * 因此这里不再额外引入 `File Kind` 之类的扩展指令，尽量让模型直接复用
 * Codex 原生 patch 心智模型。
 */

import {
  buildStoredMicroSkillRecord,
  MICRO_SKILL_VIRTUAL_MANIFEST_PATH,
  normalizeMicroSkillFilePath,
  parseMicroSkillVirtualManifestContent,
  normalizeStoredMicroSkillRecord,
  pickDefaultMicroSkillInstructionPath,
  pickDefaultMicroSkillRuntimeEntryPath,
  serializeMicroSkillVirtualManifest
} from './registry_tool.js';
import {
  derivePatchedFileContent,
  parseApplyPatch,
  seekSequence
} from '../shared/apply_patch_core.js';

export function parseMicroSkillApplyPatch(patch, options = {}) {
  return parseApplyPatch(patch, options);
}

export { seekSequence };

function cloneFiles(files) {
  return (Array.isArray(files) ? files : []).map((file) => ({ ...file }));
}

function findFileIndex(files, filePath) {
  return files.findIndex((file) => file.path === filePath);
}

function upsertFilePreservingOrder(files, file, existingIndex = null) {
  const resolvedIndex = Number.isInteger(existingIndex) ? existingIndex : findFileIndex(files, file.path);
  if (resolvedIndex >= 0) {
    files[resolvedIndex] = file;
  } else {
    files.push(file);
  }
}

export function applyMicroSkillPackagePatch(record, patch) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) {
    throw new Error('Cannot apply patch to an invalid micro skill record.');
  }

  const { hunks } = parseMicroSkillApplyPatch(patch, { mode: 'strict' });
  if (hunks.length <= 0) {
    throw new Error('No files were modified.');
  }

  const nextFiles = cloneFiles(skill.files);
  let instructionPath = skill.instruction.path;
  let runtimeEntryPath = skill.runtime.entry_path;
  let manifestInput = null;
  let manifestContent = serializeMicroSkillVirtualManifest(skill);
  const affectedFiles = {
    added: [],
    modified: [],
    deleted: []
  };

  for (const hunk of hunks) {
    const normalizedHunkPath = normalizeMicroSkillFilePath(hunk.path);
    const isManifestHunk = normalizedHunkPath === MICRO_SKILL_VIRTUAL_MANIFEST_PATH;

    if (isManifestHunk && hunk.type === 'add_file') {
      throw new Error('manifest.json 是保留虚拟文件，不支持 Add File。');
    }
    if (isManifestHunk && hunk.type === 'delete_file') {
      throw new Error('manifest.json 是保留虚拟文件，不支持 Delete File。');
    }

    if (hunk.type === 'add_file') {
      const normalizedPath = normalizedHunkPath;
      const existingIndex = findFileIndex(nextFiles, normalizedPath);
      const existingFile = existingIndex >= 0 ? nextFiles[existingIndex] : null;
      upsertFilePreservingOrder(nextFiles, {
        path: normalizedPath,
        kind: existingFile?.kind || null,
        content: hunk.contents
      }, existingIndex);
      if (existingFile) {
        affectedFiles.modified.push(normalizedPath);
      } else {
        affectedFiles.added.push(normalizedPath);
      }
      continue;
    }

    if (hunk.type === 'delete_file') {
      const normalizedPath = normalizedHunkPath;
      const existingIndex = findFileIndex(nextFiles, normalizedPath);
      if (existingIndex < 0) {
        throw new Error(`Failed to delete file ${normalizedPath}`);
      }
      nextFiles.splice(existingIndex, 1);
      if (instructionPath === normalizedPath) instructionPath = null;
      if (runtimeEntryPath === normalizedPath) runtimeEntryPath = null;
      affectedFiles.deleted.push(normalizedPath);
      continue;
    }

    if (hunk.type === 'update_file') {
      const sourcePath = normalizedHunkPath;
      if (sourcePath === MICRO_SKILL_VIRTUAL_MANIFEST_PATH) {
        if (hunk.move_path) {
          throw new Error('manifest.json 是保留虚拟文件，不支持 Move to。');
        }
        manifestContent = derivePatchedFileContent(manifestContent, sourcePath, hunk.chunks);
        manifestInput = parseMicroSkillVirtualManifestContent(manifestContent, skill);
        if (manifestInput?.instruction?.path) {
          instructionPath = manifestInput.instruction.path;
        }
        if (Object.prototype.hasOwnProperty.call(manifestInput?.runtime || {}, 'entry_path')) {
          runtimeEntryPath = manifestInput.runtime.entry_path;
        }
        affectedFiles.modified.push(sourcePath);
        continue;
      }
      const sourceIndex = findFileIndex(nextFiles, sourcePath);
      if (sourceIndex < 0) {
        throw new Error(`Failed to read file to update ${sourcePath}`);
      }

      const sourceFile = nextFiles[sourceIndex];
      const nextContent = derivePatchedFileContent(sourceFile.content, sourcePath, hunk.chunks);
      const targetPath = hunk.move_path ? normalizeMicroSkillFilePath(hunk.move_path) : sourcePath;

      if (targetPath === sourcePath) {
        nextFiles[sourceIndex] = {
          path: sourcePath,
          kind: sourceFile.kind,
          content: nextContent
        };
      } else {
        const targetIndex = findFileIndex(nextFiles, targetPath);
        if (targetIndex >= 0 && targetIndex !== sourceIndex) {
          nextFiles[targetIndex] = {
            path: targetPath,
            kind: sourceFile.kind,
            content: nextContent
          };
          nextFiles.splice(sourceIndex, 1);
        } else {
          nextFiles[sourceIndex] = {
            path: targetPath,
            kind: sourceFile.kind,
            content: nextContent
          };
        }
        if (instructionPath === sourcePath) instructionPath = targetPath;
        if (runtimeEntryPath === sourcePath) runtimeEntryPath = targetPath;
      }
      affectedFiles.modified.push(targetPath);
      continue;
    }
  }

  if (instructionPath && findFileIndex(nextFiles, instructionPath) < 0) {
    instructionPath = pickDefaultMicroSkillInstructionPath(nextFiles);
  }
  if (runtimeEntryPath && findFileIndex(nextFiles, runtimeEntryPath) < 0) {
    runtimeEntryPath = pickDefaultMicroSkillRuntimeEntryPath(nextFiles);
  }

  const nextRecord = buildStoredMicroSkillRecord({
    ...skill,
    ...(manifestInput || {}),
    instruction: {
      path: manifestInput?.instruction?.path ?? instructionPath
    },
    runtime: {
      entry_path: Object.prototype.hasOwnProperty.call(manifestInput?.runtime || {}, 'entry_path')
        ? manifestInput.runtime.entry_path
        : runtimeEntryPath
    },
    files: nextFiles
  }, skill);

  return {
    patch: String(patch || ''),
    hunks,
    affected_files: {
      added: Array.from(new Set(affectedFiles.added)),
      modified: Array.from(new Set(affectedFiles.modified)),
      deleted: Array.from(new Set(affectedFiles.deleted))
    },
    record: nextRecord
  };
}
