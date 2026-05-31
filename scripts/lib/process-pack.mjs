// Pack processing: takes a downloaded zip + entry config and emits the
// pack manifest data + per-file metadata. The orchestrator (build.mjs) is
// responsible for writing the manifest JSON, generating the preview thumb,
// and building the shard entry.

import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { parseBuffer as parseAudioMetadataBuffer } from 'music-metadata';
import { matchesAny } from './glob.mjs';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac']);
const FONT_EXTS  = new Set(['.ttf', '.otf']);
const ASSET_EXTS = new Set([...IMAGE_EXTS, ...AUDIO_EXTS, ...FONT_EXTS]);

const MIME_FOR_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function processPackZip(zipBytes, entry) {
  const zipSha = sha256Hex(zipBytes);

  if (entry.expectedSha256 && entry.expectedSha256 !== zipSha) {
    throw new Error(
      `${entry.slug}: zip sha256 mismatch.\n  expected: ${entry.expectedSha256}\n  actual:   ${zipSha}\n` +
      `The remote zip changed since this entry was authored. ` +
      `Verify the new content is still appropriate, then update expectedSha256 in entries/.../${entry.slug}.json.`
    );
  }

  const zip = await JSZip.loadAsync(zipBytes);

  const include = entry.include ?? [];                 // empty = include all supported asset types
  const exclude = entry.exclude ?? [];

  const files = [];
  let totalExtractedBytes = 0;

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;

    const ext = extname(path).toLowerCase();
    const mime = MIME_FOR_EXT[ext];

    // Skip files we don't know how to handle.
    if (!mime || !ASSET_EXTS.has(ext)) continue;

    // Apply explicit exclude first, then include filter (default: accept all asset-typed files).
    if (matchesAny(path, exclude)) continue;
    if (include.length > 0 && !matchesAny(path, include)) continue;

    const bytes = await file.async('uint8array');
    const buf = Buffer.from(bytes);
    const sha = sha256Hex(buf);
    totalExtractedBytes += buf.length;

    const fileMeta = {
      path,
      sha256: sha,
      bytes: buf.length,
      mime,
    };

    try {
      if (IMAGE_EXTS.has(ext)) {
        const meta = await sharp(buf).metadata();
        fileMeta.width = meta.width ?? null;
        fileMeta.height = meta.height ?? null;
        fileMeta.hasAlpha = meta.hasAlpha ?? false;
      } else if (AUDIO_EXTS.has(ext)) {
        const meta = await parseAudioMetadataBuffer(buf, { mimeType: mime });
        fileMeta.durationSec = meta.format.duration ?? null;
        fileMeta.sampleRate = meta.format.sampleRate ?? null;
        fileMeta.channels = meta.format.numberOfChannels ?? null;
      }
      // FONT_EXTS need no per-file metadata extraction — they're opaque blobs.
      // The Playground UI uses the basename to label them.
    } catch (err) {
      // Don't abort the whole pack on one malformed file — record what we know.
      fileMeta.metadataError = err.message;
    }

    files.push(fileMeta);
  }

  // Sort by path so the manifest is stable across rebuilds.
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Derive useful summary stats for the grid tile.
  const summary = {
    fileCount: files.length,
    totalExtractedBytes,
    images: files.filter(f => f.mime?.startsWith('image/')).length,
    audio:  files.filter(f => f.mime?.startsWith('audio/')).length,
    fonts:  files.filter(f => f.mime?.startsWith('font/')).length,
  };

  return { zipSha, files, summary };
}
