// Downloads a remote URL once, caches the response under .cache/<urlHash>/,
// and returns { bytes, sha256, cached, corsSafe, contentType, etag, status }.
//
// The cache key is sha256(url) — so changing an entry's URL forces a new fetch.
// Each cache entry has two files: <key>.bin (bytes) and <key>.meta.json (metadata).

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const CORS_PROBE_ORIGIN = 'https://playground.fadebasic.io';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

export async function fetchWithCache(url, cacheDir, { force = false } = {}) {
  const key = sha256Hex(Buffer.from(url));
  const binPath = join(cacheDir, `${key}.bin`);
  const metaPath = join(cacheDir, `${key}.meta.json`);

  if (!force && await fileExists(binPath) && await fileExists(metaPath)) {
    const bytes = await readFile(binPath);
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    return { ...meta, bytes, cached: true };
  }

  await mkdir(dirname(binPath), { recursive: true });

  const res = await fetch(url, {
    redirect: 'follow',
    headers: { Origin: CORS_PROBE_ORIGIN, 'User-Agent': 'FadeLandCatalog-build/0.1' },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} → HTTP ${res.status} ${res.statusText}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = sha256Hex(bytes);

  const acao = res.headers.get('access-control-allow-origin');
  const corsSafe = acao === '*' || acao === CORS_PROBE_ORIGIN;

  const meta = {
    url,
    sha256: sha,
    contentType: res.headers.get('content-type') || null,
    etag: res.headers.get('etag') || null,
    lastModified: res.headers.get('last-modified') || null,
    corsSafe,
    corsHeader: acao,
    status: res.status,
    fetchedAt: new Date().toISOString(),
    byteLength: bytes.length,
  };

  await writeFile(binPath, bytes);
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  return { ...meta, bytes, cached: false };
}
