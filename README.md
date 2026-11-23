# secret-santa
Secret santa webpage for my familia

**Live page:** https://claude.ai/artifact/2tgcowqLC1nwsCksXtL532 ("Dopisy na parapetu")

A single-file page (`index.html`) published as a claude.ai Artifact. Family members write
letters to their Tajný Ježíšek (Secret Santa); the letters lie as envelopes on a pixel-art
windowsill on a snowy evening.

## Features
- Pixel-art night scene drawn on a canvas: snowfall, moon, shooting stars, log cottage with
  chimney smoke, frozen pond, fairy lights, advent wreath (candles lit by the real date),
  books, a mug of tea and a sleeping cat that breathes.
- Each envelope is unique (paper colour, pattern, wax seal, stamp, twine), derived from the
  letter id.
- A letter = text + signature, optionally one picture (drawn in the page or a photo).
- Deleted letters go to a bin and can be restored; only the owner can delete permanently.

## Where the data lives
Not in this repo. Letters and pictures are stored with the artifact on claude.ai via its
runtime capabilities (`db`, `user`, `assets`):
- `letters/<id>`: `{ from, wish, image?, author, createdAt, updatedAt? }`
- `trash/<id>`: the same plus `{ deletedAt, deletedBy }`
- pictures: artifact assets, referenced by `image` id (`/_blob/<id>`)

Opened outside claude.ai, the page renders the scene but cannot load or save letters.

## Editing
- Window scene: `const SCENE = "cottage"` in `index.html` (also `"jested"` and `"church"`).
- Republish by asking Claude to update the artifact at the URL above with this file.

## Sharing
Share menu on the artifact page. Writers need a claude.ai account and an email invite
as Editor; viewers can be Viewers or use a public link.
