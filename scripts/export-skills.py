#!/usr/bin/env python3
"""Export every opencode skill into a single self-contained .md file.

Each output file keeps the original YAML frontmatter and body, then appends
an appendix for every auxiliary file (scripts, references, agents, evals,
assets) as a fenced code block so the skill is importable on its own with
no external references.
"""
import os
import sys

SRC = os.path.expanduser("~/.config/opencode/skill")
OUT = os.path.expanduser("~/Example Skills")
MAX_INLINE = 200_000  # bytes per auxiliary file

BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".woff",
              ".woff2", ".ttf", ".otf", ".ico", ".mp4", ".mov", ".wasm"}

LANG = {".py": "python", ".js": "javascript", ".ts": "typescript",
        ".tsx": "tsx", ".jsx": "jsx", ".json": "json", ".html": "html",
        ".css": "css", ".sh": "bash", ".yaml": "yaml", ".yml": "yaml",
        ".md": "markdown", ".txt": "text", ".xml": "xml", ".sql": "sql"}


def lang_for(path):
    return LANG.get(os.path.splitext(path)[1].lower(), "text")


def read_text(path):
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None, 0
    if os.path.splitext(path)[1].lower() in BINARY_EXT:
        return None, len(raw)
    try:
        return raw.decode("utf-8"), len(raw)
    except UnicodeDecodeError:
        return None, len(raw)


def build(skill_dir):
    name = os.path.basename(skill_dir.rstrip("/"))
    skill_md = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(skill_md):
        return None
    body, _ = read_text(skill_md)
    if body is None:
        return None

    aux = []
    for root, _dirs, files in os.walk(skill_dir):
        for f in sorted(files):
            p = os.path.join(root, f)
            rel = os.path.relpath(p, skill_dir)
            if rel == "SKILL.md":
                continue
            aux.append(rel)
    aux.sort()

    out = [body.rstrip() + "\n"]
    if aux:
        out.append("\n---\n\n## Appendix — bundled files\n")
        out.append("These files ship with the skill. They are inlined here so "
                   "the `.md` is self-contained and importable on its own.\n")
        for rel in aux:
            p = os.path.join(skill_dir, rel)
            text, size = read_text(p)
            out.append(f"\n### `{rel}`\n")
            if text is None:
                out.append(f"*(binary or non-UTF-8 file, {size} bytes — "
                           f"kept on disk in the original skill, not inlined)*\n")
                continue
            if len(text) > MAX_INLINE:
                text = text[:MAX_INLINE] + \
                    f"\n\n…truncated ({size} bytes total)…"
            fence = "```"
            while fence in text:
                fence += "`"
            out.append(f"{fence}{lang_for(rel)}\n{text.rstrip()}\n{fence}\n")
    return name, "\n".join(out), bool(aux)


def main():
    os.makedirs(OUT, exist_ok=True)
    dirs = sorted(d for d in os.listdir(SRC)
                  if os.path.isdir(os.path.join(SRC, d)))
    written, skipped, with_aux = [], [], 0
    for d in dirs:
        built = build(os.path.join(SRC, d))
        if not built:
            skipped.append(d)
            continue
        name, content, has_aux = built
        dest = os.path.join(OUT, name + ".md")
        with open(dest, "w", encoding="utf-8") as fh:
            fh.write(content)
        written.append((name, has_aux))
        if has_aux:
            with_aux += 1

    # index / README for re-import
    idx = ["# Example Skills — extracted opencode skills", "",
           f"{len(written)} skills exported from `{SRC}` as standalone "
           "Markdown files.", "",
           "Each `.md` is self-contained: original frontmatter + body, with "
           "any bundled scripts/references inlined in an appendix section.", "",
           "## Re-import", "",
           "Drop any file into a project's `.claude/skills/<name>/SKILL.md` "
           "(or point Helio Bot at this folder) and it is discovered on "
           "next start. Frontmatter `name`/`description` drive listing.", "",
           "## Skills", "",
           "| # | file | bundled files |", "|---|---|---|"]
    for i, (name, has_aux) in enumerate(written, 1):
        idx.append(f"| {i} | [`{name}.md`](./{name}.md) | "
                   f"{'yes' if has_aux else '—'} |")
    with open(os.path.join(OUT, "INDEX.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(idx) + "\n")

    print(f"exported {len(written)} skills ({with_aux} with bundled files)")
    print(f"skipped {len(skipped)}: {', '.join(skipped) if skipped else 'none'}")
    print(f"output: {OUT}")


if __name__ == "__main__":
    sys.exit(main())
