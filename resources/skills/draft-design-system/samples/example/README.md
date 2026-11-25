# Ember — design system

Ember is a small-batch coffee roaster. The brand is warm, direct, and unhurried: short sentences, no exclamation marks, lowercase product names ("ember filter one").

## Voice

- Do: speak plainly, lead with the bean and the roast.
- Don't: superlatives, urgency, emoji.

## Using this system

Colors are semantic tokens (`surface`, `ink`, `ember`) with a light and a dark theme; the first theme is the fallback. Each text token's note names the surfaces it is legible on in both themes; text on an ember fill is `on-ember`, never white. Keyboard focus is the `focus-ring` token: a 2px gap in the page colour, then a solid 2px ember ring. Type is one sans family in four steps. The logo and icons are single-ink SVGs drawn with `currentColor`, so they recolor with CSS `color`. Components live in `components/bundle.js` as `window.Ember` and expect React 18 on the page.
