# FadeLandCatalog

A curated catalog of images, audio, and asset packs that the FadeLand Playground
browses through its **Catalog** tab. The catalog itself doesn't redistribute
content — it's primarily a **registry of approved remote URLs**, plus
catalog-hosted thumbnails and metadata. Users preview entries in the Playground
without copying them locally; "Import" pulls bytes from the remote into the
user's OPFS workspace, where the existing asset pipeline (PNG→XNB, audio→XNB)
takes over.

```
FadeLandCatalog/
├── entries/                source of truth — one JSON per catalog row
│   ├── images/
│   ├── audio/
│   └── packs/
├── assets/                 raw source bytes (only used for "source"-mode entries)
├── scripts/
│   ├── build.mjs           entries/* → dist/* (downloads remotes into .cache/)
│   ├── validate.mjs        lints entries before build (run by CI)
│   └── lib/
│       ├── entries.mjs     entry loader
│       ├── fetch-cache.mjs HTTP fetch w/ on-disk cache (.cache/)
│       ├── process-pack.mjs  zip → file manifest
│       └── glob.mjs        small glob → regex matcher
├── .id-registry.json       slug → integer ID assignments (NEVER hand-edit)
├── .cache/                 build-time download cache (gitignored)
└── dist/                   generated artifacts served by jsDelivr (committed)
    ├── manifest.json
    ├── index/              tags, trigrams, facets, id-map
    ├── shards/             entry summaries, bucketed by id%16
    ├── packs/              per-pack file manifests (lazy-loaded)
    ├── blobs/              bytes for source-mode entries (rare)
    └── thumbs/             grid-view preview images
```

## Three kinds of entry

### 1. Single asset, remote (the common case)

```json
{
  "slug": "kenney-tile-grass",
  "name": "Grass Tile",
  "remote": "https://example.cdn/grass.png",
  "tags": ["tile", "platformer"],
  "license": "CC0-1.0",
  "attribution": "Kenney.nl"
}
```

Build downloads the URL once, hashes it, decodes dimensions, generates a
thumbnail. The remote URL is recorded in the shard — Playground fetches the
actual bytes from the remote host at preview/import time.

### 2. Single asset, local source (rare)

```json
{
  "slug": "fadeland-logo",
  "source": "images/fadeland-logo.png",
  ...
}
```

Bytes live in `assets/images/...` in this repo, get copied to
`dist/blobs/<sha>.png`, and are served via jsDelivr. Use sparingly.

### 3. Pack — a zip with selectable contents

```json
{
  "kind": "pack",
  "slug": "kenney-pattern-pack-pixel",
  "name": "Pattern Pack Pixel",
  "description": "...",
  "remote": "https://kenney.nl/.../kenney_pattern-pack-pixel.zip",
  "expectedSha256": "abc...",                       // optional; build verifies
  "preview": "https://kenney.nl/.../preview.png",   // grid tile image (URL or local path)
  "include": ["**/*.png"],                          // default: all supported assets
  "exclude": ["**/license.txt", "**/Preview.png"],
  "tags": ["pattern", "pixel", "kenney"],
  "license": "CC0-1.0",
  "attribution": "Kenney.nl",
  "homepage": "https://kenney.nl/assets/pattern-pack-pixel"
}
```

Pack entries are **one catalog row** that represents the bundle. The build:

1. Downloads the zip (cached in `.cache/`), verifies sha if `expectedSha256` is set.
2. Walks zip contents, applies `include`/`exclude` globs.
3. For each surviving file: hashes, decodes width/height or duration, records mime.
4. Writes the file list to `dist/packs/<zipSha>.v{version}.json`.
5. Downloads the `preview` image, generates a catalog-hosted thumbnail.
6. Writes the pack summary (file count, total bytes, thumb URL) into the shard.

The Playground loads the pack manifest **lazily** — only when a user clicks
into the pack — so the grid view stays cheap. On import, the user picks which
files inside the zip they want; the Playground fetches the zip, caches it in
IndexedDB by sha, extracts the chosen files, and writes them to OPFS.

Glob notes: case-sensitive POSIX-style. Use `**` for recursive, `*` for a path
segment. If a pack has both `Preview.png` and `preview.png`, list both.

## Adding a new entry

1. Pick the kind (asset or pack) and the mode (remote or source).
2. Drop a JSON in `entries/{images,audio,packs}/`.
3. If using `source`, drop the bytes in `assets/{images,audio,packs}/`.
4. Run `npm run validate` (fast, no network).
5. Run `npm run build` (fetches remotes into `.cache/`, emits `dist/`).
6. Commit `entries/`, any new `assets/`, `.id-registry.json`, and `dist/`.

## CORS handling — automatic

The Playground fetches remote bytes from a browser context, which means the
remote host must send `Access-Control-Allow-Origin` headers — and most
game-asset hosts (Kenney, OpenGameArt, itch.io) don't.

The build handles this transparently: when a remote URL returns no CORS header,
the build **mirrors the bytes into `dist/blobs/<sha>.<ext>`** and rewrites the
entry's URL to point at the catalog-hosted copy (served by jsDelivr, which is
CORS-safe). Every URL shipped in the catalog is CORS-safe by construction —
the Playground never has to disable Import.

Each entry's `hosting` field records what happened:

- `remote` — upstream URL is CORS-safe, fetched directly
- `mirrored` — upstream wasn't CORS-safe; bytes re-hosted in `dist/blobs/`. The
  original upstream URL is preserved in `originalUrl` for attribution display.
- `local` — `source`-mode entry, bytes always lived in this repo

**License gate.** Mirroring is redistribution. The build refuses to mirror
unless the entry's license is in the allowlist (CC0, CC-BY, CC-BY-SA, MIT,
Apache-2.0, BSD, Unlicense, WTFPL, public-domain). For other licenses,
the build fails with a clear error — you'll need a CORS-friendly host or a
license review.

**Repo size.** Mirroring grows the repo by the size of CORS-unsafe content.
jsDelivr caps at 50 MB per file. Most assets and packs are well under that.
If you outgrow it, swap mirroring for a real CDN (e.g. Cloudflare Worker
fronting R2) — the catalog's URL field is opaque to the Playground, so the
swap is local to the build script.

## Why the indices look the way they do

The Playground does search **client-side** against static JSON. To keep that
cheap, the build emits an inverted index:

- `index/tags.json` — `tag → [int IDs]`. Set intersection answers tag queries.
- `index/trigrams.json` — `3-char substring → [int IDs]`. Approximates fuzzy
  text search by intersecting query trigrams.
- `index/facets.json` — counts per facet (dimension, mime, license, kind,
  hosting). Used to render filter chips before any search has run.
- `index/id-map.json` — `int ID → { shard, sha256, mime, name, kind }`. Lets
  the client resolve a result set to shard locations.
- `shards/{xx}.json` — entry summary data, bucketed by `id % 16`.
- `packs/<zipSha>.json` — per-pack file manifests, fetched only when the user
  clicks into a pack.

Integer IDs (instead of slugs) make posting lists ~10× smaller and set
intersection trivially fast. The version suffix on every dist file
(`tags.v{hash}.json`) means each can be served with `Cache-Control: immutable`
— bumping the version in `manifest.json` is how clients learn to invalidate.

## Publishing

After `npm run build`, commit everything and push to `main`. The Playground
references files via jsDelivr:

```
https://cdn.jsdelivr.net/gh/{owner}/FadeLandCatalog@main/dist/manifest.json
```

For deterministic builds across releases, pin to a tag:

```
https://cdn.jsdelivr.net/gh/{owner}/FadeLandCatalog@v1.4.0/dist/manifest.json
```

## CI

`npm run validate` (no side effects, no network) runs on every PR. Checks:

- Every entry has the required fields and valid types.
- Exactly one of `source` or `remote` per entry.
- `source` paths resolve to real files under `assets/`.
- Slugs are unique and well-formed.
- Tags are lowercase + hyphen.
- Pack entries have a `preview` (URL or local path).

CI also runs `npm run build` and fails the PR if `dist/` or
`.id-registry.json` end up dirty — preventing contributors from forgetting to
rebuild.
