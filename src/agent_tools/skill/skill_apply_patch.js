/**
 * 将 Codex `apply_patch` 的核心解析与文本替换逻辑移植到skill 的虚拟文件模型中。
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
  buildStoredSkillRecord,
  SKILL_VIRTUAL_MANIFEST_PATH,
  normalizeSkillFilePath,
  normalizeSkillName,
  parseSkillVirtualManifestContent,
  normalizeStoredSkillRecord,
  pickDefaultSkillInstructionPath,
  pickDefaultSkillRuntimeEntryPath,
  serializeSkillVirtualManifest
} from './registry_tool.js';
import {
  assertUniqueApplyPatchSourcePaths,
  derivePatchedFileContent,
  normalizeApplyPatchVerificationError,
  parseApplyPatch,
  seekSequence
} from '../shared/apply_patch_core.js';

export function parseSkillApplyPatch(patch, options = {}) {
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

/**
 * Skill 写入目标只能由 patch 内的 Environment ID 决定。独立 skill_name 既不参与
 * 路由，也不能在缺少 Environment ID 时替代它，避免 sidebar 与 background 对目标
 * 产生两套互相矛盾的解释。
 */
export function resolveSkillApplyPatchTarget(patchOrParsed) {
  try {
    const parsed = typeof patchOrParsed === 'string'
      ? parseSkillApplyPatch(patchOrParsed, { mode: 'strict' })
      : patchOrParsed;
    const environmentId = typeof parsed?.environment_id === 'string'
      ? parsed.environment_id.trim()
      : '';
    if (!environmentId) {
      const error = new Error('Skill apply_patch requires `*** Environment ID: skill:<stable-key>` immediately after `*** Begin Patch`.');
      error.code = 'APPLY_PATCH_ENVIRONMENT_ID_REQUIRED';
      error.stage = 'select_environment';
      throw error;
    }
    if (!environmentId.startsWith('skill:')) {
      const error = new Error(`Unsupported apply_patch environment \`${environmentId}\`; expected \`skill:<stable-key>\`.`);
      error.code = 'APPLY_PATCH_ENVIRONMENT_ID_INVALID';
      error.stage = 'select_environment';
      throw error;
    }
    const skillName = normalizeSkillName(environmentId.slice('skill:'.length));
    return {
      parsed,
      environment_id: environmentId,
      skill_name: skillName
    };
  } catch (error) {
    throw normalizeApplyPatchVerificationError(error, {
      stage: error?.stage || 'select_environment'
    });
  }
}

/**
 * 纯 prepare 阶段：读取到的当前 revision 是唯一输入，所有 hunk 在内存中完成
 * 验证与结果构造。调用方只有在本函数完整成功后，才允许执行一次持久化提交。
 */
export function prepareSkillPackagePatch(record, patch) {
  const skill = normalizeStoredSkillRecord(record);
  const target = resolveSkillApplyPatchTarget(patch);
  try {
    if (!skill) {
      throw new Error('Cannot apply patch to an invalid skill record.');
    }
    if (skill.name !== target.skill_name) {
      const error = new Error(`Patch environment ${target.environment_id} does not match loaded skill ${skill.name}.`);
      error.code = 'APPLY_PATCH_ENVIRONMENT_TARGET_MISMATCH';
      error.stage = 'select_environment';
      throw error;
    }

    const { hunks } = target.parsed;
    if (hunks.length <= 0) {
      throw new Error('No files were modified.');
    }
    assertUniqueApplyPatchSourcePaths(hunks, normalizeSkillFilePath);

    const nextFiles = cloneFiles(skill.files);
    let instructionPath = skill.instruction.path;
    let runtimeEntryPath = skill.runtime.entry_path;
    let manifestInput = null;
    let manifestContent = serializeSkillVirtualManifest(skill);
    const affectedFiles = {
      added: [],
      modified: [],
      deleted: []
    };

    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
      const hunk = hunks[hunkIndex];
      const normalizedHunkPath = normalizeSkillFilePath(hunk.path);
      const isManifestHunk = normalizedHunkPath === SKILL_VIRTUAL_MANIFEST_PATH;

      try {
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
          if (sourcePath === SKILL_VIRTUAL_MANIFEST_PATH) {
            if (hunk.move_path) {
              throw new Error('manifest.json 是保留虚拟文件，不支持 Move to。');
            }
            manifestContent = derivePatchedFileContent(manifestContent, sourcePath, hunk.chunks);
            manifestInput = parseSkillVirtualManifestContent(manifestContent, skill);
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
          const targetPath = hunk.move_path ? normalizeSkillFilePath(hunk.move_path) : sourcePath;
          if (hunk.move_path && targetPath === SKILL_VIRTUAL_MANIFEST_PATH) {
            throw new Error('manifest.json 是保留虚拟文件，不支持 Move to。');
          }

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
        }
      } catch (error) {
        throw normalizeApplyPatchVerificationError(error, {
          stage: 'verify',
          file_path: normalizedHunkPath,
          environment_id: target.environment_id,
          skill_name: target.skill_name,
          revision: skill.revision,
          hunk_index: hunkIndex + 1
        });
      }
    }

    if (instructionPath && findFileIndex(nextFiles, instructionPath) < 0) {
      instructionPath = pickDefaultSkillInstructionPath(nextFiles);
    }
    if (runtimeEntryPath && findFileIndex(nextFiles, runtimeEntryPath) < 0) {
      runtimeEntryPath = pickDefaultSkillRuntimeEntryPath(nextFiles);
    }

    const nextRecord = buildStoredSkillRecord({
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
      environment_id: target.environment_id,
      skill_name: target.skill_name,
      hunks,
      affected_files: {
        added: Array.from(new Set(affectedFiles.added)),
        modified: Array.from(new Set(affectedFiles.modified)),
        deleted: Array.from(new Set(affectedFiles.deleted))
      },
      record: nextRecord
    };
  } catch (error) {
    throw normalizeApplyPatchVerificationError(error, {
      stage: error?.stage || 'verify',
      environment_id: target.environment_id,
      skill_name: target.skill_name,
      revision: skill?.revision
    });
  }
}

// 兼容现有内部导入；语义已经是“只 prepare，不持久化”。
export const applySkillPackagePatch = prepareSkillPackagePatch;
