#!/usr/bin/env python3
"""Rebrand every user-facing 'Example'/'claude' to 'Example'/'example' while
preserving functional identifiers (paths, env vars, model ids, module names,
real service hosts).

Protected literals are swapped for sentinels, the remaining brand words are
rewritten, then the sentinels are restored verbatim.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXT = {".js", ".jsx", ".json", ".css", ".md", ".html", ".cjs", ".py", ".txt"}
SKIP_DIRS = {"node_modules", "dist", "release", ".git", "build",
             "Electron.app", ".vite"}
# stray / stale files that are not part of the product surface
SKIP_FILES = {"browser.js", "MainWindowPage-DSoZMLIv.css", "scripts/rebrand.py"}

# Longest first. These must survive untouched.
PROTECT = [
    "anthropic.claude-sonnet-4-5",
    "com.anthropic.claudefordesktop",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SKILLS_DIR",
    "CLAUDE.local.md",
    "claude-ai-import",
    "claude-code-guide",
    "claude-in-chrome",
    "ClaudeDesktop",
    "claude-desktop",
    "Claude.app",
    "claudeconfig",
    "claudeDir",
    "claude-api",
    "claude-sonnet",
    "claude-opus",
    "claude-haiku",
    "claude-3",
    "claude-2",
    ".claude.json",
    ".claude",
    "CLAUDE.md",
    "claude.ai",
    "claude:",
    "'claude'",
    '"claude"',
    "--claude-",
    "claude_",
]

SENT = "@@!P{}!@@"


def transform(text):
    for i, tok in enumerate(PROTECT):
        text = text.replace(tok, SENT.format(i))
    # Built from fragments so this file is never rewritten by its own run.
    _c = "C" + "laude"
    _l = "c" + "laude"
    _u = "C" + "LAUDE"
    text = text.replace(_c, "Example")
    text = text.replace(_l, "example")
    text = text.replace(_u, "EXAMPLE")
    for i, tok in reversed(list(enumerate(PROTECT))):
        text = text.replace(SENT.format(i), tok)
    return text


def main(apply=False):
    changed = []
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if os.path.splitext(f)[1].lower() not in EXT:
                continue
            p = os.path.join(base, f)
            rel = os.path.relpath(p, ROOT)
            if rel in SKIP_FILES:
                continue
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    src = fh.read()
            except (UnicodeDecodeError, OSError):
                continue
            out = transform(src)
            if out != src:
                n = sum(1 for a, b in zip(src.splitlines(), out.splitlines())
                        if a != b)
                changed.append((os.path.relpath(p, ROOT), n))
                if apply:
                    with open(p, "w", encoding="utf-8") as fh:
                        fh.write(out)
    changed.sort(key=lambda x: -x[1])
    for path, n in changed:
        print(f"{n:5d}  {path}")
    print(f"\n{len(changed)} files change" + ("d" if apply else " (dry run)"))
    return 0


if __name__ == "__main__":
    sys.exit(main(apply="--apply" in sys.argv))
