'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { defaultPosixShell } = require('./paths');

const PROFILES = {
  'workspace-write': {
    id: 'workspace-write',
    label: 'Workspace Write',
    readScope: 'policy',
    writeScope: 'workspace',
    allowNetwork: true,
    description: 'Allows reading allowed paths and writing inside the active workspace + temp dirs.',
  },
  'read-only': {
    id: 'read-only',
    label: 'Read Only',
    readScope: 'policy',
    writeScope: 'none',
    allowNetwork: true,
    description: 'Blocks all filesystem writes outside /dev/null and temp scratch.',
  },
  'strict-isolated': {
    id: 'strict-isolated',
    label: 'Strict OS Isolated',
    readScope: 'workspace',
    writeScope: 'workspace',
    allowNetwork: false,
    description: 'Enforces OS-level sandbox (Seatbelt / bwrap / PowerShell policy) with network disabled.',
  },
  'full-access': {
    id: 'full-access',
    label: 'Full Access (Unsandboxed)',
    readScope: 'all',
    writeScope: 'all',
    allowNetwork: true,
    description: 'Disables OS filesystem/network containment.',
  },
};

const DANGEROUS_PATTERNS = [
  { re: /:\(\)\s*\{\s*:\|\:\s*&\s*\}\s*;\s*:/, reason: 'Blocked fork-bomb shell pattern' },
  { re: /\bmkfs(?:\.\w+)?\s+\/dev\//i, reason: 'Blocked disk formatting command' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(?:disk|sd|nvme|hd)/i, reason: 'Blocked raw block device overwrite' },
];

function hasDestructiveRecursiveRm(sub) {
  const segs = String(sub || '').split(/\s*(?:&&|\|\||;|\||\n)\s*/);
  for (const seg of segs) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const cmdName = path.basename(tokens[0]).toLowerCase();
    if (cmdName !== 'rm') continue;
    let hasRecursive = false;
    const targets = [];
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === '--') {
        targets.push(...tokens.slice(i + 1));
        break;
      }
      if (tok.startsWith('--')) {
        if (/^--recursive$/i.test(tok)) hasRecursive = true;
      } else if (tok.startsWith('-') && tok.length > 1) {
        if (/[rR]/.test(tok.slice(1))) hasRecursive = true;
      } else {
        targets.push(tok);
      }
    }
    if (!hasRecursive) continue;
    for (const rawTarget of targets) {
      const target = unquote(rawTarget);
      if (/^(?:\/+|\/\*+|~+|~\/+|~\/\*+|\$HOME\/?|\$\{HOME\}\/?)$/i.test(target)) {
        return true;
      }
    }
  }
  return false;
}

const CREDENTIAL_PATH_RE = /(?:~\/|\$HOME\/|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|\/root\/|%USERPROFILE%[\\/])(?:\.ssh\/id_|\.aws\/credentials|\.gnupg\/|\.autobot\/secrets\.json|\.autobot\/oauth\.json|\.autobot\/oauth-mirror)/i;

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Unwrap chained shell operators and wrapper invocations (`sh -c`, `bash -c`, `env`, `sudo`, `nohup`, `powershell -Command`)
 * so sandbox checks inspect every real subcommand instead of just the outer prefix.
 */
function canonicalizeShellCommand(cmd) {
  const queue = [String(cmd || '').trim()];
  const subcommands = [];
  const seen = new Set();

  while (queue.length && subcommands.length < 32) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    subcommands.push(cur);

    // Extract $(...) and backtick substitutions
    for (const m of cur.matchAll(/\$\(([^()]{2,500})\)/g)) {
      if (m[1]) queue.push(m[1].trim());
    }
    for (const m of cur.matchAll(/`([^`]{2,500})`/g)) {
      if (m[1]) queue.push(m[1].trim());
    }

    // Split top-level command separators
    const parts = cur.split(/\s*(?:&&|\|\||;|\||\n)\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) queue.push(p);
    }

    // Unwrap shell wrappers: `sh -c "..."`, `bash -lc "..."`, `env VAR=1 ...`, `sudo ...`, `powershell -Command "..."`
    const shellWrap = /^(?:sudo\s+|nohup\s+|command\s+|time\s+|env\s+(?:[A-Za-z_]\w*=\S+\s+)*)*(?:(?:\/usr)?\/bin\/)?(?:sh|bash|zsh|dash)\s+(?:-[a-zA-Z]*c[a-zA-Z]*\s+)(.+)$/s.exec(cur);
    if (shellWrap && shellWrap[1]) {
      queue.push(unquote(shellWrap[1]));
    }
    const psWrap = /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:[^\n]*?\s)?-(?:Command|EncodedCommand|c)\s+(.+)$/is.exec(cur);
    if (psWrap && psWrap[1]) {
      queue.push(unquote(psWrap[1]));
    }
    const envStrip = /^(?:env\s+(?:[A-Za-z_]\w*=\S+\s+)+|sudo\s+(?:-[A-Za-z]+\s+)*|nohup\s+)(.+)$/.exec(cur);
    if (envStrip && envStrip[1]) {
      queue.push(envStrip[1].trim());
    }
  }

  return {
    subcommands,
    normalized: subcommands.join(' ; '),
  };
}

function checkCanonicalCommand(cmd, { profile = 'workspace-write', protectCredentials = true } = {}) {
  const parsed = canonicalizeShellCommand(cmd);
  for (const sub of parsed.subcommands) {
    if (hasDestructiveRecursiveRm(sub)) {
      return { ok: false, reason: 'Blocked destructive recursive delete targeting root or home directory', subcommand: sub };
    }
    for (const rule of DANGEROUS_PATTERNS) {
      if (rule.re.test(sub)) {
        return { ok: false, reason: rule.reason, subcommand: sub };
      }
    }
    if (protectCredentials && profile !== 'full-access' && CREDENTIAL_PATH_RE.test(sub)) {
      return {
        ok: false,
        reason: 'Blocked shell access to sensitive credential store path inside command chain',
        subcommand: sub,
      };
    }
  }
  return { ok: true, subcommands: parsed.subcommands };
}

function sbEscape(p) {
  return String(p || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildSeatbeltProfile({
  cwd = process.cwd(),
  profile = 'workspace-write',
  denyRead = [],
  denyWrite = [],
  allowNetwork = true,
} = {}) {
  const absCwd = path.resolve(cwd || process.cwd());
  const home = os.homedir();
  const lines = [
    '(version 1)',
    '(allow default)',
  ];
  for (const r of denyRead || []) {
    lines.push(`(deny file-read* (subpath "${sbEscape(r)}"))`);
  }
  if (profile === 'read-only') {
    lines.push('(deny file-write*)');
    lines.push('(allow file-write* (literal "/dev/null") (subpath "/tmp") (subpath "/private/tmp"))');
  } else if (profile === 'workspace-write' || profile === 'strict-isolated') {
    lines.push('(deny file-write*)');
    const writable = [
      absCwd,
      path.join(home, '.autobot'),
      '/tmp',
      '/private/tmp',
      '/var/folders',
      '/private/var/folders',
      os.tmpdir(),
    ];
    for (const w of writable) {
      lines.push(`(allow file-write* (subpath "${sbEscape(path.resolve(w))}"))`);
    }
    lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))');
    // Seatbelt evaluates rules in order (last-match-wins): keep critical config/credential guards after cwd/.autobot allows.
    lines.push(`(deny file-write* (subpath "${sbEscape(path.join(absCwd, '.git', 'hooks'))}"))`);
    lines.push(`(deny file-write* (literal "${sbEscape(path.join(absCwd, '.git', 'config'))}"))`);
    lines.push(`(deny file-write* (literal "${sbEscape(path.join(absCwd, '.claude', 'settings.json'))}"))`);
    lines.push(`(deny file-write* (literal "${sbEscape(path.join(home, '.autobot', 'secrets.json'))}"))`);
    lines.push(`(deny file-write* (literal "${sbEscape(path.join(home, '.autobot', 'oauth.json'))}"))`);
    lines.push(`(deny file-write* (subpath "${sbEscape(path.join(home, '.autobot', 'oauth-mirror'))}"))`);
  }
  for (const w of denyWrite || []) {
    lines.push(`(deny file-write* (subpath "${sbEscape(w)}"))`);
  }
  if (!allowNetwork || profile === 'strict-isolated') {
    lines.push('(deny network*)');
  }
  return lines.join('\n');
}

function detectCapabilities(platform = process.platform) {
  if (platform === 'darwin') {
    const seatbelt = fs.existsSync('/usr/bin/sandbox-exec');
    return { platform, backend: seatbelt ? 'seatbelt' : 'policy-only', available: seatbelt };
  }
  if (platform === 'linux') {
    let bwrap = false;
    try {
      const out = execFileSync('which', ['bwrap'], { encoding: 'utf8', timeout: 1500 });
      bwrap = !!String(out || '').trim();
    } catch (_) {}
    return { platform, backend: bwrap ? 'bubblewrap' : 'policy-only', available: bwrap };
  }
  if (platform === 'win32') {
    return { platform, backend: 'powershell-policy', available: true };
  }
  return { platform, backend: 'policy-only', available: false };
}

function wrapWithProfile(cmd, {
  cwd = process.cwd(),
  profile = 'workspace-write',
  denyRead = [],
  denyWrite = [],
  allowNetwork = true,
  platform = process.platform,
} = {}) {
  const prof = PROFILES[profile] ? profile : 'workspace-write';
  const netAllowed = prof === 'strict-isolated' ? false : !!allowNetwork;

  if (prof === 'full-access') {
    return {
      file: platform === 'win32' ? 'powershell.exe' : defaultPosixShell(),
      args: platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(cmd)] : ['-c', String(cmd)],
      sandboxed: false,
      backend: 'none',
      profile: prof,
    };
  }

  if (platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    const sbProfile = buildSeatbeltProfile({ cwd, profile: prof, denyRead, denyWrite, allowNetwork: netAllowed });
    const sh = defaultPosixShell();
    return {
      file: '/usr/bin/sandbox-exec',
      args: ['-p', sbProfile, sh, '-c', String(cmd)],
      sandboxed: true,
      backend: 'seatbelt',
      profile: prof,
      seatbeltProfile: sbProfile,
    };
  }

  if (platform === 'linux') {
    const caps = detectCapabilities('linux');
    if (caps.available) {
      const absCwd = path.resolve(cwd || process.cwd());
      const args = [
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        '--tmpfs', '/tmp',
      ];
      if (prof !== 'read-only') {
        args.push('--bind', absCwd, absCwd);
        for (const roTarget of [
          path.join(absCwd, '.git', 'hooks'),
          path.join(absCwd, '.git', 'config'),
          path.join(absCwd, '.claude', 'settings.json'),
        ]) {
          if (fs.existsSync(roTarget)) args.push('--ro-bind', roTarget, roTarget);
        }
      }
      if (!netAllowed) args.push('--unshare-net');
      args.push(defaultPosixShell(), '-c', String(cmd));
      return {
        file: 'bwrap',
        args,
        sandboxed: true,
        backend: 'bubblewrap',
        profile: prof,
      };
    }
  }

  if (platform === 'win32') {
    const absCwd = path.resolve(cwd || process.cwd());
    const wrapped = `$ErrorActionPreference='Stop'; Set-Location -LiteralPath ${JSON.stringify(absCwd)}; ${String(cmd)}`;
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapped],
      sandboxed: false,
      backend: 'powershell-policy',
      profile: prof,
    };
  }

  return {
    file: defaultPosixShell(),
    args: ['-c', String(cmd)],
    sandboxed: false,
    backend: 'policy-only',
    profile: prof,
  };
}

module.exports = {
  PROFILES,
  canonicalizeShellCommand,
  checkCanonicalCommand,
  buildSeatbeltProfile,
  detectCapabilities,
  wrapWithProfile,
};
