# Seazar — design system

Seazar is the design system of Seazar Ferries, a harbor ferry company, for its passenger information service: departure boards, delay notices, tickets. People read it standing on a quay in sun or rain, often on an old phone, some with low vision, some color-blind. The brand is ink on paper with three signal colors and a gray, and nothing in it depends on telling those colors apart.

## Voice

- Do: say what happened and what to do next ("The 14:05 is canceled. The 14:35 has space.").
- Don't: apologize at length, use color words as meaning ("services in red"), or rely on an icon without its word.

## Using this system

Colors are semantic tokens with three themes — Light, Dark and High contrast; the first is the fallback. Every text token's note names the grounds it is legible on, and those pairs are guaranteed below. `accent` is the ink itself (dark on light, light on dark), so the primary button flips with the theme and its label is always `on-accent`. Links are set in `accent` and always underlined: with a monochrome accent the underline, not the color, is what marks them. Type is one sans family in four steps, with a mono for code; body is 16px and nothing is under 13px. Components live in `components/bundle.js` as `window.Seazar`, expect React 18 on the page, and paint only with tokens — `bundle.css` holds no color values, only `var(--token)`, the `transparent` focus outline and a `currentColor` fallback for the ring.

## Accessibility

- Legible pairs: `ink`, `ink-muted` and every `*-ink` token hold at least 4.5:1 on `surface` and `surface-raised` in Light and Dark, and at least 7:1 in High contrast; every `on-*` token holds the same on its fill. `border` and the focus ring hold at least 3:1 on both surfaces, 4.5:1 in High contrast. `line` is decoration and guarantees nothing — never make it the only edge of a control.
- Focus: every interactive element shows the `focus-ring` token on `:focus-visible` — a 2px gap in the page color, then 2px of `focus` — never the bare browser outline and never nothing.
- Never color alone: a status is a chip that prints the word with its icon (check, triangle, cross, "i" — four different shapes), or text that starts with that icon. Color-blind readers can tell the statuses apart in every theme: the four chip fills stay clearly distinct under red–green (protan, deutan) and blue–yellow (tritan) color blindness in Light, Dark and High contrast, and the word and icon say it regardless. Two pairs are close as TEXT, and for them the icon and the word, not the hue, are what differ: `warning-ink` (orange) and `danger-ink` (vermillion) look alike to red–green color-blind readers in every theme, most of all in Dark, where `danger-ink` already sits at the contrast floor, fainter than `warning-ink`; and `success-ink` (blue) and `info-ink` (gray) are a hue and a gray of about equal weight for everyone — information carries no signal by design, and the "i" marks it.
- Status colors: the chip fills are blue, yellow and vermillion from Okabe & Ito's Color Universal Design palette, plus a plain gray for information, chosen so success and danger stay apart for protan, deutan and tritan readers; High contrast darkens the blue and the vermillion fills so their white labels reach 7:1, which leaves those two fills equal in lightness there (they are only 1.3:1 apart in Light and Dark), so a reader who sees no hue at all tells the success and danger chips apart by the word and the icon alone. The `*-ink` text variants are that palette's blue, orange and vermillion moved only in lightness, to the floor wherever the raw hue misses it (Dark keeps the orange as is) — except `danger-ink`, which in Light and High contrast runs deliberately heavier than `warning-ink`. Yellow cannot make legible text, so warning text is the orange. Every status chip is ringed with its `*-ink`, so even the yellow chip has an edge on a white page; the neutral chip uses `border`.
- High contrast: an added theme, not a re-tint — flat surfaces separated by `border`, no shadows, text at 7:1 or more.
- Targets and motion: controls are `control` (40px) tall and nothing clickable is under `target-min` (24px) in either direction; nothing in this system animates.

## Iconography

Four status glyphs (`assets/Icons/`): 16px, 1.75 stroke, round caps, single ink. Beside text they take that text's `*-ink`; inside a chip, its `on-*`. The logo (`assets/Logos/seazar-mark.svg`) is a single-ink bollard in `ink`.
