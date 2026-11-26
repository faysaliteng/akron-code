// The small part of Markdown that chat answers use, turned into HTML for a
// chat bubble. The text is escaped first, so nothing a model or a page wrote
// can become markup of its own: only the tags added here reach the page.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// Stands in for a code block while the rest of the text is formatted.
const HOLD = "\u0000";
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;

/**
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// Bold, emphasis, inline code and links inside a line. `text` is escaped.
function inline(text) {
  return text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(?<!["'>=])(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function listHtml(list) {
  const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
  return `<${list.tag}${start}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.tag}>`;
}

// One block of text (no empty line inside): its lines become paragraphs,
// lists and headings, each line by what it is, in the order written.
function blockHtml(block) {
  const html = [];
  let paragraph = [];
  let list = null;
  const closeParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) html.push(listHtml(list));
    list = null;
  };
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const heading = bullet || numbered ? null : HEADING.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      closeParagraph();
      if (list && list.tag !== tag) closeList();
      list = list || { tag, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push(bullet ? bullet[1] : numbered[2]);
    } else if (heading) {
      closeParagraph();
      closeList();
      html.push(`<h4>${heading[1]}</h4>`);
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  closeParagraph();
  closeList();
  return html.join("");
}

/**
 * @param {unknown} source Markdown as a model wrote it
 * @returns {string} HTML that is safe to put in a chat bubble
 */
export function mdToHtml(source) {
  const codeBlocks = [];
  const escaped = escapeHtml(String(source || "").split(HOLD).join(""));
  // Code is kept as written: no formatting inside it, and its empty lines do
  // not end the block.
  const held = escaped.replace(/```([\s\S]*?)```/g, (_match, code) => {
    const body = code.replace(/^[a-z0-9+#.-]*\n/i, "").replace(/^\n+|\n+$/g, "");
    codeBlocks.push(`<pre><code>${body}</code></pre>`);
    return `\n\n${HOLD}${codeBlocks.length - 1}${HOLD}\n\n`;
  });
  return inline(held)
    .split(/\n{2,}/)
    .map((block) => {
      const code = new RegExp(`^${HOLD}(\\d+)${HOLD}$`).exec(block.trim());
      return code ? codeBlocks[Number(code[1])] : blockHtml(block);
    })
    .join("");
}
