/*
 * MIT License
 *
 * Copyright (c) 2025 OpenAI
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * OpenAI Responses API apply_patch 工具所使用的 headerless V4A diff 参考实现。
 *
 * 上游来源：
 * https://github.com/openai/openai-agents-js/blob/04807e33347b2b92bdde7685d83d84f1bc144c6d/packages/agents-core/src/utils/applyDiff.ts
 *
 * 固定上游提交：
 * 04807e33347b2b92bdde7685d83d84f1bc144c6d
 *
 * 维护说明：
 * - 本文件从 OpenAI Agents JS 官方实现直接移植，仅移除了 TypeScript 类型；
 * - 应尽量逐行保持官方解析、上下文匹配、尾换行与错误行为，避免产生协议方言；
 * - 不要重新引入或合并 Cerebr 旧的多文件 "*** Begin Patch" 解析器。官方
 *   apply_patch_call 已在 operation 中单独提供 type、path 和 diff，本模块只负责
 *   把单文件 V4A diff 应用到给定文本；
 * - 若以后同步上游，请同时更新固定 commit、来源链接和对应回归测试。
 */

/**
 * 将 headerless V4A diff 应用到给定文件内容。
 *
 * mode="default"：使用 V4A section（@@ 与 +/-/空格前缀行）更新已有文件。
 * mode="create"：创建文件，要求 diff 中的每一行都以 "+" 开头。
 *
 * 函数会保留原文件是否具有尾换行的状态；当 diff 无法干净应用时会抛错。
 *
 * @param {string} input
 * @param {string} diff
 * @param {'default'|'create'} [mode='default']
 * @returns {string}
 */
export function applyDiff(input, diff, mode = 'default') {
  const diffLines = normalizeDiffLines(diff);

  if (mode === 'create') {
    return parseCreateDiff(diffLines);
  }

  const { chunks } = parseUpdateDiff(diffLines, input);
  return applyChunks(input, chunks);
}

const END_PATCH = '*** End Patch';
const END_FILE = '*** End of File';
const END_SECTION_MARKERS = [
  END_PATCH,
  '*** Update File:',
  '*** Delete File:',
  '*** Add File:',
  END_FILE
];

const SECTION_TERMINATORS = [
  END_PATCH,
  '*** Update File:',
  '*** Delete File:',
  '*** Add File:'
];

function normalizeDiffLines(diff) {
  return diff
    .split(/\r?\n/)
    .map(line => line.replace(/\r$/, ''))
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ''));
}

function isDone(state, prefixes) {
  if (state.index >= state.lines.length) return true;
  if (prefixes.some(prefix => state.lines[state.index]?.startsWith(prefix))) {
    return true;
  }
  return false;
}

function readStr(state, prefix) {
  const current = state.lines[state.index];
  if (typeof current === 'string' && current.startsWith(prefix)) {
    state.index += 1;
    return current.slice(prefix.length);
  }
  return '';
}

function parseCreateDiff(lines) {
  const parser = {
    lines: [...lines, END_PATCH],
    index: 0,
    fuzz: 0
  };
  const output = [];

  while (!isDone(parser, SECTION_TERMINATORS)) {
    const line = parser.lines[parser.index];
    parser.index += 1;
    if (!line.startsWith('+')) {
      throw new Error('Invalid Add File Line: ' + line);
    }
    output.push(line.slice(1));
  }

  return output.join('\n');
}

function parseUpdateDiff(lines, input) {
  const parser = {
    lines: [...lines, END_PATCH],
    index: 0,
    fuzz: 0
  };
  const inputLines = input.split('\n');
  const chunks = [];
  let cursor = 0;

  while (!isDone(parser, END_SECTION_MARKERS)) {
    const anchor = readStr(parser, '@@ ');
    const hasBareAnchor = !anchor && parser.lines[parser.index] === '@@';
    if (hasBareAnchor) parser.index += 1;

    if (!(anchor || hasBareAnchor || cursor === 0)) {
      throw new Error('Invalid Line:\n' + parser.lines[parser.index]);
    }

    if (anchor.trim()) {
      cursor = advanceCursorToAnchor(anchor, inputLines, cursor, parser);
    }

    const { nextContext, sectionChunks, endIndex, eof } = readSection(
      parser.lines,
      parser.index
    );
    const nextContextText = nextContext.join('\n');
    const { newIndex, fuzz } = findContext(
      inputLines,
      nextContext,
      cursor,
      eof
    );

    if (newIndex === -1) {
      if (eof) {
        throw new Error('Invalid EOF Context ' + cursor + ':\n' + nextContextText);
      }
      throw new Error('Invalid Context ' + cursor + ':\n' + nextContextText);
    }

    parser.fuzz += fuzz;
    for (const chunk of sectionChunks) {
      chunks.push({ ...chunk, origIndex: chunk.origIndex + newIndex });
    }

    cursor = newIndex + nextContext.length;
    parser.index = endIndex;
  }

  return { chunks, fuzz: parser.fuzz };
}

function advanceCursorToAnchor(anchor, inputLines, cursor, parser) {
  let found = false;

  if (!inputLines.slice(0, cursor).some(line => line === anchor)) {
    for (let index = cursor; index < inputLines.length; index += 1) {
      if (inputLines[index] === anchor) {
        cursor = index + 1;
        found = true;
        break;
      }
    }
  }

  if (
    !found
    && !inputLines.slice(0, cursor).some(line => line.trim() === anchor.trim())
  ) {
    for (let index = cursor; index < inputLines.length; index += 1) {
      if (inputLines[index].trim() === anchor.trim()) {
        cursor = index + 1;
        parser.fuzz += 1;
        found = true;
        break;
      }
    }
  }

  return cursor;
}

function readSection(lines, startIndex) {
  const context = [];
  let deletedLines = [];
  let insertedLines = [];
  const sectionChunks = [];
  let mode = 'keep';
  let index = startIndex;
  const originalIndex = index;

  while (index < lines.length) {
    const raw = lines[index];
    if (
      raw.startsWith('@@')
      || raw.startsWith(END_PATCH)
      || raw.startsWith('*** Update File:')
      || raw.startsWith('*** Delete File:')
      || raw.startsWith('*** Add File:')
      || raw.startsWith(END_FILE)
    ) {
      break;
    }
    if (raw === '***') break;
    if (raw.startsWith('***')) {
      throw new Error('Invalid Line: ' + raw);
    }

    index += 1;
    const lastMode = mode;
    let line = raw;
    if (line === '') line = ' ';

    if (line[0] === '+') {
      mode = 'add';
    } else if (line[0] === '-') {
      mode = 'delete';
    } else if (line[0] === ' ') {
      mode = 'keep';
    } else {
      throw new Error('Invalid Line: ' + line);
    }

    line = line.slice(1);

    const switchingToContext = mode === 'keep' && lastMode !== mode;
    if (switchingToContext && (insertedLines.length || deletedLines.length)) {
      sectionChunks.push({
        origIndex: context.length - deletedLines.length,
        delLines: deletedLines,
        insLines: insertedLines
      });
      deletedLines = [];
      insertedLines = [];
    }

    if (mode === 'delete') {
      deletedLines.push(line);
      context.push(line);
    } else if (mode === 'add') {
      insertedLines.push(line);
    } else {
      context.push(line);
    }
  }

  if (insertedLines.length || deletedLines.length) {
    sectionChunks.push({
      origIndex: context.length - deletedLines.length,
      delLines: deletedLines,
      insLines: insertedLines
    });
    deletedLines = [];
    insertedLines = [];
  }

  if (index < lines.length && lines[index] === END_FILE) {
    index += 1;
    return {
      nextContext: context,
      sectionChunks,
      endIndex: index,
      eof: true
    };
  }

  if (index === originalIndex) {
    throw new Error(
      'Nothing in this section - index=' + index + ' ' + lines[index]
    );
  }

  return {
    nextContext: context,
    sectionChunks,
    endIndex: index,
    eof: false
  };
}

function findContext(lines, context, start, eof) {
  if (eof) {
    const endStart = Math.max(0, lines.length - context.length);
    const endMatch = findContextCore(lines, context, endStart);
    if (endMatch.newIndex !== -1) return endMatch;
    const fallback = findContextCore(lines, context, start);
    return {
      newIndex: fallback.newIndex,
      fuzz: fallback.fuzz + 10000
    };
  }
  return findContextCore(lines, context, start);
}

function findContextCore(lines, context, start) {
  if (!context.length) {
    return { newIndex: start, fuzz: 0 };
  }

  for (let index = start; index < lines.length; index += 1) {
    if (equalsSlice(lines, context, index, value => value)) {
      return { newIndex: index, fuzz: 0 };
    }
  }
  for (let index = start; index < lines.length; index += 1) {
    if (equalsSlice(lines, context, index, value => value.trimEnd())) {
      return { newIndex: index, fuzz: 1 };
    }
  }
  for (let index = start; index < lines.length; index += 1) {
    if (equalsSlice(lines, context, index, value => value.trim())) {
      return { newIndex: index, fuzz: 100 };
    }
  }

  return { newIndex: -1, fuzz: 0 };
}

function equalsSlice(source, target, start, mapFn) {
  if (start + target.length > source.length) return false;
  for (let index = 0; index < target.length; index += 1) {
    if (mapFn(source[start + index]) !== mapFn(target[index])) return false;
  }
  return true;
}

function applyChunks(input, chunks) {
  const originalLines = input.split('\n');
  const destinationLines = [];
  let originalIndex = 0;

  for (const chunk of chunks) {
    if (chunk.origIndex > originalLines.length) {
      throw new Error(
        'applyDiff: chunk.origIndex '
        + chunk.origIndex
        + ' > input length '
        + originalLines.length
      );
    }
    if (originalIndex > chunk.origIndex) {
      throw new Error(
        'applyDiff: overlapping chunk at '
        + chunk.origIndex
        + ' (cursor '
        + originalIndex
        + ')'
      );
    }

    destinationLines.push(...originalLines.slice(originalIndex, chunk.origIndex));
    originalIndex = chunk.origIndex;

    if (chunk.insLines.length) {
      destinationLines.push(...chunk.insLines);
    }

    originalIndex += chunk.delLines.length;
  }

  destinationLines.push(...originalLines.slice(originalIndex));
  return destinationLines.join('\n');
}
