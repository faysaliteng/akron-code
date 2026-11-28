'use strict';
/**
 * REA (reverse-engineering MCP, 263 tools) stays installed and connected, but
 * dormant: its tools are only put in front of a model when the conversation
 * asks for it — the user names REA, or asks for the kind of work only REA does.
 *
 * Only what the *user* typed counts. System prompts and AGENTS.md describe REA
 * on every turn, so matching them would switch it on for everything.
 */

// "rea", "REA", "rea-agents", or a direct mcp__rea__<tool> reference — never the
// "rea" inside another word (area, real, read, create).
const REA_MENTION_RE = /(?:^|[^a-z0-9_])rea(?![a-z0-9_])|mcp__rea__/i;
const REA_TASK_RE = /\b(reverse[\s-]?engineer|decompile|disassembl|ghidra|radare|rizin|macho|apktool|frida|firmware)\b/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * @param {string|Array<{role:string, content:any}>} input a prompt, or the
 *   conversation's messages (only `user` turns are read; once the user has asked
 *   for REA it stays available for the rest of that conversation).
 */
function isReaRequested(input) {
  let text = '';
  if (typeof input === 'string') {
    text = input;
  } else if (Array.isArray(input)) {
    text = input
      .filter((m) => m && m.role === 'user')
      .map((m) => textOf(m.content))
      .join('\n');
  }
  if (!text) return false;
  return REA_MENTION_RE.test(text) || REA_TASK_RE.test(text);
}

module.exports = { isReaRequested, REA_MENTION_RE, REA_TASK_RE };
