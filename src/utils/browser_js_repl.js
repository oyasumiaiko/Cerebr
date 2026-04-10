/**
 * 浏览器侧 JS REPL 共享内核。
 *
 * 设计目标：
 * - 让宿主页 `userScripts` world 与侧栏 sandbox iframe 复用同一套 REPL 语义；
 * - 保持“可 reset”的持久化绑定，不把状态直接落到不可清理的真实全局词法环境里；
 * - 允许顶层 `await` 与显式 `return`；
 * - 对常见顶层声明做轻量改写，把绑定落到可控内核作用域中。
 *
 * 当前边界：
 * - 顶层 `const/let/var` 声明建议以分号结束；这里不试图完整复刻浏览器的 ASI 全语法；
 * - `import` / `export` 不支持；
 * - 为了让 reset 可真正清空状态，这里不会把顶层绑定直接写入真实全局对象。
 */

export const BROWSER_JS_REPL_PRAGMA_PREFIX = '// js-repl:';

function createSyntaxError(message) {
  const error = new SyntaxError(message);
  error.name = 'SyntaxError';
  return error;
}

export function parseBrowserJsReplInput(input) {
  const rawInput = (typeof input === 'string') ? input : '';
  if (!rawInput.trim()) {
    throw new Error(
      'js_repl expects raw JavaScript tool input (non-empty). Provide JS source text, optionally with first-line `// js-repl: ...`.'
    );
  }

  const trimmed = rawInput.trim();
  if (trimmed.startsWith('```')) {
    throw new Error(
      'js_repl expects raw JavaScript source, not markdown code fences. Resend plain JS only (optional first line `// js-repl: ...`).'
    );
  }

  const lines = rawInput.replace(/\r\n?/g, '\n').split('\n');
  const firstLine = lines[0] || '';
  let timeoutMs = null;

  if (firstLine.trimStart().startsWith(BROWSER_JS_REPL_PRAGMA_PREFIX)) {
    const pragma = firstLine.trimStart().slice(BROWSER_JS_REPL_PRAGMA_PREFIX.length).trim();
    if (pragma) {
      const tokens = pragma.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const separatorIndex = token.indexOf('=');
        if (separatorIndex <= 0) {
          throw new Error(
            `js_repl pragma expects space-separated key=value pairs (supported keys: timeout_ms); got \`${token}\``
          );
        }
        const key = token.slice(0, separatorIndex).trim();
        const value = token.slice(separatorIndex + 1).trim();
        if (key !== 'timeout_ms') {
          throw new Error(`js_repl pragma only supports timeout_ms; got \`${key}\``);
        }
        if (timeoutMs !== null) {
          throw new Error('js_repl pragma specifies timeout_ms more than once');
        }
        if (!/^\d+$/.test(value)) {
          throw new Error(`js_repl pragma timeout_ms must be an integer; got \`${value}\``);
        }
        timeoutMs = Math.max(1, Math.trunc(Number(value)));
      }
    }
    const code = lines.slice(1).join('\n');
    if (!code.trim()) {
      throw new Error('js_repl pragma must be followed by JavaScript source on subsequent lines');
    }
    return {
      code,
      timeoutMs
    };
  }

  return {
    code: rawInput,
    timeoutMs
  };
}

export function createBrowserJsReplKernel(globalObject = globalThis) {
  const realGlobal = (globalObject && (typeof globalObject === 'object' || typeof globalObject === 'function'))
    ? globalObject
    : globalThis;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const buildSyntaxError = (message) => {
    const error = new SyntaxError(message);
    error.name = 'SyntaxError';
    return error;
  };
  const bindings = Object.create(null);
  const assignmentFunctionCache = new Map();
  const RESERVED_SCOPE_NAMES = new Set([
    '__cerebrScope',
    '__cerebrGlobal',
    '__cerebrAssignPattern',
    '__cerebrSetBinding',
    '__cerebrGetBinding',
    '__cerebrValue',
    '__cerebrProxy',
    '__cerebrKernel',
    '__cerebrSource'
  ]);
  const KEYWORD_SET = new Set([
    'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
    'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'implements', 'interface', 'package', 'private', 'protected', 'public', 'static'
  ]);
  const PLACEHOLDER = Symbol('cerebr_js_repl_placeholder');

  function isIdentifierStartChar(char) {
    return !!char && /[A-Za-z_$]/.test(char);
  }

  function isIdentifierPartChar(char) {
    return !!char && /[A-Za-z0-9_$]/.test(char);
  }

  function isWhitespaceChar(char) {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
  }

  function isPlainObjectLike(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeError(error) {
    return {
      name: (typeof error?.name === 'string' && error.name.trim()) ? error.name.trim() : 'Error',
      message: (typeof error?.message === 'string' && error.message.trim())
        ? error.message.trim()
        : String(error || '未知错误'),
      stack: (typeof error?.stack === 'string') ? error.stack : ''
    };
  }

  function normalizeConsoleArg(value) {
    if (typeof value === 'string') return value;
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
    if (value instanceof Error) {
      return `${value.name || 'Error'}: ${value.message || ''}`.trim();
    }
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (_key, child) => {
        if (typeof child === 'bigint') return `${child.toString()}n`;
        if (typeof child === 'function') return `[Function${child.name ? `: ${child.name}` : ''}]`;
        if (child instanceof Error) {
          return normalizeError(child);
        }
        if (child && typeof child === 'object') {
          if (seen.has(child)) return '[Circular]';
          seen.add(child);
        }
        return child;
      }, 2);
    } catch (_) {
      try {
        return String(value);
      } catch (_) {
        return '[unserializable]';
      }
    }
  }

  function hasBinding(name) {
    return Object.prototype.hasOwnProperty.call(bindings, name);
  }

  function getBinding(name) {
    return bindings[name];
  }

  function setBinding(name, value) {
    bindings[name] = value;
    return value;
  }

  function clearBindings() {
    for (const key of Object.keys(bindings)) {
      delete bindings[key];
    }
  }

  function cleanupPlaceholderBindings(candidateNames) {
    for (const name of candidateNames) {
      if (hasBinding(name) && bindings[name] === PLACEHOLDER) {
        delete bindings[name];
      }
    }
  }

  function shouldBindGlobalFunction(value) {
    if (typeof value !== 'function') return false;
    if (Object.prototype.hasOwnProperty.call(value, 'prototype')) return false;
    const ownKeys = Object.getOwnPropertyNames(value)
      .filter((key) => !['length', 'name', 'arguments', 'caller'].includes(key));
    return ownKeys.length <= 0;
  }

  function readGlobalValue(key) {
    if (key === Symbol.unscopables) return undefined;
    if (key === 'globalThis' || key === 'self' || key === 'window') {
      return globalProxy;
    }
    if (key === 'console') return realGlobal.console;
    if (key === 'globalThisRaw') return realGlobal;
    if (typeof key === 'symbol') {
      return realGlobal[key];
    }
    if (hasBinding(key)) return bindings[key];
    if (key in realGlobal) {
      const value = realGlobal[key];
      if (shouldBindGlobalFunction(value)) {
        try {
          return value.bind(realGlobal);
        } catch (_) {
          return value;
        }
      }
      return value;
    }
    return undefined;
  }

  const globalProxy = new Proxy(Object.create(null), {
    get(_target, key) {
      return readGlobalValue(key);
    },
    set(_target, key, value) {
      if (typeof key === 'string') {
        bindings[key] = value;
        return true;
      }
      return Reflect.set(realGlobal, key, value);
    },
    has(_target, key) {
      if (typeof key === 'string' && hasBinding(key)) return true;
      if (key === 'globalThis' || key === 'self' || key === 'window' || key === 'console' || key === 'globalThisRaw') {
        return true;
      }
      return key in realGlobal;
    },
    deleteProperty(_target, key) {
      if (typeof key === 'string' && hasBinding(key)) {
        delete bindings[key];
        return true;
      }
      return true;
    }
  });

  const scopeProxy = new Proxy(Object.create(null), {
    has(_target, key) {
      if (typeof key === 'string' && RESERVED_SCOPE_NAMES.has(key)) return false;
      if (key === Symbol.unscopables) return false;
      if (typeof key === 'string' && hasBinding(key)) return true;
      if (key === 'globalThis' || key === 'self' || key === 'window' || key === 'console' || key === 'globalThisRaw') {
        return true;
      }
      return key in realGlobal;
    },
    get(_target, key) {
      if (typeof key === 'string' && RESERVED_SCOPE_NAMES.has(key)) return undefined;
      if (key === Symbol.unscopables) return undefined;
      if (typeof key === 'string' && hasBinding(key)) return bindings[key];
      if (key === 'globalThis' || key === 'self' || key === 'window') return globalProxy;
      if (key === 'console') return realGlobal.console;
      if (key === 'globalThisRaw') return realGlobal;
      if (key in realGlobal) {
        const value = realGlobal[key];
        if (shouldBindGlobalFunction(value)) {
          try {
            return value.bind(realGlobal);
          } catch (_) {
            return value;
          }
        }
        return value;
      }
      if (typeof key === 'string') {
        throw new ReferenceError(`${key} is not defined`);
      }
      return undefined;
    },
    set(_target, key, value) {
      if (typeof key === 'string') {
        bindings[key] = value;
        return true;
      }
      return Reflect.set(realGlobal, key, value);
    },
    deleteProperty(_target, key) {
      if (typeof key === 'string' && hasBinding(key)) {
        delete bindings[key];
        return true;
      }
      return true;
    }
  });

  function skipStringLiteral(source, index) {
    const quote = source[index];
    let cursor = index + 1;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === quote) return cursor + 1;
      cursor += 1;
    }
    return cursor;
  }

  function skipTemplateLiteral(source, index) {
    let cursor = index + 1;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === '`') return cursor + 1;
      if (char === '$' && source[cursor + 1] === '{') {
        cursor = skipBalancedSection(source, cursor + 2, '}');
        continue;
      }
      cursor += 1;
    }
    return cursor;
  }

  function skipLineComment(source, index) {
    let cursor = index + 2;
    while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
    return cursor;
  }

  function skipBlockComment(source, index) {
    let cursor = index + 2;
    while (cursor < source.length) {
      if (source[cursor] === '*' && source[cursor + 1] === '/') {
        return cursor + 2;
      }
      cursor += 1;
    }
    return cursor;
  }

  function skipBalancedSection(source, index, closingChar) {
    let cursor = index;
    let braceDepth = 0;
    let bracketDepth = 0;
    let parenDepth = 0;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (char === '\'' || char === '"') {
        cursor = skipStringLiteral(source, cursor);
        continue;
      }
      if (char === '`') {
        cursor = skipTemplateLiteral(source, cursor);
        continue;
      }
      if (char === '/' && next === '/') {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (char === '/' && next === '*') {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      if (char === '{') braceDepth += 1;
      else if (char === '}') {
        if (closingChar === '}' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
          return cursor + 1;
        }
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (char === '[') bracketDepth += 1;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      if (closingChar !== '}' && char === closingChar && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
        return cursor + 1;
      }
      cursor += 1;
    }
    return cursor;
  }

  function readIdentifier(source, index) {
    if (!isIdentifierStartChar(source[index])) return null;
    let cursor = index + 1;
    while (cursor < source.length && isIdentifierPartChar(source[cursor])) cursor += 1;
    return {
      value: source.slice(index, cursor),
      end: cursor
    };
  }

  function findNextNonWhitespace(source, index) {
    let cursor = index;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (isWhitespaceChar(char)) {
        cursor += 1;
        continue;
      }
      if (char === '/' && next === '/') {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (char === '/' && next === '*') {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      break;
    }
    return cursor;
  }

  function startsWithKeyword(source, index, keyword) {
    if (!source.startsWith(keyword, index)) return false;
    const before = source[index - 1];
    const after = source[index + keyword.length];
    if (before && isIdentifierPartChar(before)) return false;
    if (after && isIdentifierPartChar(after)) return false;
    return true;
  }

  function splitTopLevelByComma(source) {
    const parts = [];
    let cursor = 0;
    let segmentStart = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let parenDepth = 0;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (char === '\'' || char === '"') {
        cursor = skipStringLiteral(source, cursor);
        continue;
      }
      if (char === '`') {
        cursor = skipTemplateLiteral(source, cursor);
        continue;
      }
      if (char === '/' && next === '/') {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (char === '/' && next === '*') {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      if (char === '{') braceDepth += 1;
      else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (char === '[') bracketDepth += 1;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (char === ',' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
        parts.push(source.slice(segmentStart, cursor));
        segmentStart = cursor + 1;
      }
      cursor += 1;
    }
    parts.push(source.slice(segmentStart));
    return parts;
  }

  function findTopLevelEquals(source) {
    let cursor = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let parenDepth = 0;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (char === '\'' || char === '"') {
        cursor = skipStringLiteral(source, cursor);
        continue;
      }
      if (char === '`') {
        cursor = skipTemplateLiteral(source, cursor);
        continue;
      }
      if (char === '/' && next === '/') {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (char === '/' && next === '*') {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      if (char === '{') braceDepth += 1;
      else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (char === '[') bracketDepth += 1;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (
        char === '='
        && braceDepth === 0
        && bracketDepth === 0
        && parenDepth === 0
        && next !== '='
        && source[cursor - 1] !== '='
        && source[cursor - 1] !== '!'
        && next !== '>'
      ) {
        return cursor;
      }
      cursor += 1;
    }
    return -1;
  }

  function extractCandidateBindingNames(patternSource) {
    const names = [];
    const seen = new Set();
    const source = String(patternSource || '');
    let cursor = 0;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (char === '\'' || char === '"') {
        cursor = skipStringLiteral(source, cursor);
        continue;
      }
      if (char === '`') {
        cursor = skipTemplateLiteral(source, cursor);
        continue;
      }
      if (char === '/' && next === '/') {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (char === '/' && next === '*') {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      if (isIdentifierStartChar(char)) {
        const identifier = readIdentifier(source, cursor);
        if (identifier) {
          const name = identifier.value;
          if (!KEYWORD_SET.has(name) && !seen.has(name)) {
            seen.add(name);
            names.push(name);
          }
          cursor = identifier.end;
          continue;
        }
      }
      cursor += 1;
    }
    return names;
  }

  function buildPatternAssignmentFunction(patternSource) {
    const normalizedPattern = String(patternSource || '').trim();
    const needsParentheses = normalizedPattern.startsWith('{') || normalizedPattern.startsWith('[');
    const assignmentBody = needsParentheses
      ? `with (__cerebrScope) { (${normalizedPattern} = __cerebrValue); return __cerebrValue; }`
      : `with (__cerebrScope) { ${normalizedPattern} = __cerebrValue; return __cerebrValue; }`;
    // 这里显式复用 `Function` 构造器，是为了把“模式赋值”编译成稳定、可缓存的小函数，
    // 避免每个声明都重新走字符串拼接 + eval。
    return new Function('__cerebrScope', '__cerebrValue', assignmentBody);
  }

  function assignPattern(patternSource, value) {
    const normalizedPattern = String(patternSource || '').trim();
    if (!normalizedPattern) {
      throw buildSyntaxError('js_repl declaration parser produced an empty binding pattern');
    }
    const candidateNames = extractCandidateBindingNames(normalizedPattern);
    for (const name of candidateNames) {
      if (!hasBinding(name) && !(name in realGlobal)) {
        bindings[name] = PLACEHOLDER;
      }
    }
    try {
      let assignmentFunction = assignmentFunctionCache.get(normalizedPattern);
      if (!assignmentFunction) {
        assignmentFunction = buildPatternAssignmentFunction(normalizedPattern);
        assignmentFunctionCache.set(normalizedPattern, assignmentFunction);
      }
      return assignmentFunction(scopeProxy, value);
    } finally {
      cleanupPlaceholderBindings(candidateNames);
    }
  }

  function readVariableDeclaration(source, startIndex) {
    let cursor = startIndex;
    const kind = startsWithKeyword(source, cursor, 'const')
      ? 'const'
      : startsWithKeyword(source, cursor, 'let')
        ? 'let'
        : 'var';
    cursor += kind.length;
    let braceDepth = 0;
    let bracketDepth = 0;
    let parenDepth = 0;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (char === '\'' || char === '"') {
        cursor = skipStringLiteral(source, cursor);
        continue;
      }
      if (char === '`') {
        cursor = skipTemplateLiteral(source, cursor);
        continue;
      }
      if (char === '/' && next === '/') {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (char === '/' && next === '*') {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      if (char === '{') braceDepth += 1;
      else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (char === '[') bracketDepth += 1;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (char === ';' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
        return {
          raw: source.slice(startIndex, cursor + 1),
          end: cursor + 1,
          kind
        };
      }
      cursor += 1;
    }
    return {
      raw: source.slice(startIndex),
      end: source.length,
      kind
    };
  }

  function transformVariableDeclaration(rawStatement, kind) {
    const source = String(rawStatement || '').trim().replace(/;$/, '').trim();
    const declaratorsSource = source.slice(kind.length).trim();
    if (!declaratorsSource) {
      throw buildSyntaxError(`Unexpected end of ${kind} declaration`);
    }
    const declarators = splitTopLevelByComma(declaratorsSource)
      .map(item => item.trim())
      .filter(Boolean);
    if (declarators.length <= 0) {
      throw buildSyntaxError(`Unexpected end of ${kind} declaration`);
    }
    const lines = [];
    for (const declarator of declarators) {
      const equalsIndex = findTopLevelEquals(declarator);
      const pattern = (equalsIndex >= 0 ? declarator.slice(0, equalsIndex) : declarator).trim();
      const initializer = (equalsIndex >= 0 ? declarator.slice(equalsIndex + 1) : '').trim();
      if (!pattern) {
        throw buildSyntaxError(`Invalid ${kind} declaration: missing binding pattern`);
      }
      if (kind === 'const' && !initializer) {
        throw buildSyntaxError('Missing initializer in const declaration');
      }
      lines.push(
        `await __cerebrAssignPattern(${JSON.stringify(pattern)}, ${initializer ? `(${initializer})` : 'undefined'});`
      );
    }
    return lines.join('\n');
  }

  function findDeclarationBodyBounds(source, startIndex) {
    let cursor = startIndex;
    let bodyStart = -1;
    let parenDepth = 0;
    let bracketDepth = 0;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (char === '\'' || char === '"') {
        cursor = skipStringLiteral(source, cursor);
        continue;
      }
      if (char === '`') {
        cursor = skipTemplateLiteral(source, cursor);
        continue;
      }
      if (char === '/' && next === '/') {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (char === '/' && next === '*') {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (char === '[') bracketDepth += 1;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === '{' && parenDepth === 0 && bracketDepth === 0) {
        bodyStart = cursor;
        break;
      }
      cursor += 1;
    }
    if (bodyStart < 0) {
      throw buildSyntaxError('Unterminated declaration body');
    }
    const bodyEnd = skipBalancedSection(source, bodyStart + 1, '}');
    return {
      bodyStart,
      bodyEnd
    };
  }

  function readFunctionOrClassDeclaration(source, startIndex, type) {
    const startSlice = source.slice(startIndex);
    const declarationPattern = type === 'class'
      ? /^class\s+([A-Za-z_$][\w$]*)/
      : /^(async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/;
    const match = declarationPattern.exec(startSlice);
    if (!match) return null;
    const name = type === 'class' ? match[1] : match[2];
    const bounds = findDeclarationBodyBounds(source, startIndex);
    let end = bounds.bodyEnd;
    while (end < source.length && isWhitespaceChar(source[end])) end += 1;
    if (source[end] === ';') end += 1;
    return {
      raw: source.slice(startIndex, end),
      end,
      name
    };
  }

  function transformNamedDeclaration(rawDeclaration, name) {
    const expressionSource = String(rawDeclaration || '').trim().replace(/;$/, '').trim();
    return `__cerebrSetBinding(${JSON.stringify(name)}, (${expressionSource}));`;
  }

  function transformTopLevelDeclarations(source) {
    const input = String(source || '');
    let cursor = 0;
    let output = '';
    let statementStart = true;
    while (cursor < input.length) {
      const char = input[cursor];
      const next = input[cursor + 1];

      if (char === '\'' || char === '"') {
        const end = skipStringLiteral(input, cursor);
        output += input.slice(cursor, end);
        cursor = end;
        statementStart = false;
        continue;
      }
      if (char === '`') {
        const end = skipTemplateLiteral(input, cursor);
        output += input.slice(cursor, end);
        cursor = end;
        statementStart = false;
        continue;
      }
      if (char === '/' && next === '/') {
        const end = skipLineComment(input, cursor);
        output += input.slice(cursor, end);
        cursor = end;
        continue;
      }
      if (char === '/' && next === '*') {
        const end = skipBlockComment(input, cursor);
        output += input.slice(cursor, end);
        cursor = end;
        continue;
      }

      if (statementStart) {
        if (startsWithKeyword(input, cursor, 'import') || startsWithKeyword(input, cursor, 'export')) {
          throw buildSyntaxError('js_repl does not support top-level import/export declarations in browser mode');
        }

        if (startsWithKeyword(input, cursor, 'const') || startsWithKeyword(input, cursor, 'let') || startsWithKeyword(input, cursor, 'var')) {
          const declaration = readVariableDeclaration(input, cursor);
          output += transformVariableDeclaration(declaration.raw, declaration.kind);
          cursor = declaration.end;
          statementStart = true;
          continue;
        }

        if (startsWithKeyword(input, cursor, 'async')) {
          const afterAsync = findNextNonWhitespace(input, cursor + 'async'.length);
          if (startsWithKeyword(input, afterAsync, 'function')) {
            const declaration = readFunctionOrClassDeclaration(input, cursor, 'function');
            if (declaration) {
              output += transformNamedDeclaration(declaration.raw, declaration.name);
              cursor = declaration.end;
              statementStart = true;
              continue;
            }
          }
        }

        if (startsWithKeyword(input, cursor, 'function')) {
          const declaration = readFunctionOrClassDeclaration(input, cursor, 'function');
          if (declaration) {
            output += transformNamedDeclaration(declaration.raw, declaration.name);
            cursor = declaration.end;
            statementStart = true;
            continue;
          }
        }

        if (startsWithKeyword(input, cursor, 'class')) {
          const declaration = readFunctionOrClassDeclaration(input, cursor, 'class');
          if (declaration) {
            output += transformNamedDeclaration(declaration.raw, declaration.name);
            cursor = declaration.end;
            statementStart = true;
            continue;
          }
        }
      }

      output += char;
      cursor += 1;
      if (char === ';') {
        statementStart = true;
      } else if (!isWhitespaceChar(char)) {
        statementStart = false;
      }
    }
    return output;
  }

  async function execute(code) {
    const source = String(code || '');
    const transformedSource = transformTopLevelDeclarations(source);
    const logs = [];
    const originalConsole = realGlobal.console;
    const capturedConsole = Object.create(originalConsole || {});
    ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
      capturedConsole[level] = (...args) => {
        logs.push({
          level,
          text: args.map((arg) => normalizeConsoleArg(arg)).join(' ')
        });
      };
    });

    try {
      realGlobal.console = capturedConsole;
      const runner = new AsyncFunction(
        '__cerebrScope',
        '__cerebrAssignPattern',
        '__cerebrSetBinding',
        '__cerebrGetBinding',
        `
with (__cerebrScope) {
${transformedSource}
}
`
      );
      const value = await runner.call(
        globalProxy,
        scopeProxy,
        assignPattern,
        setBinding,
        getBinding
      );
      return {
        ok: true,
        value,
        logs
      };
    } catch (error) {
      return {
        ok: false,
        value: null,
        error: normalizeError(error),
        logs
      };
    } finally {
      realGlobal.console = originalConsole;
    }
  }

  function reset() {
    assignmentFunctionCache.clear();
    clearBindings();
  }

  return {
    execute,
    reset
  };
}
