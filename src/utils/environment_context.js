/**
 * @file 生成只包含运行环境事实的隐藏 environment_context。
 *
 * 设计目标：
 * - 只承载当前日期、时区、实际上传文件和实际 local mount 等事实；
 * - 工具是否存在完全由本轮 request.tools 决定，禁止在这里解释某个工具存在或不存在；
 * - 作为独立隐藏 contextual item 挂到用户消息之前，不污染用户正文；
 * - 采用“日期或事实清单变化时才追加”的策略，避免重复写入相同事实。
 */

// 结构发生语义变化时提升版本；本版本明确禁止携带任何工具能力或操作策略。
const ENVIRONMENT_CONTEXT_POLICY_REVISION = 'facts-only-v3';

/**
 * 规范化 IANA 时区名；若不可用则回退到 Etc/UTC。
 *
 * @param {string|null|undefined} timezone
 * @returns {string}
 */
export function normalizeEnvironmentTimezone(timezone) {
  if (typeof timezone === 'string' && timezone.trim()) {
    return timezone.trim();
  }
  return 'Etc/UTC';
}

/**
 * 读取当前运行环境的 IANA 时区。
 *
 * @returns {string}
 */
export function detectEnvironmentTimezone() {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    return normalizeEnvironmentTimezone(resolved?.timeZone);
  } catch (_) {
    return 'Etc/UTC';
  }
}

/**
 * 按指定时区把时间格式化为 YYYY-MM-DD。
 *
 * @param {string} timezone
 * @param {number|Date|null|undefined} now
 * @returns {string}
 */
export function formatEnvironmentCurrentDate(timezone, now = null) {
  const tz = normalizeEnvironmentTimezone(timezone);
  let date = null;
  if (now instanceof Date) {
    date = now;
  } else if (typeof now === 'number' && Number.isFinite(now)) {
    date = new Date(now);
  } else if (typeof now === 'string' && now.trim() !== '' && Number.isFinite(Number(now))) {
    date = new Date(Number(now));
  } else {
    date = new Date();
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((item) => item.type === 'year')?.value || '1970';
    const month = parts.find((item) => item.type === 'month')?.value || '01';
    const day = parts.find((item) => item.type === 'day')?.value || '01';
    return `${year}-${month}-${day}`;
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeUploadedFileEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const path = typeof entry.path === 'string' ? entry.path.trim() : '';
  if (!path) return null;
  const sourceName = typeof entry.source_name === 'string' ? entry.source_name.trim() : '';
  const uploadEventId = typeof entry.upload_event_id === 'string' ? entry.upload_event_id.trim() : '';
  return {
    path,
    source_name: sourceName,
    file_name_was_missing: entry.file_name_was_missing === true,
    upload_event_id: uploadEventId
  };
}

function normalizeUploadedFiles(entries) {
  if (!Array.isArray(entries)) return [];
  const normalized = [];
  const seenKeys = new Set();
  entries.forEach((entry, index) => {
    const next = normalizeUploadedFileEntry(entry);
    if (!next) return;
    const dedupeKey = next.upload_event_id || `${next.path}::${next.source_name}::${next.file_name_was_missing ? '1' : '0'}::${index}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    normalized.push(next);
  });
  return normalized;
}

function normalizeLocalMountEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const path = typeof entry.path === 'string' ? entry.path.trim() : '';
  if (!path) return null;
  const kindText = typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : '';
  const kind = kindText === 'directory' ? 'directory' : 'file';
  const sourceName = typeof entry.source_name === 'string' ? entry.source_name.trim() : '';
  const mountEventId = typeof entry.mount_event_id === 'string' ? entry.mount_event_id.trim() : '';
  return {
    path,
    kind,
    source_name: sourceName,
    mount_event_id: mountEventId
  };
}

function normalizeLocalMounts(entries) {
  if (!Array.isArray(entries)) return [];
  const normalized = [];
  const seenKeys = new Set();
  entries.forEach((entry, index) => {
    const next = normalizeLocalMountEntry(entry);
    if (!next) return;
    const dedupeKey = next.mount_event_id || `${next.path}::${next.kind}::${next.source_name}::${index}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    normalized.push(next);
  });
  return normalized;
}

/**
 * 构造隐藏 environment_context 负载。
 *
 * @param {{
 *   timezone?: string|null,
 *   currentDate?: string|null,
 *   now?: number|Date|null,
 *   uploadedFiles?: Array<Object>|null,
 *   localMounts?: Array<Object>|null
 * }} [options]
 * @returns {{type:'environment_context', current_date:string, timezone:string, uploaded_files?:Array<Object>, local_mounts?:Array<Object>}}
 */
export function buildEnvironmentContextPayload(options = {}) {
  const timezone = normalizeEnvironmentTimezone(options?.timezone || detectEnvironmentTimezone());
  const currentDate = (typeof options?.currentDate === 'string' && options.currentDate.trim())
    ? options.currentDate.trim()
    : formatEnvironmentCurrentDate(timezone, options?.now);
  const uploadedFiles = normalizeUploadedFiles(options?.uploadedFiles);
  const localMounts = normalizeLocalMounts(options?.localMounts);

  const payload = {
    type: 'environment_context',
    current_date: currentDate,
    timezone
  };
  if (uploadedFiles.length > 0) {
    payload.uploaded_files = uploadedFiles;
  }
  if (localMounts.length > 0) {
    payload.local_mounts = localMounts;
  }
  return payload;
}

/**
 * 生成稳定签名，供“仅在变化时追加”判断使用。
 *
 * @param {Object|null|undefined} payload
 * @returns {string}
 */
export function buildEnvironmentContextSignature(payload) {
  if (!payload || typeof payload !== 'object') return '';
  try {
    return JSON.stringify({
      policy_revision: ENVIRONMENT_CONTEXT_POLICY_REVISION,
      payload
    });
  } catch (_) {
    return '';
  }
}

/**
 * 把隐藏 environment_context 负载转换为可直接插入 Responses input 的 item。
 *
 * @param {Object|null|undefined} payload
 * @returns {Array<Object>}
 */
export function buildEnvironmentContextInputItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const currentDate = (typeof payload.current_date === 'string') ? payload.current_date.trim() : '';
  const timezone = (typeof payload.timezone === 'string') ? payload.timezone.trim() : '';
  if (!currentDate || !timezone) return [];
  const uploadedFiles = normalizeUploadedFiles(payload.uploaded_files);
  const localMounts = normalizeLocalMounts(payload.local_mounts);
  const lines = [
    '<environment_context>',
    `  <current_date>${escapeXmlText(currentDate)}</current_date>`,
    `  <timezone>${escapeXmlText(timezone)}</timezone>`
  ];
  if (uploadedFiles.length > 0) {
    lines.push('  <user_uploaded_files>');
    uploadedFiles.forEach((file) => {
      lines.push('    <file>');
      lines.push(`      <path>${escapeXmlText(file.path)}</path>`);
      if (file.source_name) {
        lines.push(`      <source_name>${escapeXmlText(file.source_name)}</source_name>`);
      }
      lines.push(`      <file_name_was_missing>${file.file_name_was_missing ? 'true' : 'false'}</file_name_was_missing>`);
      lines.push('    </file>');
    });
    lines.push('  </user_uploaded_files>');
  }
  if (localMounts.length > 0) {
    lines.push('  <local_file_mounts>');
    localMounts.forEach((mount) => {
      lines.push('    <mount>');
      lines.push(`      <path>${escapeXmlText(mount.path)}</path>`);
      lines.push(`      <kind>${escapeXmlText(mount.kind)}</kind>`);
      if (mount.source_name) {
        lines.push(`      <source_name>${escapeXmlText(mount.source_name)}</source_name>`);
      }
      lines.push('      <read_only>true</read_only>');
      lines.push('    </mount>');
    });
    lines.push('  </local_file_mounts>');
  }
  lines.push('</environment_context>');
  const text = lines.join('\n');

  return [{
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text
      }
    ]
  }];
}

/**
 * 根据上一条已生效签名，决定是否真正为本轮追加 environment_context。
 *
 * @param {{
 *   payload?: Object|null,
 *   previousEffectiveSignature?: string|null
 * }} [options]
 * @returns {{signature:string|null, inputItems:Array<Object>|null}}
 */
export function resolveEnvironmentContextAttachment(options = {}) {
  const payload = (options?.payload && typeof options.payload === 'object') ? options.payload : null;
  const previousEffectiveSignature = (typeof options?.previousEffectiveSignature === 'string')
    ? options.previousEffectiveSignature
    : '';
  const signature = buildEnvironmentContextSignature(payload);
  const inputItems = buildEnvironmentContextInputItems(payload);

  if (!signature || inputItems.length <= 0) {
    return {
      signature: null,
      inputItems: null,
      currentSignature: signature || null,
      status: 'empty',
      reason: !signature ? 'empty_signature' : 'empty_input'
    };
  }

  if (previousEffectiveSignature && previousEffectiveSignature === signature) {
    return {
      signature: null,
      inputItems: null,
      currentSignature: signature,
      status: 'reused',
      reason: 'signature_unchanged'
    };
  }

  return {
    signature,
    inputItems,
    currentSignature: signature,
    status: 'injected',
    reason: previousEffectiveSignature ? 'signature_changed' : 'initial'
  };
}
