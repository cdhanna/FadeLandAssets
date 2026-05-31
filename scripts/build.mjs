// Reads entries/* and emits a fully-indexed dist/ tree for jsDelivr.
//
// Three entry kinds:
//   asset + remote → URL to single asset bytes hosted elsewhere
//   asset + source → single asset bytes in this repo (rare; only for catalog-curated content)
//   pack  + remote → URL to a zip; one catalog row representing the bundle
//   pack  + source → local zip (rarely used outside testing)
//
// dist/ layout produced:
//   manifest.json                  root index — version + checksums
//   index/tags.v{N}.json           tag → [int IDs] inverted index
//   index/trigrams.v{N}.json       3-char substring → [int IDs] for fuzzy text
//   index/facets.v{N}.json         count summaries per facet
//   index/id-map.v{N}.json         int ID → { shard, sha256, mime, name, kind }
//   shards/{xx}.v{N}.json          full entry data (summary for packs), bucketed by id%16
//   packs/<zipSha>.v{N}.json       per-pack file manifests, lazy-loaded by playground
//   blobs/<sha256>.<ext>           bytes for asset+source entries only
//   thumbs/<sha256>.webp           ~256px thumbnails for grid preview

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { parseBuffer as parseAudioMetadataBuffer } from 'music-metadata';
import { loadEntries, entryMode } from './lib/entries.mjs';
import { fetchWithCache } from './lib/fetch-cache.mjs';
import { processPackZip } from './lib/process-pack.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = join(REPO_ROOT, 'assets');
const DIST_DIR = join(REPO_ROOT, 'dist');
const CACHE_DIR = join(REPO_ROOT, '.cache');
const REGISTRY_PATH = join(REPO_ROOT, '.id-registry.json');

const SHARD_COUNT = 16;
const THUMB_MAX_DIM = 256;
const TRIGRAM_MIN_LEN = 3;
const SCHEMA = 1;

// Licenses that permit catalog re-hosting (mirroring CORS-unsafe content into
// dist/blobs/ so jsDelivr can serve it with CORS). Build refuses to mirror
// anything with a license outside this set — the entry will fail the build.
const MIRROR_OK_LICENSES = new Set([
  'CC0-1.0',
  'CC-BY-3.0', 'CC-BY-4.0',
  'CC-BY-SA-3.0', 'CC-BY-SA-4.0',
  'MIT', 'Apache-2.0',
  'BSD-2-Clause', 'BSD-3-Clause',
  'Unlicense', 'WTFPL',
  'public-domain',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac']);

const MIME_FOR_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.zip': 'application/zip',
};

const EXT_FOR_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/bmp': '.bmp', 'image/webp': '.webp',
  'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
  'audio/ogg': '.ogg', 'audio/flac': '.flac',
  'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
};

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// --- ID registry ------------------------------------------------------------

async function loadRegistry() {
  try {
    return JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { nextId: 1, ids: {} };
  }
}

async function saveRegistry(reg) {
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n');
}

function assignIds(entries, registry) {
  for (const entry of entries) {
    if (registry.ids[entry.slug] === undefined) {
      registry.ids[entry.slug] = registry.nextId++;
    }
    entry.id = registry.ids[entry.slug];
  }
}

// --- Byte sourcing (asset bytes OR zip bytes) -------------------------------

function pickExt({ explicit, contentType, urlPath }) {
  if (explicit) return explicit.toLowerCase();
  if (contentType) {
    const ct = contentType.split(';')[0].trim().toLowerCase();
    if (EXT_FOR_MIME[ct]) return EXT_FOR_MIME[ct];
  }
  if (urlPath) {
    const e = extname(urlPath).toLowerCase();
    if (MIME_FOR_EXT[e]) return e;
  }
  return null;
}

async function fetchBytes(entry, urlOrPath, mode) {
  if (mode === 'source') {
    const sourcePath = join(ASSETS_DIR, urlOrPath);
    const bytes = await readFile(sourcePath);
    return {
      bytes,
      ext: extname(sourcePath).toLowerCase(),
      sha256: sha256Hex(bytes),
      cached: false,
      corsSafe: null,
      remoteMeta: null,
    };
  }
  if (mode === 'remote') {
    const meta = await fetchWithCache(urlOrPath, CACHE_DIR);
    const url = new URL(urlOrPath);
    const ext = pickExt({
      explicit: entry?.ext,
      contentType: meta.contentType,
      urlPath: url.pathname,
    });
    return {
      bytes: meta.bytes,
      ext,
      sha256: meta.sha256,
      cached: meta.cached,
      corsSafe: meta.corsSafe,
      remoteMeta: meta,
    };
  }
  throw new Error('unreachable: mode must be source or remote');
}

// --- Single-asset metadata --------------------------------------------------

async function processImageBytes(bytes) {
  const meta = await sharp(bytes).metadata();
  return {
    width: meta.width,
    height: meta.height,
    hasAlpha: meta.hasAlpha ?? false,
    channels: meta.channels,
  };
}

async function processAudioBytes(bytes, mime) {
  const meta = await parseAudioMetadataBuffer(bytes, { mimeType: mime });
  return {
    durationSec: meta.format.duration ?? null,
    sampleRate: meta.format.sampleRate ?? null,
    channels: meta.format.numberOfChannels ?? null,
    bitsPerSample: meta.format.bitsPerSample ?? null,
  };
}

function derivedTagsForImage(info) {
  const tags = [`${info.width}x${info.height}`, 'image'];
  if (info.hasAlpha) tags.push('transparent');
  if (info.width === info.height) tags.push('square');
  if (info.width <= 64 && info.height <= 64) tags.push('icon');
  return tags;
}

function derivedTagsForAudio(info) {
  const tags = ['audio'];
  if (info.channels === 1) tags.push('mono');
  else if (info.channels === 2) tags.push('stereo');
  if (info.durationSec !== null && info.durationSec < 2) tags.push('sfx');
  return tags;
}

function derivedTagsForPack(packSummary) {
  const tags = ['pack'];
  if (packSummary.images > 0) tags.push('images');
  if (packSummary.audio > 0) tags.push('audio');
  return tags;
}

// --- Index builders ---------------------------------------------------------

function buildTagIndex(entries) {
  const tags = {};
  for (const e of entries) for (const t of e.allTags) (tags[t] ??= []).push(e.id);
  for (const t of Object.keys(tags)) tags[t].sort((a, b) => a - b);
  return { schema: SCHEMA, tags };
}

function trigramsOf(text) {
  const t = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const out = new Set();
  for (const token of t.split(/\s+/)) {
    if (token.length < TRIGRAM_MIN_LEN) continue;
    for (let i = 0; i <= token.length - TRIGRAM_MIN_LEN; i++) {
      out.add(token.slice(i, i + TRIGRAM_MIN_LEN));
    }
  }
  return out;
}

function buildTrigramIndex(entries) {
  const trigrams = {};
  for (const e of entries) {
    const searchable = [e.name, e.slug, ...(e.tags ?? []), e.description ?? '']
      .filter(Boolean).join(' ');
    for (const tri of trigramsOf(searchable)) (trigrams[tri] ??= []).push(e.id);
  }
  for (const tri of Object.keys(trigrams)) trigrams[tri].sort((a, b) => a - b);
  return { schema: SCHEMA, trigrams };
}

function buildFacets(entries) {
  const dimensions = {}, mime = {}, license = {}, hosting = {}, kind = {};
  for (const e of entries) {
    if (e.width && e.height) {
      const key = `${e.width}x${e.height}`;
      dimensions[key] = (dimensions[key] ?? 0) + 1;
    }
    if (e.mime) mime[e.mime] = (mime[e.mime] ?? 0) + 1;
    if (e.license) license[e.license] = (license[e.license] ?? 0) + 1;
    hosting[e.hosting] = (hosting[e.hosting] ?? 0) + 1;
    kind[e.kind] = (kind[e.kind] ?? 0) + 1;
  }
  return { schema: SCHEMA, dimensions, mime, license, hosting, kind };
}

function shardKey(id) {
  return (id % SHARD_COUNT).toString(16).padStart(2, '0');
}

function buildIdMap(entries) {
  const ids = {};
  for (const e of entries) {
    ids[e.id] = {
      shard: shardKey(e.id),
      sha256: e.sha256,
      mime: e.mime,
      name: e.name,
      kind: e.kind,
    };
  }
  return { schema: SCHEMA, ids };
}

function buildShards(entries) {
  const shards = {};
  for (let i = 0; i < SHARD_COUNT; i++) {
    shards[i.toString(16).padStart(2, '0')] = { schema: SCHEMA, entries: {} };
  }
  for (const e of entries) {
    const base = {
      id: e.id,
      slug: e.slug,
      name: e.name,
      kind: e.kind,
      description: e.description ?? null,
      mime: e.mime,
      bytes: e.byteLength,
      hosting: e.hosting,                            // 'remote' | 'local' | 'mirrored'
      url: e.url,                                    // always CORS-safe at runtime
      originalUrl: e.originalUrl ?? null,            // upstream URL when hosting='mirrored'
      sha256: e.sha256,
      thumb: e.thumbSha ? `thumbs/${e.thumbSha}.webp` : null,
      tags: e.allTags,
      license: e.license,
      attribution: e.attribution ?? null,
      homepage: e.homepage ?? null,
      added: e.added ?? null,
    };
    if (e.kind === 'asset') {
      Object.assign(base, {
        width: e.width ?? null,
        height: e.height ?? null,
        durationSec: e.durationSec ?? null,
        sampleRate: e.sampleRate ?? null,
        channels: e.channels ?? null,
      });
    } else if (e.kind === 'pack') {
      Object.assign(base, {
        packManifest: e.packManifestPath,             // dist-relative path to file list
        fileCount: e.packSummary.fileCount,
        totalExtractedBytes: e.packSummary.totalExtractedBytes,
        imageCount: e.packSummary.images,
        audioCount: e.packSummary.audio,
      });
    }
    shards[shardKey(e.id)].entries[e.id] = base;
  }
  return shards;
}

// --- Output -----------------------------------------------------------------

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(data);
  await writeFile(path, text);
  return sha256Hex(Buffer.from(text));
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function writeBlobFromBytes(bytes, sha, ext) {
  const dest = join(DIST_DIR, 'blobs', `${sha}${ext}`);
  if (await fileExists(dest)) return;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
}

async function writeThumbForImage(sourceBytes) {
  const thumbBytes = await sharp(sourceBytes)
    .resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  const thumbSha = sha256Hex(thumbBytes);
  const dest = join(DIST_DIR, 'thumbs', `${thumbSha}.webp`);
  if (!await fileExists(dest)) {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, thumbBytes);
  }
  return thumbSha;
}

// --- Per-entry processing ---------------------------------------------------

async function processAssetEntry(e) {
  const mode = entryMode(e);
  const ref = mode === 'remote' ? e.remote : e.source;
  const fetched = await fetchBytes(e, ref, mode);
  let ext = fetched.ext;
  if (!ext || !MIME_FOR_EXT[ext]) {
    throw new Error(`${e.slug}: cannot determine file extension (got "${ext}")`);
  }
  const mime = MIME_FOR_EXT[ext];

  // Decide hosting strategy:
  //   source → bytes already in this repo, write to dist/blobs/
  //   remote + CORS-safe → leave URL pointing upstream
  //   remote + CORS-unsafe → mirror bytes into dist/blobs/, rewrite URL.
  //     Requires a license in MIRROR_OK_LICENSES; otherwise build fails.
  const needsMirror = mode === 'remote' && fetched.corsSafe === false;
  if (needsMirror && !MIRROR_OK_LICENSES.has(e.license)) {
    throw new Error(
      `${e.slug}: remote at ${e.remote} sends no CORS header, but license "${e.license}" ` +
      `is not in the catalog's mirror-allowed set. Either add a CORS-friendly host, ` +
      `or use a redistributable license (CC0/CC-BY/MIT/Apache/etc.).`
    );
  }

  e.ext = ext;
  e.mime = mime;
  e.sha256 = fetched.sha256;
  e.byteLength = fetched.bytes.length;
  e.hosting = mode === 'source' ? 'local' : (needsMirror ? 'mirrored' : 'remote');

  if (IMAGE_EXTS.has(ext)) {
    Object.assign(e, await processImageBytes(fetched.bytes));
    e.thumbSha = await writeThumbForImage(fetched.bytes);
    e.allTags = dedupe([...(e.tags ?? []), ...derivedTagsForImage(e), e.hosting, 'asset']);
  } else if (AUDIO_EXTS.has(ext)) {
    Object.assign(e, await processAudioBytes(fetched.bytes, mime));
    e.thumbSha = null;
    e.allTags = dedupe([...(e.tags ?? []), ...derivedTagsForAudio(e), e.hosting, 'asset']);
  } else {
    throw new Error(`${e.slug}: extension ${ext} isn't a supported asset type`);
  }

  if (e.hosting === 'remote') {
    e.url = e.remote;
  } else {
    await writeBlobFromBytes(fetched.bytes, fetched.sha256, ext);
    e.url = `blobs/${fetched.sha256}${ext}`;
    if (needsMirror) e.originalUrl = e.remote;
  }
  return { mode, cached: fetched.cached, hosting: e.hosting };
}

async function processPackEntry(e) {
  const mode = entryMode(e);
  const ref = mode === 'remote' ? e.remote : e.source;
  const fetched = await fetchBytes(e, ref, mode);

  if (fetched.ext !== '.zip' && fetched.remoteMeta?.contentType !== 'application/zip') {
    const magic = fetched.bytes.subarray(0, 4).toString('hex');
    if (magic !== '504b0304' && magic !== '504b0506') {
      throw new Error(`${e.slug}: pack entry source must be a zip (got ${fetched.ext}, content-type ${fetched.remoteMeta?.contentType})`);
    }
  }

  const packResult = await processPackZip(fetched.bytes, e);

  const needsMirror = mode === 'remote' && fetched.corsSafe === false;
  if (needsMirror && !MIRROR_OK_LICENSES.has(e.license)) {
    throw new Error(
      `${e.slug}: remote zip at ${e.remote} sends no CORS header, but license "${e.license}" ` +
      `is not in the catalog's mirror-allowed set. Either add a CORS-friendly host, ` +
      `or use a redistributable license (CC0/CC-BY/MIT/Apache/etc.).`
    );
  }

  e.ext = '.zip';
  e.mime = 'application/zip';
  e.sha256 = packResult.zipSha;
  e.byteLength = fetched.bytes.length;
  e.hosting = mode === 'source' ? 'local' : (needsMirror ? 'mirrored' : 'remote');
  e.packSummary = packResult.summary;
  e.url = e.hosting === 'remote' ? e.remote : `blobs/${packResult.zipSha}.zip`;
  if (needsMirror) e.originalUrl = e.remote;

  // Preview: accept either an http(s) URL or a local assets/ path.
  const previewMode = /^https?:\/\//i.test(e.preview) ? 'remote' : 'source';
  const previewFetched = await fetchBytes(null, e.preview, previewMode);
  if (!IMAGE_EXTS.has(previewFetched.ext)) {
    throw new Error(`${e.slug}: preview must be an image (got ${previewFetched.ext})`);
  }
  e.previewSha256 = previewFetched.sha256;
  e.previewCorsSafe = previewFetched.corsSafe;

  e.allTags = dedupe([...(e.tags ?? []), ...derivedTagsForPack(packResult.summary), e.hosting, 'pack']);

  // Stash everything needed for the deferred write pass.
  e._packBytes = fetched.bytes;
  e._packFiles = packResult.files;
  e._previewBytes = previewFetched.bytes;

  return { mode, cached: fetched.cached, hosting: e.hosting };
}

async function emitPackArtifacts(e, version) {
  // Pack manifest, content-addressed by zip sha + tagged with build version.
  const packManifest = {
    schema: SCHEMA,
    zipSha256: e.sha256,
    zipUrl: e.url,
    zipBytes: e.byteLength,
    summary: e.packSummary,
    files: e._packFiles,
  };
  const packManifestPath = `packs/${e.sha256}.v${version}.json`;
  e.packManifestPath = packManifestPath;
  e.packManifestChecksum = await writeJson(join(DIST_DIR, packManifestPath), packManifest);

  e.thumbSha = await writeThumbForImage(e._previewBytes);

  // 'local' = source-mode pack, 'mirrored' = CORS-unsafe remote pack we re-host.
  // Either way, zip bytes go into dist/blobs/.
  if (e.hosting === 'local' || e.hosting === 'mirrored') {
    await writeBlobFromBytes(e._packBytes, e.sha256, '.zip');
  }

  // Drop the staged byte buffers — large packs would otherwise hold MBs in memory.
  delete e._packBytes;
  delete e._packFiles;
  delete e._previewBytes;
}


// --- Main -------------------------------------------------------------------

async function main() {
  const entries = await loadEntries(REPO_ROOT);
  if (entries.length === 0) {
    console.log('No entries found. Add JSON files under entries/ first.');
    return;
  }

  const registry = await loadRegistry();
  assignIds(entries, registry);

  // Stage 1: fetch + hash + decode metadata for every entry.
  //   - Asset entries write their blob + thumb during this stage (no version dependency).
  //   - Pack entries stash their bytes/file list/preview in-memory for stage 2.
  for (const e of entries) {
    e.kind = e.kind ?? 'asset';
    if (e.kind !== 'asset' && e.kind !== 'pack') {
      throw new Error(`${e.slug}: unknown kind "${e.kind}" (expected "asset" or "pack")`);
    }
    const info = e.kind === 'pack'
      ? await processPackEntry(e)
      : await processAssetEntry(e);

    const kindMark = e.kind === 'pack' ? 'PACK ' : 'asset';
    const cachedMark = info.cached ? '(cached)' : '(fresh)';
    const hostMark = e.hosting === 'remote'   ? '→upstream'
                   : e.hosting === 'mirrored' ? '→mirrored'
                   : '→local   ';
    const sizeStr = e.kind === 'pack'
      ? `${e.packSummary.fileCount} files, ${(e.byteLength/1024/1024).toFixed(2)} MB zip`
      : `${(e.byteLength/1024).toFixed(1)} KB`;
    console.log(`  + [${kindMark}] ${e.slug.padEnd(36)} id=${String(e.id).padStart(3)}  ${e.sha256.slice(0, 10)}…  ${sizeStr.padEnd(28)}  ${hostMark}  ${cachedMark}`);
  }

  // Compute the content-derived version once everything is hashed.
  // For packs, fold the extracted file list into the digest — otherwise
  // changing include/exclude wouldn't bump the version even though the
  // pack manifest content changed.
  const versionInput = entries.map(e => {
    const base = `${e.id}:${e.sha256}:${e.hosting}:${e.url}`;
    if (e.kind === 'pack') {
      const fileDigest = sha256Hex(Buffer.from(JSON.stringify(e._packFiles)));
      return `${base}:pack=${fileDigest}`;
    }
    return base;
  }).join('\n');
  const version = sha256Hex(Buffer.from(versionInput)).slice(0, 8);
  console.log(`\nVersion: ${version}`);

  // Stage 2: write all version-stamped artifacts (pack manifests, indices, shards).
  for (const e of entries) {
    if (e.kind === 'pack') await emitPackArtifacts(e, version);
  }

  const tagIndex = buildTagIndex(entries);
  const trigramIndex = buildTrigramIndex(entries);
  const facets = buildFacets(entries);
  const idMap = buildIdMap(entries);
  const shards = buildShards(entries);

  const checksums = { shards: {}, packs: {} };
  checksums.tags     = await writeJson(join(DIST_DIR, 'index',  `tags.v${version}.json`),     tagIndex);
  checksums.trigrams = await writeJson(join(DIST_DIR, 'index',  `trigrams.v${version}.json`), trigramIndex);
  checksums.facets   = await writeJson(join(DIST_DIR, 'index',  `facets.v${version}.json`),   facets);
  checksums.idMap    = await writeJson(join(DIST_DIR, 'index',  `id-map.v${version}.json`),   idMap);
  for (const [key, shard] of Object.entries(shards)) {
    checksums.shards[key] = await writeJson(join(DIST_DIR, 'shards', `${key}.v${version}.json`), shard);
  }
  for (const e of entries.filter(x => x.kind === 'pack')) {
    checksums.packs[e.sha256] = e.packManifestChecksum;
  }

  const packCount     = entries.filter(e => e.kind === 'pack').length;
  const remoteCount   = entries.filter(e => e.hosting === 'remote').length;
  const mirroredCount = entries.filter(e => e.hosting === 'mirrored').length;
  const localCount    = entries.filter(e => e.hosting === 'local').length;

  const manifest = {
    schema: SCHEMA,
    version,
    builtAt: new Date().toISOString(),
    entryCount: entries.length,
    packCount,
    remoteCount,
    mirroredCount,
    localCount,
    shardCount: SHARD_COUNT,
    paths: {
      tags:     `index/tags.v${version}.json`,
      trigrams: `index/trigrams.v${version}.json`,
      facets:   `index/facets.v${version}.json`,
      idMap:    `index/id-map.v${version}.json`,
      shards:   Object.fromEntries(
        Object.keys(shards).map(k => [k, `shards/${k}.v${version}.json`])
      ),
      blobsBase:  'blobs/',
      thumbsBase: 'thumbs/',
      packsBase:  'packs/',
    },
    checksums,
  };

  await writeFile(join(DIST_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await saveRegistry(registry);

  console.log(`\n✓ Built ${entries.length} entries (${packCount} packs · ${remoteCount} upstream, ${mirroredCount} mirrored, ${localCount} local) → version ${version}`);
  if (mirroredCount > 0) {
    console.log(`ℹ ${mirroredCount} CORS-unsafe entr${mirroredCount === 1 ? 'y' : 'ies'} mirrored into dist/blobs/ for jsDelivr.`);
  }
}

function dedupe(arr) {
  return [...new Set(arr)];
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
