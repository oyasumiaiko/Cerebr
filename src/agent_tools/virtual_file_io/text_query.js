import {
  matchesVirtualPathFilter,
  normalizeVirtualPathFilter
} from '../shared/virtual_file_path.js';

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 object。`);
  }
  return value;
}

export function readNullableSafeInteger(value, options = {}) {
  if (value == null) return null;
  const label = options?.label || 'value';
  const minimum = Number.isSafeInteger(options?.minimum) ? options.minimum : Number.MIN_SAFE_INTEGER;
  const maximum = Number.isSafeInteger(options?.maximum) ? options.maximum : Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必须是 ${minimum}-${maximum} 范围内的整数或 null。`);
  }
  return value;
}

export function normalizeVirtualFileLineRange(rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const startLine = readNullableSafeInteger(args.start_line, {
    label: 'start_line',
    minimum: 1
  });
  const endLine = readNullableSafeInteger(args.end_line, {
    label: 'end_line',
    minimum: 1
  });
  if ((startLine == null) !== (endLine == null)) {
    throw new Error('virtual_file 参数错误：start_line 与 end_line 必须同时为整数或同时为 null。');
  }
  if (startLine != null && endLine < startLine) {
    throw new Error('virtual_file 参数错误：end_line 不能小于 start_line。');
  }
  return {
    start_line: startLine,
    end_line: endLine
  };
}

/**
 * 返回每个逻辑行在原始字符串中的范围。范围包含该行真实存在的 CRLF/LF/CR，
 * 因而按行读取不会改写文件换行符，也不会凭空补换行。
 */
export function collectVirtualTextLineSpans(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (!source) return [];
  const spans = [];
  let lineStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char !== '\n' && char !== '\r') continue;
    let lineEnd = index + 1;
    let textEnd = index;
    if (char === '\r' && source[index + 1] === '\n') {
      lineEnd += 1;
      index += 1;
    }
    spans.push({ start: lineStart, end: lineEnd, text_end: textEnd });
    lineStart = lineEnd;
  }
  if (lineStart < source.length) {
    spans.push({ start: lineStart, end: source.length, text_end: source.length });
  }
  return spans;
}

export function buildVirtualTextReadResult(text, rawArgs = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const range = normalizeVirtualFileLineRange(rawArgs);
  const spans = collectVirtualTextLineSpans(source);
  const totalLines = spans.length;
  if (range.start_line == null) {
    return {
      mode: 'full',
      total_chars: source.length,
      total_lines: totalLines,
      start_line: totalLines > 0 ? 1 : null,
      end_line: totalLines > 0 ? totalLines : null,
      returned_line_count: totalLines,
      returned_chars: source.length,
      has_more_after_range: false,
      content: source
    };
  }
  if (totalLines === 0) {
    throw new Error('read_file 行范围无效：文件为空。');
  }
  if (range.start_line > totalLines) {
    throw new Error(`read_file 行范围无效：start_line=${range.start_line} 超过文件总行数 ${totalLines}。`);
  }
  const returnedEndLine = Math.min(range.end_line, totalLines);
  const startOffset = spans[range.start_line - 1].start;
  const endOffset = spans[returnedEndLine - 1].end;
  const content = source.slice(startOffset, endOffset);
  return {
    mode: 'lines',
    total_chars: source.length,
    total_lines: totalLines,
    start_line: range.start_line,
    end_line: returnedEndLine,
    returned_line_count: returnedEndLine - range.start_line + 1,
    returned_chars: content.length,
    has_more_after_range: returnedEndLine < totalLines,
    content
  };
}

function buildTextLines(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  return collectVirtualTextLineSpans(source).map((span, index) => ({
    line_number: index + 1,
    text: source.slice(span.start, span.text_end)
  }));
}

function assertSearchPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) {
    throw new Error('virtual_file 参数错误：search_files 需要非空 pattern。');
  }
  return pattern;
}

function buildLineMatcher(pattern, options) {
  const ignoreCase = options?.ignore_case === true;
  if (options?.regex === true) {
    let expression;
    try {
      expression = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (error) {
      throw new Error(`virtual_file 参数错误：无效的正则 pattern：${error?.message || error}`);
    }
    return (line) => expression.test(line);
  }
  const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
  return (line) => {
    const haystack = ignoreCase ? line.toLocaleLowerCase() : line;
    return haystack.includes(needle);
  };
}

function mergeMatchingLineWindows(lines, matchingIndexes, contextLines) {
  const groups = [];
  for (const matchingIndex of matchingIndexes) {
    const start = Math.max(0, matchingIndex - contextLines);
    const end = Math.min(lines.length - 1, matchingIndex + contextLines);
    const previous = groups[groups.length - 1];
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
      previous.matching_indexes.add(matchingIndex);
      continue;
    }
    groups.push({ start, end, matching_indexes: new Set([matchingIndex]) });
  }
  return groups.map((group) => ({
    lines: lines.slice(group.start, group.end + 1).map((line, offset) => ({
      ...line,
      is_match: group.matching_indexes.has(group.start + offset)
    }))
  }));
}

export function searchVirtualTextDocuments(documents, rawOptions = {}) {
  const sourceDocuments = Array.isArray(documents) ? documents : [];
  const pattern = assertSearchPattern(rawOptions.pattern);
  const regex = rawOptions.regex === true;
  const ignoreCase = rawOptions.ignore_case === true;
  const contextLines = readNullableSafeInteger(rawOptions.context_lines, {
    label: 'context_lines',
    minimum: 0,
    maximum: 20
  }) ?? 0;
  const pathGlob = normalizeVirtualPathFilter(rawOptions.path_glob, { label: 'path_glob' });
  const matchesLine = buildLineMatcher(pattern, { regex, ignore_case: ignoreCase });
  const groups = [];
  let totalMatchingLines = 0;

  for (const rawDocument of sourceDocuments) {
    const document = assertPlainObject(rawDocument, 'virtual_file document');
    if (typeof document.path !== 'string' || !document.path) {
      throw new Error('virtual_file document.path 必须是非空字符串。');
    }
    if (typeof document.content !== 'string') {
      throw new Error(`virtual_file document ${document.path} 缺少字符串 content。`);
    }
    if (!matchesVirtualPathFilter(document.path, pathGlob)) continue;
    const lines = buildTextLines(document.content);
    const matchingIndexes = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (matchesLine(lines[index].text)) matchingIndexes.push(index);
    }
    totalMatchingLines += matchingIndexes.length;
    for (const group of mergeMatchingLineWindows(lines, matchingIndexes, contextLines)) {
      groups.push({
        file_path: document.path,
        ...(typeof document.skill_name === 'string' && document.skill_name
          ? { skill_name: document.skill_name }
          : {}),
        lines: group.lines
      });
    }
  }

  return {
    pattern,
    regex,
    ignore_case: ignoreCase,
    path_glob: pathGlob,
    context_lines: contextLines,
    total_matching_lines: totalMatchingLines,
    groups
  };
}
