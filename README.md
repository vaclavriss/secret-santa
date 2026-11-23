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

Opened outside claude.ai with no server behind it (e.g. GitHub Pages), the page renders the scene
but cannot load or save letters. For that, run your own server (below).

## Running your own server
`server/server.mjs` is a small backend with no npm dependencies (Node ≥ 22.13, uses the built-in
`node:sqlite`). It serves `index.html` and the same small API the page uses on claude.ai, so the
same file works in both places: on claude.ai it uses the claude.ai runtime, elsewhere it talks to
this server.

```sh
# Docker (recommended): data in the named volume santa-data
ADMIN_KEY=some-long-secret docker compose up -d --build     # → http://localhost:8080

# or directly with Node
ADMIN_KEY=some-long-secret node server/server.mjs            # data in server/data/
```

- **No login.** Anyone who can open the page can write, edit, bin and restore letters. The
  "Upravit dopis" button shows only for letters written from the same browser, but the server
  does not enforce that. Keep the address within the family.
- **Admin:** open the page once with `?admin=<ADMIN_KEY>`. The browser remembers it and can then
  edit any letter and delete letters from the bin for good. Without `ADMIN_KEY` nobody can.
- A deleted letter always goes to the bin first, even when deleted directly through the API.
- **Data:** `santa.db` (SQLite: collections `letters`, `trash`) and `images/` in `DATA_DIR`.
  Back up that directory (or the `santa-data` volume).
- **On the internet:** put HTTPS in front, e.g. Caddy (`santa.example.org { reverse_proxy localhost:8080 }`),
  and set `TRUST_PROXY=1` so the write rate limit sees real client IPs.
- Other settings (env): `PORT`, `HOST`, `DATA_DIR`, `MAX_DOCS` (500 per collection),
  `MAX_IMAGE_MB` (8), `MAX_IMAGES_TOTAL_MB` (1000), `WRITES_PER_MIN` (60 per IP).

API (JSON): `GET /api/me`, `GET /api/stream` (SSE snapshots of both collections),
`POST /api/{letters|trash}`, `PUT|DELETE /api/{letters|trash}/<id>`, `POST /api/images`
(raw PNG/JPEG/GIF/WebP body), `DELETE /api/images/<id>` (only when unused), `GET /_blob/<id>`.

## Editing
- Window scene: `const SCENE = "cottage"` in `index.html` (also `"jested"` and `"church"`).
- Republish by asking Claude to update the artifact at the URL above with this file.

## Sharing
Share menu on the artifact page. Writers need a claude.ai account and an email invite
as Editor; viewers can be Viewers or use a public link.
