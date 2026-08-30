/**
 * 统一虚拟文件工具。
 *
 * 说明：
 * - 顶层公开给模型的文件工具统一为 `apply_patch` / `list_files` / `read_file` / `search_files` / `copy_file`；
 * - 默认根就是当前对话文件根；Skill 通过 `environment_id=skill:<stable-key>` 选择；
 * - 默认根中的本机只读映射通过显式 `local/...` 路径进入；
 * - 会话文件仍在侧栏本地 IndexedDB 执行；local 文件实时读取用户授权 handle；skill 文件复用现有 skill package / background 执行链路；
 * - UI 为了编辑对话文档与完整查看，会额外复用 `write_file` / `read_file_full` 两个内部 action。
 *
 * 当前目录结构：
 * - 顶层文件工具按动作拆到独立文件；
 * - `index.js` 负责保留公共导出面与执行路由；
 * - 这样既能保持外部调用稳定，也能让 tool-family 内部不再继续扁平堆叠。
 */

import {
  assertUniqueApplyPatchSourcePaths,
  derivePatchedFileContent,
  normalizeApplyPatchVerificationError,
  parseApplyPatch
} from '../shared/apply_patch_core.js';
import { buildApplyPatchRuntimeContractPayload } from '../shared/apply_patch_contract.js';
import {
  hasVirtualPathGlobSyntax,
  matchesVirtualPathFilter,
  normalizeVirtualPathFilter
} from '../shared/virtual_file_path.js';
import {
  getConversationDocument,
  listConversationDocuments,
  mutateConversationDocuments,
  putConversationDocument
} from '../../storage/conversation_document_store.js';
import { listLocalFileMounts } from '../../storage/local_file_mount_store.js';
import {
  CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
  CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME,
  CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
  CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_INTERNAL_ACTIONS,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_PUBLIC_ACTIONS,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT,
  VIRTUAL_FILE_ENVIRONMENT_KIND_LOCAL,
  VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL,
  assertOnlyObjectKeys,
  assertPlainObject,
  buildDocumentSizeChars,
  normalizeString,
  toIsoTimestamp
} from './shared.js';
import {
  normalizeVirtualFileEnvironmentId,
  summarizeVirtualFileEnvironment
} from './environment.js';
import {
  buildVirtualTextReadResult,
  normalizeVirtualFileLineRange,
  readNullableSafeInteger,
  searchVirtualTextDocuments
} from './text_query.js';
import {
  buildConversationDocumentCollisionPath,
  normalizeConversationDocumentHrefPath,
  normalizeConversationDocumentPath
} from './document_path.js';
import {
  buildConversationDocumentApplyPatchCustomToolDefinition,
  buildVirtualFileApplyPatchCustomToolDefinition,
  normalizeVirtualFileApplyPatchArguments,
  normalizeVirtualFileApplyPatchCustomInput
} from './apply_patch.js';
import {
  buildConversationDocumentListFilesFunctionToolDefinition,
  buildVirtualFileListFilesFunctionToolDefinition,
  normalizeVirtualFileListFilesArguments
} from './list_files.js';
import {
  buildConversationDocumentReadFileFunctionToolDefinition,
  buildVirtualFileReadFileFunctionToolDefinition,
  normalizeVirtualFileReadFileArguments
} from './read_file.js';
import {
  buildConversationDocumentSearchFilesFunctionToolDefinition,
  buildVirtualFileSearchFilesFunctionToolDefinition,
  normalizeVirtualFileSearchFilesArguments
} from './search_files.js';
import {
  buildConversationDocumentCopyFileFunctionToolDefinition,
  buildVirtualFileCopyFileFunctionToolDefinition,
  normalizeVirtualFileCopyFileArguments
} from './file_ops.js';
import {
  assertPatchDoesNotTouchLocalPaths,
  assertWritableRootPath,
  isLocalVirtualPath,
  listLocalVirtualFileDocuments,
  readLocalVirtualFileDocument
} from './local_mount.js';

export {
  CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
  CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME,
  CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
  CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT,
  VIRTUAL_FILE_ENVIRONMENT_KIND_LOCAL,
  VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL
};

export {
  normalizeVirtualFileEnvironmentId,
  normalizeConversationDocumentPath,
  normalizeConversationDocumentHrefPath,
  buildConversationDocumentCollisionPath,
  buildVirtualFileApplyPatchCustomToolDefinition,
  buildConversationDocumentApplyPatchCustomToolDefinition,
  normalizeVirtualFileApplyPatchCustomInput,
  buildVirtualFileListFilesFunctionToolDefinition,
  buildConversationDocumentListFilesFunctionToolDefinition,
  buildVirtualFileReadFileFunctionToolDefinition,
  buildConversationDocumentReadFileFunctionToolDefinition,
  buildVirtualFileSearchFilesFunctionToolDefinition,
  buildConversationDocumentSearchFilesFunctionToolDefinition,
  buildVirtualFileCopyFileFunctionToolDefinition,
  buildConversationDocumentCopyFileFunctionToolDefinition
};

function normalizeConversationId(value) {
  const text = normalizeString(value);
  if (!text) {
    throw new Error('virtual_file 参数错误：conversation_id 不能为空。');
  }
  return text;
}

function buildDocumentManifest(documents, options = {}) {
  const pathGlob = normalizeVirtualPathFilter(options?.path_glob, { label: 'path_glob' });
  const files = normalizeDocumentRecords(documents, { requireContent: false })
    .filter((doc) => matchesVirtualPathFilter(doc.path, pathGlob))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((doc) => {
      const sizeChars = doc.size_chars != null && Number.isFinite(Number(doc.size_chars))
        ? Math.max(0, Math.trunc(Number(doc.size_chars)))
        : (typeof doc.content === 'string' ? buildDocumentSizeChars(doc.content) : null);
      return {
        path: doc.path,
        ...(sizeChars != null ? { size_chars: sizeChars } : {}),
        updated_at: toIsoTimestamp(doc.updated_at)
      };
    });
  return {
    path_glob: pathGlob,
    total_files: files.length,
    returned_file_count: files.length,
    files
  };
}

function normalizeDocumentRecord(rawDocument, fallbackUpdatedAt = null, options = {}) {
  if (!rawDocument || typeof rawDocument !== 'object' || Array.isArray(rawDocument)) {
    throw new Error('conversation file store 包含非 object 记录。');
  }
  const path = normalizeConversationDocumentPath(rawDocument.path);
  if (options?.requireContent !== false && typeof rawDocument.content !== 'string') {
    throw new Error(`conversation file store 中的 ${path} 缺少字符串 content。`);
  }
  const content = typeof rawDocument.content === 'string' ? rawDocument.content : '';
  return {
    path,
    content,
    updated_at: toIsoTimestamp(rawDocument.updated_at || fallbackUpdatedAt || new Date().toISOString()),
    size_chars: buildDocumentSizeChars(content)
  };
}

function normalizeDocumentRecords(documents, options = {}) {
  if (!Array.isArray(documents)) {
    throw new Error('conversation file store 必须返回数组。');
  }
  const seenPaths = new Set();
  const records = [];
  for (const rawDocument of cloneDocuments(documents)) {
    const record = normalizeDocumentRecord(rawDocument, null, options);
    if (seenPaths.has(record.path)) {
      throw new Error(`conversation file store 包含重复路径 ${record.path}。`);
    }
    seenPaths.add(record.path);
    records.push(record);
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function cloneDocuments(documents) {
  return (Array.isArray(documents) ? documents : []).map((doc) => ({ ...doc }));
}

function findDocumentIndex(documents, path) {
  return documents.findIndex((doc) => doc.path === path);
}

function applyConversationDocumentPatch(documents, patch) {
  let hunks;
  try {
    ({ hunks } = parseApplyPatch(patch));
    if (hunks.length <= 0) {
      throw new Error('No files were modified.');
    }
    assertUniqueApplyPatchSourcePaths(hunks, normalizeConversationDocumentPath);
  } catch (error) {
    throw normalizeApplyPatchVerificationError(error, { stage: error?.stage || 'verify' });
  }

  const currentDocuments = normalizeDocumentRecords(documents);
  const preparedOperations = [];
  const patchTime = new Date().toISOString();

  // 验证阶段始终读取调用开始时的不可变快照，禁止后一个 hunk 依赖前一个 hunk 的未提交结果。
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex];
    let sourcePath = null;
    try {
      if (hunk.type === 'add_file') {
        const targetPath = normalizeConversationDocumentPath(hunk.path);
        sourcePath = targetPath;
        preparedOperations.push({
          type: 'add_file',
          source_path: targetPath,
          target_path: targetPath,
          content: hunk.contents,
          destination_existed: findDocumentIndex(currentDocuments, targetPath) >= 0
        });
        continue;
      }

      if (hunk.type === 'delete_file') {
        const targetPath = normalizeConversationDocumentPath(hunk.path);
        sourcePath = targetPath;
        const existingIndex = findDocumentIndex(currentDocuments, targetPath);
        if (existingIndex < 0) {
          throw new Error(`Failed to delete file ${targetPath}`);
        }
        preparedOperations.push({
          type: 'delete_file',
          source_path: targetPath,
          target_path: targetPath
        });
        continue;
      }

      if (hunk.type === 'update_file') {
        sourcePath = normalizeConversationDocumentPath(hunk.path);
        const sourceIndex = findDocumentIndex(currentDocuments, sourcePath);
        if (sourceIndex < 0) {
          throw new Error(`Failed to read file to update ${sourcePath}`);
        }
        const sourceDocument = currentDocuments[sourceIndex];
        const nextContent = derivePatchedFileContent(sourceDocument.content, sourcePath, hunk.chunks);
        const targetPath = hunk.move_path
          ? normalizeConversationDocumentPath(hunk.move_path)
          : sourcePath;
        preparedOperations.push({
          type: 'update_file',
          source_path: sourcePath,
          target_path: targetPath,
          content: nextContent
        });
      }
    } catch (error) {
      throw normalizeApplyPatchVerificationError(error, {
        stage: 'verify',
        file_path: sourcePath || hunk?.path || '',
        hunk_index: hunkIndex + 1
      });
    }
  }

  const nextDocuments = normalizeDocumentRecords(currentDocuments);
  const affectedFiles = {
    added: [],
    modified: [],
    deleted: []
  };

  // 只有全部 hunk 验证成功后，才在内存中生成一次事务提交所需的完整集合。
  for (const operation of preparedOperations) {
    if (operation.type === 'add_file') {
      const existingIndex = findDocumentIndex(nextDocuments, operation.target_path);
      const nextRecord = normalizeDocumentRecord({
        path: operation.target_path,
        content: operation.content,
        updated_at: patchTime
      }, patchTime);
      if (existingIndex >= 0) {
        nextDocuments[existingIndex] = nextRecord;
      } else {
        nextDocuments.push(nextRecord);
      }
      if (operation.destination_existed) {
        affectedFiles.modified.push(operation.target_path);
      } else {
        affectedFiles.added.push(operation.target_path);
      }
      nextDocuments.sort((left, right) => left.path.localeCompare(right.path));
      continue;
    }

    if (operation.type === 'delete_file') {
      const sourceIndex = findDocumentIndex(nextDocuments, operation.source_path);
      if (sourceIndex < 0) {
        throw new Error(`Prepared apply_patch source disappeared before commit: ${operation.source_path}`);
      }
      nextDocuments.splice(sourceIndex, 1);
      affectedFiles.deleted.push(operation.source_path);
      continue;
    }

    const sourceIndex = findDocumentIndex(nextDocuments, operation.source_path);
    if (sourceIndex < 0) {
      throw new Error(`Prepared apply_patch source disappeared before commit: ${operation.source_path}`);
    }
    const nextRecord = normalizeDocumentRecord({
      path: operation.target_path,
      content: operation.content,
      updated_at: patchTime
    }, patchTime);
    if (operation.target_path === operation.source_path) {
      nextDocuments[sourceIndex] = nextRecord;
    } else {
      const targetIndex = findDocumentIndex(nextDocuments, operation.target_path);
      if (targetIndex >= 0) {
        nextDocuments[targetIndex] = nextRecord;
        nextDocuments.splice(sourceIndex, 1);
      } else {
        nextDocuments[sourceIndex] = nextRecord;
      }
    }
    nextDocuments.sort((left, right) => left.path.localeCompare(right.path));
    affectedFiles.modified.push(operation.target_path);
  }

  return {
    documents: nextDocuments,
    affected_files: {
      added: Array.from(new Set(affectedFiles.added)),
      modified: Array.from(new Set(affectedFiles.modified)),
      deleted: Array.from(new Set(affectedFiles.deleted))
    }
  };
}

function buildChangeEventPayload(conversationId, action, options = {}) {
  const updatedPaths = Array.isArray(options.updated_paths)
    ? Array.from(new Set(options.updated_paths.map((value) => {
        try {
          return normalizeConversationDocumentPath(value);
        } catch (_) {
          return normalizeString(value);
        }
      }).filter(Boolean)))
    : [];
  const deletedPaths = Array.isArray(options.deleted_paths)
    ? Array.from(new Set(options.deleted_paths.map((value) => {
        try {
          return normalizeConversationDocumentPath(value);
        } catch (_) {
          return normalizeString(value);
        }
      }).filter(Boolean)))
    : [];
  return {
    conversation_id: conversationId,
    action,
    updated_paths: updatedPaths,
    deleted_paths: deletedPaths
  };
}

function createDefaultConversationDocumentStore() {
  return {
    listDocuments: listConversationDocuments,
    getDocument: getConversationDocument,
    mutateDocuments: mutateConversationDocuments,
    putDocument: putConversationDocument
  };
}

function ensureStore(store = null) {
  const resolved = store || createDefaultConversationDocumentStore();
  const requiredMethods = ['listDocuments', 'getDocument', 'mutateDocuments', 'putDocument'];
  const missing = requiredMethods.filter((name) => typeof resolved?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`当前环境没有可用的 conversation file store，缺少方法：${missing.join(', ')}`);
  }
  return resolved;
}

function createDefaultLocalFileMountStore() {
  return {
    listMounts: listLocalFileMounts
  };
}

function ensureLocalMountStore(store = null) {
  const resolved = store || createDefaultLocalFileMountStore();
  const requiredMethods = ['listMounts'];
  const missing = requiredMethods.filter((name) => typeof resolved?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`当前环境没有可用的 local file mount store，缺少方法：${missing.join(', ')}`);
  }
  return resolved;
}

function buildReadFilePayload(documentRecord, readOptions) {
  const contentRead = buildVirtualTextReadResult(documentRecord.content, readOptions);
  return {
    path: documentRecord.path,
    updated_at: toIsoTimestamp(documentRecord.updated_at),
    size_chars: buildDocumentSizeChars(documentRecord.content),
    content: contentRead.content,
    content_read: contentRead
  };
}

function assertDifferentFileOperationPaths(sourcePath, destinationPath, action) {
  if (sourcePath === destinationPath) {
    throw new Error(`virtual_file 参数错误：${action} 的 from 与 to 不能相同。`);
  }
}

function findRequiredConversationDocument(documents, filePath, action) {
  const index = findDocumentIndex(documents, filePath);
  if (index < 0) {
    throw new Error(`virtual_file 参数错误：${action} 找不到文件 ${filePath}。`);
  }
  return {
    index,
    document: documents[index]
  };
}

async function getRequiredConversationDocumentByPath(store, conversationId, filePath) {
  const directRecord = await store.getDocument(conversationId, filePath);
  if (directRecord) {
    return normalizeDocumentRecord(directRecord);
  }
  const documents = normalizeDocumentRecords(await store.listDocuments(conversationId));
  return documents.find((doc) => doc.path === filePath) || null;
}

function buildFileOperationFilePayload(documentRecord) {
  return {
    path: documentRecord.path,
    updated_at: toIsoTimestamp(documentRecord.updated_at),
    size_chars: buildDocumentSizeChars(documentRecord.content)
  };
}

export function isVirtualFileToolAction(action) {
  return VIRTUAL_FILE_PUBLIC_ACTIONS.has(normalizeString(action).toLowerCase());
}

export function isConversationDocumentToolAction(action) {
  return isVirtualFileToolAction(action);
}

export function isConversationDocumentMutationAction(action) {
  const normalized = normalizeString(action).toLowerCase();
  return normalized === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME
    || normalized === VIRTUAL_FILE_COPY_FILE_TOOL_NAME
    || normalized === CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION;
}

/**
 * 生成 cp 语义下的新文档集合：目标不存在时新增，目标存在时原位覆盖。
 * 这里保持纯函数，调用方只在完整源文件读取成功后提交一次事务。
 */
function buildCopiedConversationDocumentSet(documents, copiedDocument) {
  const normalizedDocuments = normalizeDocumentRecords(documents);
  const destinationExisted = findDocumentIndex(normalizedDocuments, copiedDocument.path) >= 0;
  const nextDocuments = normalizedDocuments
    .filter((documentRecord) => documentRecord.path !== copiedDocument.path)
    .concat(copiedDocument)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    destinationExisted,
    nextDocuments
  };
}

export function normalizeVirtualFileToolArguments(action, rawArgs) {
  const normalizedAction = normalizeString(action).toLowerCase();
  if (!VIRTUAL_FILE_PUBLIC_ACTIONS.has(normalizedAction)) {
    throw new Error(`virtual_file 参数错误：不支持的 action \`${action}\`。`);
  }

  const allowedKeysByAction = {
    [VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME]: ['environment_id', 'patch'],
    [VIRTUAL_FILE_LIST_FILES_TOOL_NAME]: ['environment_id', 'path_glob'],
    [VIRTUAL_FILE_READ_FILE_TOOL_NAME]: ['environment_id', 'path', 'start_line', 'end_line'],
    [VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME]: [
      'environment_id',
      'pattern',
      'regex',
      'path_glob',
      'ignore_case',
      'context_lines'
    ],
    [VIRTUAL_FILE_COPY_FILE_TOOL_NAME]: ['environment_id', 'from', 'to']
  };
  const args = assertOnlyObjectKeys(
    rawArgs,
    allowedKeysByAction[normalizedAction],
    normalizedAction
  );

  const environment = normalizeVirtualFileEnvironmentId(args.environment_id);

  switch (normalizedAction) {
    case VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME: {
      const normalized = normalizeVirtualFileApplyPatchArguments(args, environment);
      if (environment.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT) {
        assertPatchDoesNotTouchLocalPaths(normalized.patch);
      }
      return normalized;
    }
    case VIRTUAL_FILE_LIST_FILES_TOOL_NAME:
      return normalizeVirtualFileListFilesArguments(args, environment);
    case VIRTUAL_FILE_READ_FILE_TOOL_NAME:
      return normalizeVirtualFileReadFileArguments(args, environment);
    case VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME:
      return normalizeVirtualFileSearchFilesArguments(args, environment);
    case VIRTUAL_FILE_COPY_FILE_TOOL_NAME:
      return normalizeVirtualFileCopyFileArguments(args, environment);
    default:
      throw new Error(`virtual_file 参数错误：未处理的 action \`${action}\`。`);
  }
}

export function buildConversationDocumentActionPayloadFromVirtualFileAction(action, normalizedArgs) {
  const input = assertPlainObject(normalizedArgs, 'normalized virtual_file arguments');
  switch (normalizeString(action).toLowerCase()) {
    case VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME:
      return { patch: input.patch || '' };
    case VIRTUAL_FILE_LIST_FILES_TOOL_NAME:
      return { path_glob: input.path_glob || null };
    case VIRTUAL_FILE_READ_FILE_TOOL_NAME:
      return {
        file_path: input.file_path,
        ...(assertPlainObject(input.read_options, 'read_file read_options'))
      };
    case VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME:
      return {
        pattern: input.pattern,
        regex: input.regex === true,
        ignore_case: input.ignore_case === true,
        path_glob: input.path_glob || null,
        context_lines: input.context_lines
      };
    case VIRTUAL_FILE_COPY_FILE_TOOL_NAME:
      return {
        source_path: input.source_path,
        destination_path: input.destination_path
      };
    default:
      throw new Error(`virtual_file 参数错误：未处理的会话文件 action \`${action}\`。`);
  }
}

export function buildSkillVirtualFileActionPayload(action, normalizedArgs) {
  const input = assertPlainObject(normalizedArgs, 'normalized virtual_file arguments');
  const environment = assertPlainObject(input.environment, 'virtual_file environment');
  if (environment.kind !== VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL || !environment.environment_id) {
    throw new Error('virtual_file 参数错误：Skill 文件动作缺少 skill environment_id。');
  }
  const payload = { environment_id: environment.environment_id };
  switch (normalizeString(action).toLowerCase()) {
    case VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME:
      return {
        action: 'apply_patch',
        ...payload,
        patch: input.patch || '',
        runtime_contract: buildApplyPatchRuntimeContractPayload()
      };
    case VIRTUAL_FILE_LIST_FILES_TOOL_NAME:
      return {
        action: 'list_files',
        ...payload,
        path_glob: input.path_glob || null
      };
    case VIRTUAL_FILE_READ_FILE_TOOL_NAME:
      return {
        action: 'read_file',
        ...payload,
        file_path: input.file_path,
        ...(assertPlainObject(input.read_options, 'read_file read_options'))
      };
    case VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME:
      return {
        action: 'search_files',
        ...payload,
        pattern: input.pattern,
        regex: input.regex === true,
        ignore_case: input.ignore_case === true,
        path_glob: input.path_glob || null,
        context_lines: input.context_lines
      };
    case VIRTUAL_FILE_COPY_FILE_TOOL_NAME:
      return {
        action: 'copy_file',
        ...payload,
        source_path: input.source_path,
        destination_path: input.destination_path
      };
    default:
      throw new Error(`virtual_file 参数错误：未处理的 skill action \`${action}\`。`);
  }
}

function normalizeActionArgs(action, rawArgs, options = {}) {
  const allowInternalActions = options?.allowInternalActions === true;
  const normalizedAction = normalizeString(action).toLowerCase();
  if (!VIRTUAL_FILE_PUBLIC_ACTIONS.has(normalizedAction) && !(allowInternalActions && VIRTUAL_FILE_INTERNAL_ACTIONS.has(normalizedAction))) {
    throw new Error(`virtual_file 参数错误：不支持的 action \`${action}\`。`);
  }

  const allowedKeysByAction = {
    [CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME]: ['patch'],
    [CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME]: ['path_glob'],
    [CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME]: ['file_path', 'start_line', 'end_line'],
    [CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME]: [
      'pattern',
      'regex',
      'ignore_case',
      'path_glob',
      'context_lines'
    ],
    [CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME]: ['source_path', 'destination_path'],
    [CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION]: ['file_path'],
    [CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION]: ['file_path', 'content']
  };
  const args = assertOnlyObjectKeys(
    rawArgs,
    allowedKeysByAction[normalizedAction],
    normalizedAction
  );

  switch (normalizedAction) {
    case CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME:
      if (!normalizeString(args.patch)) {
        throw new Error('virtual_file 参数错误：apply_patch 需要 patch。');
      }
      return {
        action: normalizedAction,
        patch: String(args.patch || '')
      };
    case CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME:
      return {
        action: normalizedAction,
        path_glob: normalizeVirtualPathFilter(args.path_glob, { label: 'path_glob' })
      };
    case CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME:
      return {
        action: normalizedAction,
        file_path: normalizeConversationDocumentPath(args.file_path),
        read_options: normalizeVirtualFileLineRange(args)
      };
    case CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME:
      if (!normalizeString(args.pattern)) {
        throw new Error('virtual_file 参数错误：search_files 需要 pattern。');
      }
      if (args.regex != null && typeof args.regex !== 'boolean') {
        throw new Error('virtual_file 参数错误：regex 必须是 boolean 或 null。');
      }
      if (args.ignore_case != null && typeof args.ignore_case !== 'boolean') {
        throw new Error('virtual_file 参数错误：ignore_case 必须是 boolean 或 null。');
      }
      return {
        action: normalizedAction,
        pattern: normalizeString(args.pattern),
        regex: args.regex === true,
        ignore_case: args.ignore_case === true,
        path_glob: normalizeVirtualPathFilter(args.path_glob, { label: 'path_glob' }),
        context_lines: readNullableSafeInteger(args.context_lines, {
          label: 'context_lines',
          minimum: 0,
          maximum: 20
        }) ?? 0
      };
    case CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME:
      return {
        action: normalizedAction,
        source_path: normalizeConversationDocumentPath(args.source_path),
        destination_path: normalizeConversationDocumentPath(args.destination_path)
      };
    case CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION:
      return {
        action: normalizedAction,
        file_path: normalizeConversationDocumentPath(args.file_path)
      };
    case CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION:
      if (typeof args.content !== 'string') {
        throw new Error('virtual_file 参数错误：write_file.content 必须是字符串。');
      }
      return {
        action: normalizedAction,
        file_path: normalizeConversationDocumentPath(args.file_path),
        content: args.content
      };
    default:
      throw new Error(`virtual_file 参数错误：未处理的 action \`${action}\`。`);
  }
}

export async function executeConversationDocumentAction(action, rawArgs, options = {}) {
  const normalizedAction = normalizeString(action).toLowerCase();
  const normalizedArgs = normalizeActionArgs(normalizedAction, rawArgs, {
    allowInternalActions: options?.allowInternalActions === true
  });
  const conversationId = normalizeConversationId(options?.conversationId);
  const store = ensureStore(options?.store || null);
  const localMountStore = ensureLocalMountStore(options?.localMountStore || null);

  switch (normalizedAction) {
    case CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME: {
      if (isLocalVirtualPath(normalizedArgs.path_glob)) {
        const shouldRefilterWithGlob = hasVirtualPathGlobSyntax(normalizedArgs.path_glob);
        const localDocuments = await listLocalVirtualFileDocuments(conversationId, {
          path_glob: normalizedArgs.path_glob,
          store: localMountStore
        });
        const manifest = buildDocumentManifest(localDocuments, {
          path_glob: shouldRefilterWithGlob ? normalizedArgs.path_glob : null
        });
        return {
          ok: true,
          action: normalizedAction,
          conversation_id: conversationId,
          source: VIRTUAL_FILE_ENVIRONMENT_KIND_LOCAL,
          ...manifest,
          path_glob: normalizedArgs.path_glob
        };
      }
      const documents = await store.listDocuments(conversationId);
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        ...buildDocumentManifest(documents, {
          path_glob: normalizedArgs.path_glob
        })
      };
    }
    case CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME: {
      if (isLocalVirtualPath(normalizedArgs.file_path)) {
        const localDocumentRecord = await readLocalVirtualFileDocument(
          conversationId,
          normalizedArgs.file_path,
          localMountStore
        );
        return {
          ok: true,
          action: normalizedAction,
          conversation_id: conversationId,
          source: VIRTUAL_FILE_ENVIRONMENT_KIND_LOCAL,
          file: buildReadFilePayload(localDocumentRecord, normalizedArgs.read_options)
        };
      }
      const documentRecord = await getRequiredConversationDocumentByPath(
        store,
        conversationId,
        normalizedArgs.file_path
      );
      if (!documentRecord) {
        throw new Error(`当前对话中不存在文件 ${normalizedArgs.file_path}。`);
      }
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        file: buildReadFilePayload(documentRecord, normalizedArgs.read_options)
      };
    }
    case CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION: {
      if (isLocalVirtualPath(normalizedArgs.file_path)) {
        try {
          const localDocumentRecord = await readLocalVirtualFileDocument(
            conversationId,
            normalizedArgs.file_path,
            localMountStore
          );
          return {
            ok: true,
            action: normalizedAction,
            conversation_id: conversationId,
            source: VIRTUAL_FILE_ENVIRONMENT_KIND_LOCAL,
            file: {
              path: localDocumentRecord.path,
              updated_at: toIsoTimestamp(localDocumentRecord.updated_at),
              size_chars: buildDocumentSizeChars(localDocumentRecord.content),
              content: localDocumentRecord.content
            }
          };
        } catch (error) {
          return {
            ok: false,
            action: normalizedAction,
            conversation_id: conversationId,
            missing: true,
            file_path: normalizedArgs.file_path,
            error: {
              message: error?.message || String(error || ''),
              name: error?.name || 'LocalMountReadError',
              stack: error?.stack || ''
            }
          };
        }
      }
      const documentRecord = await getRequiredConversationDocumentByPath(
        store,
        conversationId,
        normalizedArgs.file_path
      );
      if (!documentRecord) {
        return {
          ok: false,
          action: normalizedAction,
          conversation_id: conversationId,
          missing: true,
          file_path: normalizedArgs.file_path
        };
      }
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        file: {
          path: documentRecord.path,
          updated_at: toIsoTimestamp(documentRecord.updated_at),
          size_chars: buildDocumentSizeChars(documentRecord.content),
          content: documentRecord.content
        }
      };
    }
    case CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME: {
      if (isLocalVirtualPath(normalizedArgs.path_glob)) {
        const shouldRefilterWithGlob = hasVirtualPathGlobSyntax(normalizedArgs.path_glob);
        const localDocuments = await listLocalVirtualFileDocuments(conversationId, {
          path_glob: normalizedArgs.path_glob,
          includeContent: true,
          store: localMountStore
        });
        return {
          ok: true,
          action: normalizedAction,
          conversation_id: conversationId,
          source: VIRTUAL_FILE_ENVIRONMENT_KIND_LOCAL,
          ...searchVirtualTextDocuments(localDocuments, {
            ...normalizedArgs,
            path_glob: shouldRefilterWithGlob ? normalizedArgs.path_glob : null
          }),
          path_glob: normalizedArgs.path_glob
        };
      }
      const documents = await store.listDocuments(conversationId);
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        ...searchVirtualTextDocuments(normalizeDocumentRecords(documents), normalizedArgs)
      };
    }
    case CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME: {
      assertDifferentFileOperationPaths(normalizedArgs.source_path, normalizedArgs.destination_path, 'copy_file');
      assertWritableRootPath(normalizedArgs.destination_path, 'copy_file');
      const localSourceDocument = isLocalVirtualPath(normalizedArgs.source_path)
        ? await readLocalVirtualFileDocument(
          conversationId,
          normalizedArgs.source_path,
          localMountStore
        )
        : null;
      const mutation = await store.mutateDocuments(conversationId, (currentDocuments) => {
        const existingDocuments = normalizeDocumentRecords(currentDocuments);
        const sourceDocument = localSourceDocument || findRequiredConversationDocument(
          existingDocuments,
          normalizedArgs.source_path,
          'copy_file'
        ).document;
        const now = new Date().toISOString();
        const copiedDocument = normalizeDocumentRecord({
          path: normalizedArgs.destination_path,
          content: sourceDocument.content,
          updated_at: now
        }, now);
        const { destinationExisted, nextDocuments } = buildCopiedConversationDocumentSet(
          existingDocuments,
          copiedDocument
        );
        return {
          documents: nextDocuments,
          value: { destinationExisted, copiedDocument }
        };
      });
      const persistedDocuments = mutation.documents;
      const { destinationExisted, copiedDocument } = mutation.value;
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        source_path: normalizedArgs.source_path,
        destination_path: copiedDocument.path,
        file: buildFileOperationFilePayload(copiedDocument),
        files: buildDocumentManifest(persistedDocuments),
        affected_files: {
          added: destinationExisted ? [] : [copiedDocument.path],
          modified: destinationExisted ? [copiedDocument.path] : [],
          deleted: []
        },
        change_event: buildChangeEventPayload(conversationId, normalizedAction, {
          updated_paths: [copiedDocument.path]
        })
      };
    }
    case CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION: {
      assertWritableRootPath(normalizedArgs.file_path, 'write_file');
      const nextRecord = await store.putDocument(conversationId, {
        path: normalizedArgs.file_path,
        content: normalizedArgs.content,
        updated_at: new Date().toISOString(),
        size_chars: buildDocumentSizeChars(normalizedArgs.content)
      });
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        file: {
          path: nextRecord.path,
          updated_at: nextRecord.updated_at,
          size_chars: nextRecord.size_chars,
          content: nextRecord.content
        },
        change_event: buildChangeEventPayload(conversationId, normalizedAction, {
          updated_paths: [nextRecord.path]
        })
      };
    }
    case CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME: {
      assertPatchDoesNotTouchLocalPaths(normalizedArgs.patch);
      const mutation = await store.mutateDocuments(conversationId, (existingDocuments) => {
        const patched = applyConversationDocumentPatch(existingDocuments, normalizedArgs.patch);
        return {
          documents: patched.documents,
          value: { affected_files: patched.affected_files }
        };
      });
      const persistedDocuments = mutation.documents;
      const affectedFiles = mutation.value.affected_files;
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        files: buildDocumentManifest(persistedDocuments),
        affected_files: affectedFiles,
        change_event: buildChangeEventPayload(conversationId, normalizedAction, {
          updated_paths: [
            ...affectedFiles.added,
            ...affectedFiles.modified
          ],
          deleted_paths: affectedFiles.deleted
        })
      };
    }
    default:
      throw new Error(`virtual_file 参数错误：未处理的 action \`${action}\`。`);
  }
}

export function normalizeVirtualFileResultFromSkillAction(action, rawResult, normalizedArgs) {
  const normalizedAction = normalizeString(action).toLowerCase();
  const result = assertPlainObject(rawResult, 'Skill virtual_file result');
  return {
    ...result,
    action: normalizedAction,
    environment: summarizeVirtualFileEnvironment(normalizedArgs?.environment)
  };
}
