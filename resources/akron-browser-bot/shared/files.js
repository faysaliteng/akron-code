/** Pull readable text out of PDF and DOCX bytes. No network. */

export function extractPdfText(bytes) {
  const raw = new TextDecoder("latin1").decode(bytes);
  const parts = [];
  const pattern = /\((?:\\.|[^\\)]){0,2000}\)\s*Tj/g;
  let match;
  while ((match = pattern.exec(raw))) {
    const inner = match[0].slice(1, match[0].lastIndexOf(")"));
    const text = inner
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\([()\\])/g, "$1")
      .trim();
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

export async function extractDocxText(bytes) {
  const xml = await readZipEntry(bytes, "word/document.xml");
  if (!xml) return "";
  return xml
    .replace(/<w:p[ >]/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export async function readZipEntry(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 < bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    const data = bytes.subarray(dataStart, dataStart + compressed);
    if (name === wanted) {
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8 && typeof DecompressionStream === "function") {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new TextDecoder().decode(await new Response(stream).arrayBuffer());
      }
      return "";
    }
    offset = dataStart + compressed;
  }
  return "";
}
