import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT,
  VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL
} from '../agent_tools/virtual_file_io/index.js';
import { buildVirtualFileApplyPatchPreview } from './skill_patch_preview.js';

// 这些名称只用于展示已经落库的历史调用，不会进入当前工具定义或执行路由。
const HISTORICAL_MOVE_FILE_TOOL_NAME = 'move_file';
const HISTORICAL_DELETE_FILE_TOOL_NAME = 'delete_file';

function normalizeSummaryText(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function parseArgumentsObject(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  const text = normalizeSummaryText(rawArguments);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function collectOutputTextParts(value, parts = []) {
  if (value == null) return parts;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return parts;
    try {
      const parsed = JSON.parse(text);
      if (parsed !== value) {
        collectOutputTextParts(parsed, parts);
        return parts;
      }
    } catch (_) {}
    parts.push(text);
    return parts;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectOutputTextParts(item, parts));
    return parts;
  }
  if (typeof value === 'object') {
    if (typeof value.ok === 'boolean') {
      parts.push(`ok: ${value.ok ? 'true' : 'false'}`);
    }
    for (const key of ['text', 'output_text', 'content', 'value', 'error']) {
      if (typeof value[key] === 'string' && value[key].trim()) {
        parts.push(value[key].trim());
      }
    }
  }
  return parts;
}

function collectOutputText(value) {
  return collectOutputTextParts(value)
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join('\n');
}

function isApplyPatchToolName(toolName) {
  return normalizeSummaryText(toolName) === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME;
}

function resolvePreviewDocumentPath(file, target) {
  if (!file || typeof file !== 'object') return '';
  if (String(file.operation || '').trim().toLowerCase() === 'delete') return '';
  return normalizeSummaryPathForTarget(file.movePath || file.path, target);
}

export function isSuccessfulConversationDocumentApplyPatchOutput(rawOutput) {
  const text = collectOutputText(rawOutput);
  if (!text) return false;
  if (/^\s*Error:/im.test(text)) return false;
  if (/\bPatch failed\b/i.test(text)) return false;
  if (/\b["']?ok["']?\s*[:=]\s*false\b/i.test(text)) return false;
  return /^\s*Success\./im.test(text)
    || /^\s*Patch applied successfully\./im.test(text)
    || /\b["']?ok["']?\s*[:=]\s*true\b/i.test(text);
}

function joinSummaryMeta(parts) {
  return parts
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' · ');
}

function resolvePathArg(args) {
  return normalizeSummaryText(args?.path);
}

function resolveGlobArg(args) {
  return normalizeSummaryText(args?.path_glob || args?.glob);
}

function resolveSearchPatternArg(args) {
  return normalizeSummaryText(args?.pattern);
}

function resolveFromArg(args) {
  return normalizeSummaryText(args?.from);
}

function resolveToArg(args) {
  return normalizeSummaryText(args?.to);
}

function formatPosixShellWord(value) {
  const text = normalizeSummaryText(value);
  if (!text) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function normalizeSummaryPathForTarget(path, target) {
  return normalizeSummaryText(path).replace(/\\/g, '/');
}

function resolveVirtualFileTarget(args) {
  const environmentId = normalizeSummaryText(args?.environment_id);
  if (environmentId.startsWith('skill:')) {
    return {
      kind: VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL,
      name: environmentId.slice('skill:'.length)
    };
  }
  const target = (args?.target && typeof args.target === 'object' && !Array.isArray(args.target))
    ? args.target
    : null;
  const kind = normalizeSummaryText(target?.kind).toLowerCase() || VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT;
  return {
    kind: kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL : VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT,
    name: normalizeSummaryText(target?.name)
  };
}

function formatReadLineRangeSuffix(args) {
  if (args?.start_line == null || args?.end_line == null) {
    const lineRange = normalizeSummaryText(args?.line_range);
    if (!lineRange) return '';
    const compact = lineRange
      .replace(/^['"]|['"]$/g, '')
      .replace(/\s+/g, '')
      .replace(/p$/i, '');
    const rangeMatch = compact.match(/^L?(\d+)(?:[:-]|,)L?(\d+)$/i);
    if (rangeMatch) return `L${rangeMatch[1]}-L${rangeMatch[2]}`;
    const singleMatch = compact.match(/^L?(\d+)$/i);
    if (singleMatch) return `L${singleMatch[1]}`;
    return compact ? (compact.startsWith('L') ? compact : `L${compact}`) : '';
  }
  const startLine = Number(args?.start_line);
  const endLine = Number(args?.end_line);
  if (
    Number.isSafeInteger(startLine)
    && Number.isSafeInteger(endLine)
    && startLine >= 1
    && endLine >= startLine
  ) {
    return `L${startLine}-L${endLine}`;
  }
  return '';
}

export function isVirtualFileToolCall(record) {
  const type = String(record?.type || '').toLowerCase();
  const name = normalizeSummaryText(record?.name);
  if (type === 'custom_tool_call') return name === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME;
  return type === 'function_call'
    && [
      VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
      VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
      VIRTUAL_FILE_READ_FILE_TOOL_NAME,
      VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
      VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
      HISTORICAL_MOVE_FILE_TOOL_NAME,
      HISTORICAL_DELETE_FILE_TOOL_NAME
    ].includes(name);
}

export function getVirtualFileToolTypeLabel(record) {
  return isVirtualFileToolCall(record) ? '文件' : '';
}

export function buildVirtualFileSummaryParts(record, options = {}) {
  if (!isVirtualFileToolCall(record)) return null;
  const toolName = normalizeSummaryText(record?.name);
  const args = parseArgumentsObject(record?.arguments);
  const preview = toolName === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME
    ? buildVirtualFileApplyPatchPreview(
      String(record?.type || '').toLowerCase() === 'custom_tool_call' ? record?.input : args,
      { final: options?.isInProgress !== true }
    )
    : null;
  const target = preview
    ? { kind: preview.targetKind, name: preview.skillName }
    : resolveVirtualFileTarget(args);
  const isInProgress = options?.isInProgress === true;
  const targetMeta = target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? target.name : '';
  const lineRangeSuffix = formatReadLineRangeSuffix(args);

  if (toolName === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME) {
    if (preview?.files?.length) {
      const firstFile = preview.files[0];
      const metaParts = [];
      if (targetMeta) metaParts.push(targetMeta);
      if (preview.totalAdditions > 0) metaParts.push(`+${preview.totalAdditions}`);
      if (preview.totalDeletions > 0) metaParts.push(`-${preview.totalDeletions}`);
      if (preview.totalFiles > 1) metaParts.push(`另 ${preview.totalFiles - 1} 个文件`);
      return {
        action: isInProgress ? '正在修改' : '修改',
        value: normalizeSummaryPathForTarget(firstFile?.path, target) || (target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? '技能文件' : '根目录'),
        valueUrl: '',
        meta: joinSummaryMeta(metaParts),
        locationAction: '',
        locationValue: '',
        locationUrl: ''
      };
    }
    return {
      action: isInProgress ? '正在修改' : '修改',
      value: target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? (targetMeta || '技能文件') : '根目录',
      valueUrl: '',
      meta: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_LIST_FILES_TOOL_NAME) {
    const glob = resolveGlobArg(args);
    return {
      action: isInProgress ? '正在查看列表' : '查看列表',
      value: target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? (targetMeta || '全部技能') : (normalizeSummaryPathForTarget(glob, target) || '根目录'),
      valueUrl: '',
      meta: target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? glob : '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_READ_FILE_TOOL_NAME) {
    return {
      action: isInProgress ? '正在读取' : '读取',
      value: [
        normalizeSummaryPathForTarget(resolvePathArg(args), target) || (target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? '技能文件' : '根目录'),
        lineRangeSuffix
      ]
        .filter(Boolean)
        .join(' '),
      valueUrl: '',
      meta: targetMeta,
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME) {
    const pattern = resolveSearchPatternArg(args);
    return {
      action: isInProgress ? '正在搜索' : '搜索',
      value: pattern || (target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? '技能文件' : '根目录'),
      valueUrl: '',
      meta: joinSummaryMeta([targetMeta, normalizeSummaryPathForTarget(resolveGlobArg(args), target)]),
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_COPY_FILE_TOOL_NAME) {
    const from = resolveFromArg(args);
    const to = resolveToArg(args);
    const normalizedFrom = normalizeSummaryPathForTarget(from, target);
    const normalizedTo = normalizeSummaryPathForTarget(to, target);
    return {
      action: isInProgress ? '正在运行' : '运行',
      value: normalizedFrom && normalizedTo
        ? `cp -- ${formatPosixShellWord(normalizedFrom)} ${formatPosixShellWord(normalizedTo)}`
        : 'cp',
      valueUrl: '',
      meta: targetMeta,
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  // 旧历史里的独立 move_file 仍可回放；新请求不再注册该工具。
  if (toolName === HISTORICAL_MOVE_FILE_TOOL_NAME) {
    const from = resolveFromArg(args);
    const to = resolveToArg(args);
    return {
      action: isInProgress ? '正在移动' : '移动',
      value: from && to
        ? `${normalizeSummaryPathForTarget(from, target)} -> ${normalizeSummaryPathForTarget(to, target)}`
        : (normalizeSummaryPathForTarget(from || to, target) || '文件'),
      valueUrl: '',
      meta: targetMeta,
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === HISTORICAL_DELETE_FILE_TOOL_NAME) {
    return {
      action: isInProgress ? '正在删除' : '删除',
      value: normalizeSummaryPathForTarget(resolvePathArg(args), target) || (target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL ? '技能文件' : '根目录'),
      valueUrl: '',
      meta: targetMeta,
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  return null;
}

export function buildVirtualFilePrimaryText(record, options = {}) {
  const parts = buildVirtualFileSummaryParts(record, options);
  if (!parts) return '';
  return [parts.action, parts.value, parts.meta]
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' ');
}

export function buildConversationDocumentApplyPatchPreviewDescriptors(record, options = {}) {
  if (!isVirtualFileToolCall(record)) return [];
  if (!isApplyPatchToolName(record?.name)) return [];
  if (
    options?.requireSuccessfulOutput === true
    && !isSuccessfulConversationDocumentApplyPatchOutput(record?.output)
  ) {
    return [];
  }

  const isCustom = String(record?.type || '').toLowerCase() === 'custom_tool_call';
  const args = parseArgumentsObject(record?.arguments);
  const preview = buildVirtualFileApplyPatchPreview(isCustom ? record?.input : args, { final: true });
  const target = preview
    ? { kind: preview.targetKind, name: preview.skillName }
    : resolveVirtualFileTarget(args);
  if (target.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL) return [];

  const files = Array.isArray(preview?.files) ? preview.files : [];
  if (files.length <= 0) return [];

  const descriptors = [];
  const seenPaths = new Set();
  files.forEach((file) => {
    const path = resolvePreviewDocumentPath(file, target);
    if (!path || seenPaths.has(path)) return;
    seenPaths.add(path);
    descriptors.push({
      path,
      title: path,
      operation: file.operation || 'update'
    });
  });
  return descriptors;
}

export function isConversationDocumentToolCall(record) {
  return isVirtualFileToolCall(record);
}

export function getConversationDocumentToolTypeLabel(record) {
  return getVirtualFileToolTypeLabel(record);
}

export function buildConversationDocumentSummaryParts(record, options = {}) {
  return buildVirtualFileSummaryParts(record, options);
}

export function buildConversationDocumentPrimaryText(record, options = {}) {
  return buildVirtualFilePrimaryText(record, options);
}
