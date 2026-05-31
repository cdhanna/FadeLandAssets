// Walks entries/**/*.json and returns parsed objects with the source file path
// attached as `__file` (for error reporting).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadEntries(repoRoot) {
  const entriesDir = join(repoRoot, 'entries');
  const files = await walkJson(entriesDir);
  const entries = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`failed to parse ${file}: ${err.message}`);
    }
    parsed.__file = file;
    entries.push(parsed);
  }
  // Sort by slug for deterministic iteration order so the build is reproducible.
  entries.sort((a, b) => (a.slug ?? '').localeCompare(b.slug ?? ''));
  return entries;
}

export function entryMode(entry) {
  if (entry.remote && entry.source) return 'invalid-both';
  if (entry.remote) return 'remote';
  if (entry.source) return 'source';
  return 'invalid-neither';
}

async function walkJson(dir) {
  const out = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const item of items) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      out.push(...await walkJson(path));
    } else if (item.isFile() && item.name.endsWith('.json')) {
      out.push(path);
    }
  }
  return out;
}
