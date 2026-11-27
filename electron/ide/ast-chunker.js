'use strict';

const crypto = require('crypto');
const path = require('path');

const MAX_CHUNK_LINES = 90;
const OVERLAP_LINES = 10;

const CALL_IGNORE = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'catch', 'try', 'finally',
  'return', 'throw', 'await', 'async', 'typeof', 'instanceof', 'new', 'delete',
  'import', 'export', 'from', 'as', 'def', 'class', 'struct', 'enum', 'interface',
  'type', 'func', 'fn', 'function', 'super', 'this', 'self', 'sizeof', 'match',
  'guard', 'let', 'const', 'var', 'mut', 'pub', 'yield', 'with', 'assert',
]);

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function detectLanguage(extOrPath = '') {
  const ext = String(extOrPath || '').toLowerCase();
  const norm = ext.startsWith('.') ? ext : path.extname(ext);
  if (/^\.(js|jsx|mjs|cjs)$/.test(norm)) return 'javascript';
  if (/^\.(ts|tsx)$/.test(norm)) return 'typescript';
  if (norm === '.py') return 'python';
  if (norm === '.go') return 'go';
  if (norm === '.rs') return 'rust';
  if (/^\.(c|h)$/.test(norm)) return 'c';
  if (/^\.(cpp|cc|cxx|hpp|hh)$/.test(norm)) return 'cpp';
  if (/^\.(java|kt|kts)$/.test(norm)) return 'java';
  if (norm === '.rb') return 'ruby';
  if (norm === '.swift') return 'swift';
  return 'text';
}

/**
 * Strip comments and string literals while preserving exact newline structure
 * so brace depths and line numbers remain 1:1 with source lines.
 */
function maskCommentsAndStrings(src, lang) {
  const s = String(src || '');
  const out = new Array(s.length);
  const hashLineComment = lang === 'python' || lang === 'ruby';
  const tripleQuote = lang === 'python';
  const slashComments = lang !== 'python' && lang !== 'ruby';
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    const nx = s[i + 1];

    if (tripleQuote && (s.startsWith('"""', i) || s.startsWith("'''", i))) {
      const q = s.slice(i, i + 3);
      out[i] = out[i + 1] = out[i + 2] = ' ';
      i += 3;
      while (i < s.length && !s.startsWith(q, i)) {
        out[i] = s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < s.length) {
        out[i] = out[i + 1] = out[i + 2] = ' ';
        i += 3;
      }
      continue;
    }

    if (slashComments && ch === '/' && nx === '/') {
      while (i < s.length && s[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (hashLineComment && ch === '#') {
      while (i < s.length && s[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (slashComments && ch === '/' && nx === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        out[i] = s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < s.length) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }

    if (ch === '"' || ch === "'" || (ch === '`' && (lang === 'javascript' || lang === 'typescript' || lang === 'go'))) {
      const quote = ch;
      out[i++] = ' ';
      while (i < s.length) {
        const c = s[i];
        if (c === '\\' && quote !== '`' && lang !== 'go') {
          out[i++] = ' ';
          if (i < s.length) out[i++] = s[i - 1] === '\n' ? '\n' : ' ';
          continue;
        }
        if (quote === '`' && c === '\\') {
          out[i++] = ' ';
          if (i < s.length) out[i++] = s[i - 1] === '\n' ? '\n' : ' ';
          continue;
        }
        if (c === quote) {
          out[i++] = ' ';
          break;
        }
        out[i] = c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out[i] = ch;
    i++;
  }
  return out.join('');
}

function countBracesOnLine(line) {
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '{') delta++;
    else if (line[i] === '}') delta--;
  }
  return delta;
}

function lineIndent(rawLine) {
  const m = /^([ \t]*)/.exec(rawLine || '');
  return m ? m[1].replace(/\t/g, '    ').length : 0;
}

function extractImportsAndExports(rawLines, lang) {
  const imports = [];
  const exportsSet = new Set();

  for (let i = 0; i < rawLines.length; i++) {
    const ln = rawLines[i];

    // Imports across JS/TS, Python, Go, Rust, C/C++, Java/Kotlin, Ruby, Swift
    let m;
    if ((m = /^\s*import\s+.*?\sfrom\s+['"]([^'"]+)['"]/.exec(ln))) imports.push(m[1]);
    else if ((m = /^\s*import\s+['"]([^'"]+)['"]/.exec(ln))) imports.push(m[1]);
    else if ((m = /^\s*(?:const|let|var)\s+[^=]+=\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(ln))) imports.push(m[1]);
    else if (lang === 'python' && (m = /^\s*from\s+([\w.]+)\s+import\b/.exec(ln))) imports.push(m[1]);
    else if (lang === 'python' && (m = /^\s*import\s+([\w.,\s]+)/.exec(ln))) {
      for (const p of m[1].split(',')) {
        const clean = p.trim().split(/\s+as\s+/)[0].trim();
        if (clean) imports.push(clean);
      }
    } else if ((lang === 'go') && (m = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(ln)) && ln.trim().startsWith('"')) imports.push(m[1]);
    else if ((lang === 'go') && (m = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(ln))) imports.push(m[1]);
    else if ((lang === 'rust') && (m = /^\s*(?:pub\s+)?use\s+([^;{]+)/.exec(ln))) imports.push(m[1].trim());
    else if ((lang === 'c' || lang === 'cpp') && (m = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/.exec(ln))) imports.push(m[1]);
    else if ((lang === 'java' || lang === 'swift') && (m = /^\s*import\s+(?:static\s+)?([\w.]+)/.exec(ln))) imports.push(m[1]);
    else if (lang === 'ruby' && (m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(ln))) imports.push(m[1]);

    // Exports
    if ((m = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(ln))) {
      exportsSet.add(m[1]);
    } else if (/^\s*module\.exports\s*=\s*\{/.test(ln)) {
      for (let j = i; j < Math.min(rawLines.length, i + 25); j++) {
        const em = /^\s*([A-Za-z_$][\w$]*)\s*(?:[:,]|$)/.exec(rawLines[j].trim());
        if (em && em[1] !== 'module' && em[1] !== 'exports') exportsSet.add(em[1]);
        if (rawLines[j].includes('}')) break;
      }
    } else if ((m = /^\s*exports\.([A-Za-z_$][\w$]*)\s*=/.exec(ln))) {
      exportsSet.add(m[1]);
    } else if (lang === 'rust' && (m = /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|mod|type|const)\s+([A-Za-z_][\w]*)/.exec(ln))) {
      exportsSet.add(m[1]);
    } else if (lang === 'go' && (m = /^\s*(?:func|type)\s+(?:\([^)]+\)\s*)?([A-Z][\w]*)/.exec(ln))) {
      exportsSet.add(m[1]);
    }
  }

  return {
    imports: [...new Set(imports)],
    exports: [...exportsSet],
  };
}

function matchDeclaration(maskedLine, rawLine, lang, insideClass) {
  const ln = maskedLine;
  const trim = ln.trim();
  if (!trim) return null;

  let m;
  if (lang === 'python') {
    if ((m = /^\s*class\s+([A-Za-z_][\w]*)/.exec(ln))) return { kind: 'class', name: m[1], container: true };
    if ((m = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(ln))) return { kind: insideClass ? 'method' : 'def', name: m[1], container: false };
    return null;
  }

  if (lang === 'ruby') {
    if ((m = /^\s*(?:class|module)\s+([A-Za-z_][\w:]*)/.exec(ln))) return { kind: 'class', name: m[1], container: true };
    if ((m = /^\s*def\s+(?:self\.)?([A-Za-z_][\w?!]*)/.exec(ln))) return { kind: insideClass ? 'method' : 'def', name: m[1], container: false };
    return null;
  }

  // JS / TS
  if (lang === 'javascript' || lang === 'typescript' || lang === 'text') {
    if ((m = /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/.exec(ln))) return { kind: 'class', name: m[1], container: true };
    if ((m = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/.exec(ln))) return { kind: 'interface', name: m[1], container: true };
    if ((m = /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/.exec(ln))) return { kind: 'enum', name: m[1], container: true };
    if ((m = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(ln))) return { kind: 'type', name: m[1], container: false };
    if ((m = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/.exec(ln))) return { kind: 'function', name: m[1], container: false };
    if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(ln))) return { kind: 'const', name: m[1], container: false };
    if (insideClass && (m = /^\s*(?:public|private|protected|static|async|override|get|set|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/.exec(ln))) {
      if (!CALL_IGNORE.has(m[1])) return { kind: 'method', name: m[1], container: false };
    }
    return null;
  }

  if (lang === 'go') {
    if ((m = /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/.exec(ln))) return { kind: ln.includes('interface') ? 'interface' : 'struct', name: m[1], container: true };
    if ((m = /^\s*func\s+(?:\(([^)]+)\)\s*)?([A-Za-z_][\w]*)\s*\(/.exec(ln))) {
      const recv = m[1] ? m[1].trim().split(/\s+/).pop().replace(/^\*/, '') : '';
      return { kind: recv ? 'method' : 'func', name: m[2], parentHint: recv || '', container: false };
    }
    return null;
  }

  if (lang === 'rust') {
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)\b/.exec(ln))) return { kind: 'struct', name: m[1], container: true };
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)\b/.exec(ln))) return { kind: 'trait', name: m[1], container: true };
    if ((m = /^\s*impl(?:<[^>]+>)?\s+(?:[\w:]+\s+for\s+)?([A-Za-z_][\w]*)/.exec(ln))) return { kind: 'impl', name: m[1], container: true };
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\(/.exec(ln))) return { kind: insideClass ? 'method' : 'function', name: m[1], container: false };
    return null;
  }

  if (lang === 'java' || lang === 'swift' || lang === 'c' || lang === 'cpp') {
    if ((m = /^\s*(?:public|private|internal|open|final|abstract|static|\s)*(?:class|struct|interface|protocol|enum|extension)\s+([A-Za-z_][\w]*)/.exec(ln))) {
      return { kind: 'class', name: m[1], container: true };
    }
    if (lang === 'swift' && (m = /^\s*(?:public|private|internal|open|override|static|\s)*func\s+([A-Za-z_][\w]*)\s*/.exec(ln))) {
      return { kind: insideClass ? 'method' : 'func', name: m[1], container: false };
    }
    if ((m = /^\s*(?:(?:public|private|protected|static|virtual|inline|async|final|override)\s+)*[\w:<>*&\s\[\]]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:const\s*)?(?:throws\s*)?\{/.exec(ln))) {
      if (!CALL_IGNORE.has(m[1])) return { kind: insideClass ? 'method' : 'function', name: m[1], container: false };
    }
  }

  return null;
}

function extractCalls(maskedText) {
  const calls = new Set();
  const re = /\b([A-Za-z_$][\w$]{1,48})\s*\(/g;
  let m;
  while ((m = re.exec(maskedText))) {
    const name = m[1];
    if (!CALL_IGNORE.has(name) && calls.size < 40) calls.add(name);
  }
  return [...calls];
}

function extractScopesIndent(rawLines, maskedLines, lang) {
  const symbols = [];
  const stack = []; // { name, kind, startLine, indent, container }

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const raw = rawLines[i];
    const masked = maskedLines[i];
    const trim = masked.trim();

    if (lang === 'python') {
      if (trim) {
        const ind = lineIndent(raw);
        while (stack.length && ind <= stack[stack.length - 1].indent) {
          const closed = stack.pop();
          closed.endLine = Math.max(closed.startLine, lineNo - 1);
          symbols.push(closed);
        }
      }
      const decl = matchDeclaration(masked, raw, lang, stack.some((s) => s.container));
      if (decl) {
        const parent = [...stack].reverse().find((s) => s.container)?.name || '';
        const breadcrumb = parent ? `${parent} > ${decl.name}` : decl.name;
        stack.push({
          name: decl.name,
          kind: decl.kind,
          line: lineNo,
          startLine: lineNo,
          endLine: lineNo,
          parent,
          breadcrumb,
          container: decl.container,
          indent: lineIndent(raw),
        });
      }
    } else {
      // Ruby
      const decl = matchDeclaration(masked, raw, lang, stack.some((s) => s.container));
      if (decl) {
        const parent = [...stack].reverse().find((s) => s.container)?.name || '';
        const breadcrumb = parent ? `${parent} > ${decl.name}` : decl.name;
        stack.push({
          name: decl.name,
          kind: decl.kind,
          line: lineNo,
          startLine: lineNo,
          endLine: lineNo,
          parent,
          breadcrumb,
          container: decl.container,
          indent: lineIndent(raw),
        });
      } else if (/^\s*end\b/.test(masked) && stack.length) {
        const closed = stack.pop();
        closed.endLine = lineNo;
        symbols.push(closed);
      }
    }
  }

  while (stack.length) {
    const closed = stack.pop();
    closed.endLine = rawLines.length;
    symbols.push(closed);
  }
  symbols.sort((a, b) => a.line - b.line);
  return symbols;
}

function extractScopesBrace(rawLines, maskedLines, lang) {
  const symbols = [];
  const stack = [];
  let braceDepth = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const raw = rawLines[i];
    const masked = maskedLines[i];
    const delta = countBracesOnLine(masked);
    const prevDepth = braceDepth;
    const insideContainer = stack.some((s) => s.container);

    const decl = matchDeclaration(masked, raw, lang, insideContainer);
    if (decl) {
      const parentObj = [...stack].reverse().find((s) => s.container);
      const parent = decl.parentHint || (parentObj && parentObj.name) || '';
      const breadcrumb = parent ? `${parent} > ${decl.name}` : decl.name;
      // Target close depth is depth before this declaration opened its body
      const targetCloseDepth = prevDepth;
      const opensHere = masked.includes('{');
      const closesSameLine = opensHere && delta <= 0;
      const item = {
        name: decl.name,
        kind: decl.kind,
        line: lineNo,
        startLine: lineNo,
        endLine: lineNo,
        parent,
        breadcrumb,
        container: decl.container,
        closeDepth: targetCloseDepth,
        waitingOpen: !opensHere,
      };
      if (closesSameLine || decl.kind === 'type') {
        item.endLine = lineNo;
        symbols.push(item);
      } else {
        stack.push(item);
      }
    }

    braceDepth += delta;
    if (braceDepth < 0) braceDepth = 0;

    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.waitingOpen) {
        if (masked.includes('{')) top.waitingOpen = false;
        else break;
      }
      if (braceDepth <= top.closeDepth) {
        const closed = stack.pop();
        closed.endLine = lineNo;
        symbols.push(closed);
      } else {
        break;
      }
    }
  }

  while (stack.length) {
    const closed = stack.pop();
    closed.endLine = rawLines.length;
    symbols.push(closed);
  }
  symbols.sort((a, b) => a.line - b.line);
  return symbols;
}

function sliceLineRange(rawLines, startLine, endLine) {
  return rawLines.slice(Math.max(0, startLine - 1), Math.min(rawLines.length, endLine)).join('\n');
}

function buildScopeChunks(rawLines, maskedLines, symbols, { imports, exports }) {
  const chunks = [];
  const totalLines = rawLines.length;
  if (totalLines === 0) return chunks;

  const topNodes = [];
  // Prefer leaf/function/method chunks plus container headers, splitting any large block > MAX_CHUNK_LINES
  for (const sym of symbols) {
    const len = sym.endLine - sym.startLine + 1;
    const childSyms = symbols.filter((c) => c !== sym && c.startLine > sym.startLine && c.endLine <= sym.endLine);
    if (sym.container && childSyms.length > 0) {
      // Emit class/container header up to first child so decorators/fields aren't lost
      const firstChildStart = Math.min(...childSyms.map((c) => c.startLine));
      if (firstChildStart > sym.startLine) {
        topNodes.push({
          startLine: sym.startLine,
          endLine: firstChildStart - 1,
          kind: sym.kind,
          symbol: sym.name,
          breadcrumb: sym.breadcrumb,
        });
      }
      continue;
    }
    if (len <= MAX_CHUNK_LINES) {
      topNodes.push({
        startLine: sym.startLine,
        endLine: sym.endLine,
        kind: sym.kind,
        symbol: sym.name,
        breadcrumb: sym.breadcrumb,
      });
    } else {
      const step = MAX_CHUNK_LINES - OVERLAP_LINES;
      for (let s = sym.startLine; s <= sym.endLine; s += step) {
        const e = Math.min(sym.endLine, s + MAX_CHUNK_LINES - 1);
        topNodes.push({
          startLine: s,
          endLine: e,
          kind: sym.kind,
          symbol: sym.name,
          breadcrumb: sym.breadcrumb,
        });
        if (e >= sym.endLine) break;
      }
    }
  }

  topNodes.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  // Fill top-level/module code gaps between declarations (imports, module setup, tests)
  const covered = [];
  let cursor = 1;
  for (const node of topNodes) {
    if (node.startLine > cursor) {
      let s = cursor;
      while (s < node.startLine) {
        const e = Math.min(node.startLine - 1, s + MAX_CHUNK_LINES - 1);
        covered.push({
          startLine: s,
          endLine: e,
          kind: s === 1 ? 'module' : 'block',
          symbol: '',
          breadcrumb: '',
        });
        s = e + 1;
      }
    }
    covered.push(node);
    cursor = Math.max(cursor, node.endLine + 1);
  }
  if (cursor <= totalLines) {
    const step = MAX_CHUNK_LINES - OVERLAP_LINES;
    for (let s = cursor; s <= totalLines; s += step) {
      const e = Math.min(totalLines, s + MAX_CHUNK_LINES - 1);
      covered.push({ startLine: s, endLine: e, kind: 'block', symbol: '', breadcrumb: '' });
      if (e >= totalLines) break;
    }
  }

  const seenRange = new Set();
  for (const ch of covered) {
    const rk = `${ch.startLine}:${ch.endLine}`;
    if (seenRange.has(rk)) continue;
    seenRange.add(rk);
    const rawText = sliceLineRange(rawLines, ch.startLine, ch.endLine).trim();
    if (!rawText) continue;
    const maskedText = sliceLineRange(maskedLines, ch.startLine, ch.endLine);
    const calls = extractCalls(maskedText);
    const text = rawText.slice(0, 4800);
    chunks.push({
      startLine: ch.startLine,
      endLine: ch.endLine,
      kind: ch.kind,
      symbol: ch.symbol || '',
      breadcrumb: ch.breadcrumb || '',
      imports: ch.startLine <= 30 ? imports.slice(0, 20) : [],
      exports: exports.includes(ch.symbol) ? [ch.symbol] : [],
      calls,
      text,
      sha256: sha256Hex(`${ch.breadcrumb}|${text}`),
    });
  }

  return chunks;
}

function parseFile(content, filePathOrExt = '.js') {
  const src = String(content || '');
  const lang = detectLanguage(filePathOrExt);
  const rawLines = src.split(/\r?\n/);
  const maskedSrc = maskCommentsAndStrings(src, lang);
  const maskedLines = maskedSrc.split(/\r?\n/);

  const { imports, exports: expNames } = extractImportsAndExports(rawLines, lang);
  const exportsSet = new Set(expNames);

  let rawSymbols;
  if (lang === 'python' || lang === 'ruby') {
    rawSymbols = extractScopesIndent(rawLines, maskedLines, lang);
  } else if (lang === 'text') {
    rawSymbols = [];
  } else {
    rawSymbols = extractScopesBrace(rawLines, maskedLines, lang);
  }

  const symbols = rawSymbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    line: s.line,
    endLine: s.endLine,
    parent: s.parent || '',
    breadcrumb: s.breadcrumb || s.name,
    exported: exportsSet.has(s.name),
  }));

  const chunks = buildScopeChunks(rawLines, maskedLines, rawSymbols, {
    imports,
    exports: expNames,
  });

  return {
    language: lang,
    lines: rawLines,
    symbols,
    imports,
    exports: expNames,
    chunks,
  };
}

module.exports = {
  detectLanguage,
  maskCommentsAndStrings,
  parseFile,
  extractCalls,
};
