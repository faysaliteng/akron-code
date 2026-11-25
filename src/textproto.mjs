// Pure text helpers shared by the renderer and the headless E2E suite.
//
// Endpoints without native function calling emit tool calls inside fenced
// ```tool blocks / <tool_use> tags (see TEXT_TOOL_PROTOCOL in electron/llm.js).
// Those calls are rendered as tool cards, so the raw protocol text must be
// stripped before the assistant message is rendered as Markdown.

export function stripToolProtocol(md) {
  return String(md || '')
    .replace(/```tool[^\n]*\n[\s\S]*?```/gi, '')
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, '');
}

export default { stripToolProtocol };
