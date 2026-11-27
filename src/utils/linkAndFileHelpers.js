// Pure helpers for clickable file chips, bare domain linkification, and path resolution.

const FILE_EXT_RE = /\.(?:md|markdown|mdx|txt|json|ya?ml|toml|js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|sh|zsh|bash|css|scss|less|html?|xml|svg|csv|sql|env|log|ini|conf|lock)(?::(\d+))?$/i;

export function parseFileToken(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 260 || /[\r\n]/.test(s)) return null;
  if (/^(?:https?|mailto|tel|ftp|session|data):/i.test(s)) return null;
  if (s.startsWith('-') || s.startsWith('@') || s.includes('://')) return null;
  if (/\s/.test(s) && !/^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\)/.test(s)) return null;

  const lineMatch = FILE_EXT_RE.exec(s);
  if (!lineMatch) return null;
  const line = lineMatch[1] ? Number(lineMatch[1]) : null;
  const cleanPath = line ? s.slice(0, -lineMatch[1].length - 1) : s;
  if (!cleanPath || /^\.\.?$/.test(cleanPath)) return null;
  return { path: cleanPath, line };
}

export function isMarkdownPath(fp) {
  return /\.(?:md|markdown|mdx)$/i.test(String(fp || '').trim());
}

export function isHtmlPath(fp) {
  return /\.(?:html?|htm)$/i.test(String(fp || '').trim());
}

export function resolveAgainstCwd(fp, cwd) {
  let p = String(fp || '').trim();
  if (!p) return '';
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch (_) { p = p.replace(/^file:\/\//i, ''); }
  }
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('~/')) return p;
  const base = String(cwd || '').replace(/[\\/]+$/, '');
  if (!base) return p;
  const clean = p.replace(/^\.[\\/]/, '');
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base + sep + clean;
}

const BARE_DOMAIN_PATH_RE = /(^|[\s(])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|ai|app|dev|co|edu|gov|me|gg|xyz|tv|sh|cloud|tools|live|news|blog)(?:\/[^\s<>)"'`\]]*)?)/gi;

function linkifyPlainSegment(seg) {
  return seg.replace(BARE_DOMAIN_PATH_RE, (full, prefix, rawHostPath, offset, src) => {
    const preChar = offset > 0 ? src[offset - 1] : '';
    if (preChar === '/' || preChar === '@' || preChar === ':') return full;
    // Only linkify bare hosts without a path if they don't collide with filenames
    // and have at least one subdomain or explicit path segment.
    const clean = rawHostPath.replace(/[.,;:!?*_~]+$/, '');
    const trailing = rawHostPath.slice(clean.length);
    const hasPath = clean.includes('/');
    const dotCount = (clean.split('/')[0].match(/\./g) || []).length;
    if (!hasPath && dotCount < 2) return full;
    if (/\.(?:js|jsx|ts|tsx|md|json|html?|css|py|sh|svg|png|jpe?g|webp|txt|log)$/i.test(clean)) {
      return full;
    }
    return `${prefix}[${clean}](https://${clean})${trailing}`;
  });
}

/**
 * Convert bare domain/path URLs (`community.lovable.app/events`, `luma.com/lovable`)
 * in markdown prose into explicit `[text](https://...)` links while skipping
 * fenced code blocks, inline code spans, and existing markdown/HTML links.
 */
export function linkifyBareDomains(md) {
  const src = String(md || '');
  if (!src) return '';
  // Split out fenced code blocks first so we never rewrite code examples.
  const fenceParts = src.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return fenceParts.map((part, idx) => {
    if (idx % 2 === 1) return part;
    // Protect inline code spans, markdown links `[label](url)`, and HTML tags `<...>`.
    const inlineParts = part.split(/(`[^`\n]+`|\[[^\]]+\]\([^)]+\)|<[^>]+>|https?:\/\/[^\s<>"'`)\]]+)/gi);
    return inlineParts.map((chunk, j) => {
      if (j % 2 === 1) return chunk;
      return linkifyPlainSegment(chunk);
    }).join('');
  }).join('');
}

export function attachDocumentLinkRouter({ openSessionDeepLink, openDocPreview, openInIde, openPreview, openExternal }) {
  const onClick = (e) => {
    const chip = e.target && e.target.closest ? e.target.closest('[data-akron-file]') : null;
    if (chip) {
      e.preventDefault();
      e.stopPropagation();
      const fp = chip.getAttribute('data-akron-file') || '';
      const ln = Number(chip.getAttribute('data-akron-line')) || null;
      if (e.altKey) openInIde(fp, { line: ln });
      else openDocPreview(fp, ln);
      return;
    }
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = String(a.getAttribute('href') || '').trim();
    if (!href) return;
    if (href.startsWith('session://')) {
      e.preventDefault();
      openSessionDeepLink(href);
      return;
    }
    if (href.startsWith('file://')) {
      e.preventDefault();
      if (e.altKey) openInIde(href);
      else openDocPreview(href);
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      const externalOnly = a.dataset.external === 'true' || !!a.closest('.settings-modal, .prov-manual, .modal');
      if (externalOnly && !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey && openExternal) openExternal(href);
      else openPreview(href, { newTab: true });
    }
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}

