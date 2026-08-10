import { parseApplyPatchProgress } from '../agent_tools/shared/apply_patch_core.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseLegacyArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) return null;
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function resolveCustomEnvironmentTarget(environmentId) {
  const normalized = normalizeText(environmentId);
  if (!normalized) return { targetKind: 'root', skillName: '' };
  if (!normalized.startsWith('skill:')) {
    return { targetKind: 'unknown', skillName: '', environmentId: normalized };
  }
  return {
    targetKind: 'skill',
    skillName: normalizeText(normalized.slice('skill:'.length)),
    environmentId: normalized
  };
}

function resolveLegacyTarget(args) {
  const target = args?.target && typeof args.target === 'object' && !Array.isArray(args.target)
    ? args.target
    : null;
  const requestedKind = normalizeText(target?.kind).toLowerCase();
  const targetKind = requestedKind === 'skill' ? 'skill' : 'root';
  return {
    targetKind,
    skillName: targetKind === 'skill' ? normalizeText(target?.name) : ''
  };
}

function normalizePreviewLine(line) {
  const type = normalizeText(line?.type).toLowerCase();
  const kind = type === 'move' || type === 'eof' ? 'meta' : (type || 'context');
  return {
    kind,
    text: type === 'move' ? `Move to: ${line?.content || ''}` : (line?.content || ''),
    lineNumber: Number.isFinite(Number(line?.line_number)) ? Number(line.line_number) : null,
    sequence: Number.isFinite(Number(line?.sequence)) ? Number(line.sequence) : 0
  };
}

function buildPreview(rawPatch, target, options = {}) {
  if (typeof rawPatch !== 'string' || !rawPatch.trim()) return null;
  const progress = parseApplyPatchProgress(rawPatch, { finish: options.final === true });
  const files = progress.files.map((file, fileIndex) => {
    const lines = file.lines.map(normalizePreviewLine);
    return {
      operation: file.operation,
      path: file.path,
      movePath: file.moveTo || '',
      additions: lines.filter(line => line.kind === 'add').length,
      deletions: lines.filter(line => line.kind === 'delete').length,
      lines,
      fileIndex
    };
  });
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    files,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    patchComplete: progress.complete && !progress.error,
    isPartial: !progress.complete && !progress.error,
    parseError: progress.error,
    environmentId: progress.environment_id || target.environmentId || '',
    targetKind: target.targetKind,
    skillName: target.skillName || '',
    pendingLine: progress.pending_line || ''
  };
}

/**
 * 旧 `skill_registry(action=apply_patch)` 仅用于已完成历史的回放。
 * 新请求不会再用未闭合 JSON 承载 patch，因此这里明确只接受完整 JSON/对象，
 * 不保留第二套“猜测未闭合 JSON 字符串”的解析器。
 */
export function buildSkillApplyPatchPreview(rawArguments, options = {}) {
  const args = parseLegacyArguments(rawArguments);
  if (!args || normalizeText(args.action).toLowerCase() !== 'apply_patch') return null;
  return buildPreview(args.patch, {
    targetKind: 'skill',
    skillName: normalizeText(args.skill_name || args.name)
  }, { ...options, final: options.final !== false });
}

/**
 * 顶层 apply_patch 同时支持：
 * - 新 `custom_tool_call.input` 的 raw patch；
 * - 历史中已经完成的旧 function_call JSON 参数。
 */
export function buildVirtualFileApplyPatchPreview(rawInput, options = {}) {
  const legacyArgs = parseLegacyArguments(rawInput);
  if (legacyArgs) {
    return buildPreview(
      legacyArgs.patch,
      resolveLegacyTarget(legacyArgs),
      { ...options, final: options.final !== false }
    );
  }
  if (typeof rawInput !== 'string') return null;
  const progress = parseApplyPatchProgress(rawInput, { finish: false });
  return buildPreview(
    rawInput,
    resolveCustomEnvironmentTarget(progress.environment_id),
    options
  );
}
