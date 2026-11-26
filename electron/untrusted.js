'use strict';

function localTimezoneContext(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  let tz = 'UTC';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {}
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const pad = (n) => String(n).padStart(2, '0');
  const localIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
  return `${localIso} [${tz}]`;
}

function safeAttr(v) {
  return String(v == null ? '' : v)
    .replace(/[\r\n\0<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/**
 * Neutralize embedded `<untrusted` / `</untrusted` sequences inside third-party payloads
 * so untrusted web/MCP/webhook text can never break out of the sandbox delimiter.
 */
function neutralizeUntrustedTags(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\0/g, '')
    .replace(/<\/?\s*untrusted\b/gi, (m) => '&lt;' + m.slice(1));
}

function wrapUntrusted(content, { source = 'external', url = '', now = new Date() } = {}) {
  const body = neutralizeUntrustedTags(content);
  const srcAttr = `source="${safeAttr(source || 'external')}"`;
  const urlAttr = url ? ` url="${safeAttr(url)}"` : '';
  const tzAttr = `local_time="${safeAttr(localTimezoneContext(now))}"`;
  return `<untrusted ${srcAttr}${urlAttr} ${tzAttr}>\n${body}\n</untrusted>`;
}

module.exports = {
  localTimezoneContext,
  neutralizeUntrustedTags,
  wrapUntrusted,
};
