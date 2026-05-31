// Validates entries/*.json without mutating anything. CI runs this on every PR.
// Exits non-zero on any problem and prints a list of issues.

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadEntries, entryMode } from './lib/entries.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const COMMON_FIELDS = ['slug', 'name', 'license'];

const issues = [];
function fail(file, msg) { issues.push(`${file}: ${msg}`); }

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function checkCommon(rel, data) {
  for (const field of COMMON_FIELDS) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      fail(rel, `missing required field: ${field}`);
    }
  }
  if (data.slug && !SLUG_RE.test(data.slug)) {
    fail(rel, `slug "${data.slug}" must match ${SLUG_RE} (lowercase alphanumeric + hyphens, 3-64 chars)`);
  }
  if (Array.isArray(data.tags)) {
    for (const tag of data.tags) {
      if (typeof tag !== 'string' || !TAG_RE.test(tag)) {
        fail(rel, `invalid tag "${tag}" (lowercase alphanumeric + hyphens, ≤32 chars)`);
      }
    }
  } else if (data.tags !== undefined) {
    fail(rel, `tags must be an array`);
  }
  if (data.license !== 'CC0-1.0' && !data.attribution) {
    fail(rel, `license "${data.license}" requires an "attribution" field`);
  }
}

async function checkMode(rel, data) {
  const mode = entryMode(data);
  if (mode === 'invalid-both') {
    fail(rel, `entry must have exactly one of "source" or "remote", not both`);
    return null;
  }
  if (mode === 'invalid-neither') {
    fail(rel, `entry must have exactly one of "source" or "remote"`);
    return null;
  }
  if (mode === 'source') {
    const sourcePath = join(REPO_ROOT, 'assets', data.source);
    if (!await fileExists(sourcePath)) {
      fail(rel, `source file not found: assets/${data.source}`);
    }
  }
  if (mode === 'remote') {
    try {
      const u = new URL(data.remote);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        fail(rel, `remote URL must use http(s): ${data.remote}`);
      }
    } catch {
      fail(rel, `remote is not a valid URL: ${data.remote}`);
    }
  }
  return mode;
}

async function checkPack(rel, data) {
  if (!data.preview) {
    fail(rel, `kind "pack" requires a "preview" — either an http(s) URL or a path under assets/`);
  } else if (/^https?:\/\//i.test(data.preview)) {
    try {
      new URL(data.preview);
    } catch {
      fail(rel, `preview is not a valid URL: ${data.preview}`);
    }
  } else {
    const previewPath = join(REPO_ROOT, 'assets', data.preview);
    if (!await fileExists(previewPath)) {
      fail(rel, `preview file not found: assets/${data.preview}`);
    }
  }
  for (const field of ['include', 'exclude']) {
    if (data[field] !== undefined && !Array.isArray(data[field])) {
      fail(rel, `${field} must be an array of glob patterns`);
    }
  }
}

async function main() {
  const entries = await loadEntries(REPO_ROOT);
  const seenSlugs = new Map();

  for (const entry of entries) {
    const { __file: file, ...data } = entry;
    const rel = file.replace(REPO_ROOT + '/', '');

    const kind = data.kind ?? 'asset';
    if (kind !== 'asset' && kind !== 'pack') {
      fail(rel, `unknown kind "${kind}" — expected "asset" or "pack"`);
      continue;
    }

    checkCommon(rel, data);
    await checkMode(rel, data);
    if (kind === 'pack') await checkPack(rel, data);

    if (data.slug) {
      if (seenSlugs.has(data.slug)) {
        fail(rel, `duplicate slug "${data.slug}" — already used in ${seenSlugs.get(data.slug)}`);
      } else {
        seenSlugs.set(data.slug, rel);
      }
    }
  }

  try {
    const reg = JSON.parse(await readFile(join(REPO_ROOT, '.id-registry.json'), 'utf8'));
    for (const slug of Object.keys(reg.ids ?? {})) {
      if (!seenSlugs.has(slug)) {
        console.warn(`[warn] .id-registry.json has orphan slug "${slug}" — entry was deleted, ID is retired.`);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (issues.length > 0) {
    console.error(`\n${issues.length} validation issue(s):\n`);
    for (const issue of issues) console.error(`  ✗ ${issue}`);
    process.exit(1);
  }

  console.log(`✓ ${entries.length} entries valid`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
