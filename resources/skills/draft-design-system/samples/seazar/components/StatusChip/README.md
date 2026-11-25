# StatusChip

A status as one or two words: “On time”, “Delayed”, “Canceled”, “Notice”. You provide the word as children and a `tone` (`success`, `warning`, `danger`, `info`, or `neutral` for plain facts like “Platform 4”). The chip draws the tone's glyph before the word — check, triangle, cross, “i”, four different shapes — so it reads without color; the glyph is hidden from screen readers because the word already says it. Never an empty chip, never a glyph alone, never a tone that contradicts the word. Not interactive: no focus, no click.
