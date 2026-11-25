# Icons

16px stroke glyphs, 1.75 stroke, round caps; one shape per status so none is told by color. Single ink, drawn with `currentColor`: beside text set CSS `color` to that status's `*-ink`, inside a chip to its `on-*` (an `<img>` cannot inherit it — inline the SVG, as `StatusChip` does).

- `check.svg` — success.
- `alert.svg` — warning (triangle).
- `cross.svg` — danger, and the start of every error message.
- `info.svg` — information.
