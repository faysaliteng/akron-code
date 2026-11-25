// Pure text helpers shared by the renderer and the headless E2E suite.
//
// Endpoints without native function calling emit tool calls inside fenced
// ```tool blocks / <tool_use> tags (see TEXT_TOOL_PROTOCOL in electron/llm.js).
// Those calls are rendered as tool cards, so the raw protocol text must be
// stripped before the assistant message is rendered as Markdown.
//
// The old two-regex version only removed *complete* fenced blocks and complete
// <tool_use> pairs. Three ways raw JSON still reached the transcript:
//   1. mid-stream — the closing ``` had not arrived yet;
//   2. a model that ignored the fence and printed the call as bare JSON;
//   3. a truncated call sliced by the output-token ceiling.
// All three are handled below.

// Walk `s` from index `at` (a "{") to the matching close brace, honouring
// strings and escapes. Returns the index just past the object, or s.length when
// the object was cut off (which is exactly the truncated-call case).
function endOfObject(s, at) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length; // unterminated — drop to the end
}

const looksLikeToolCall = (body) => {
  if (!body) return false;
  const named = /"(?:name|tool)"\s*:/.test(body);
  if (!named) return false;
  // A tool call always carries its arguments under one of these keys; a plain
  // JSON example the user asked for usually does not.
  return /"(?:arguments|input|parameters|function)"\s*:/.test(body);
};

function stripBareToolJson(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('{', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    const end = endOfObject(s, at);
    const body = s.slice(at, end);
    if (looksLikeToolCall(body)) {
      // Also swallow a trailing newline so we do not leave a blank gap.
      i = end + (s[end] === '\n' ? 1 : 0);
      continue;
    }
    out += s.slice(at, Math.max(end, at + 1));
    i = Math.max(end, at + 1);
  }
  return out;
}

export function stripToolProtocol(md) {
  let s = String(md || '');
  // 1. Complete fenced protocol blocks.
  s = s.replace(/```[ \t]*tool[^\n]*\n[\s\S]*?```/gi, '');
  // 2. Complete <tool_use> pairs, then an unterminated one while streaming.
  s = s.replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, '');
  s = s.replace(/<tool_use>[\s\S]*$/i, '');
  // 3. A generic fenced block whose body is a tool directive.
  s = s.replace(/```[a-z]*[^\n]*\n([\s\S]*?)```/gi, (m, body) => (looksLikeToolCall(body) ? '' : m));
  // 4. A ```tool fence still open at the end of a partial stream.
  s = s.replace(/```[ \t]*tool[^\n]*\n[\s\S]*$/i, '');
  // 5. Bare tool-call JSON printed without a fence (or cut off mid-object).
  s = stripBareToolJson(s);
  return s;
}

export default { stripToolProtocol };
