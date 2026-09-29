import fs from 'node:fs';
import path from 'node:path';

// Codex keeps the images a tool returned to the model (view_image, screenshots) only in its rollout, as data URLs.
// The projection records "[image]" in their place; the run's own rollout copy (codex-rollout.jsonl) has the bytes.
const ROLLOUT = 'codex-rollout.jsonl';
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_LINE = 64 << 20, CHUNK = 4 << 20;
const safeId = value => String(value ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 120);
const MARKERS = [Buffer.from('"input_image"'), Buffer.from('"image_url"')];

type Index = { size: number; scanned: number; lines: Map<string, { start: number; length: number }> };
const indexes = new Map<string, Index>();

/** Byte ranges of tool-output lines that carry images, by call ID. Built once per file and extended as it grows. */
function indexOf(file: string) {
  const size = fs.statSync(file).size;
  let index = indexes.get(file);
  if (!index || size < index.size) indexes.set(file, index = { size: 0, scanned: 0, lines: new Map() });
  if (index.scanned >= size) return index;
  const fd = fs.openSync(file, 'r');
  try {
    let carry = Buffer.alloc(0), position = index.scanned, skipping = false;
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - position)), read = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (!read) break;
      const buffer = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read), base = position - carry.length;
      let start = 0, end;
      while ((end = buffer.indexOf(10, start)) >= 0) {
        if (!skipping) line(index, buffer.subarray(start, end), base + start);
        skipping = false; start = end + 1;
      }
      carry = Buffer.from(buffer.subarray(start)); position += read;
      if (carry.length > MAX_LINE) { skipping = true; carry = Buffer.alloc(0); }
    }
    // A partial last line (a live run mid-write) is read again next time.
    index.scanned = skipping ? position : position - carry.length; index.size = size;
  } finally { fs.closeSync(fd); }
  return index;
}

function line(index: Index, bytes: Buffer, start: number) {
  if (!MARKERS.some(marker => bytes.includes(marker))) return;
  let record; try { record = JSON.parse(bytes.toString('utf8')); } catch { return; }
  const payload = record?.payload;
  if (record?.type !== 'response_item' || typeof payload?.type !== 'string' || !payload.type.endsWith('_call_output') || !payload.call_id) return;
  index.lines.set(safeId(payload.call_id), { start, length: bytes.length });
}

const items = output => Array.isArray(output) ? output : Array.isArray(output?.content) ? output.content : [];

/** The `n`th image (0-based, in output order) a Codex tool call returned, or null when the run did not keep it. */
export function readToolImage(runDir: string, callId: string, n: number) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 999) throw new Error('Invalid image index.');
  const id = safeId(callId), file = path.join(runDir, ROLLOUT);
  if (!id || !fs.existsSync(file)) return null;
  const hit = indexOf(file).lines.get(id);
  if (!hit) return null;
  const bytes = Buffer.allocUnsafe(hit.length), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, bytes, 0, hit.length, hit.start); } finally { fs.closeSync(fd); }
  let payload; try { payload = JSON.parse(bytes.toString('utf8')).payload; } catch { return null; }
  if (safeId(payload?.call_id) !== id) return null;
  const images = items(payload.output).filter(x => String(x?.type ?? '').includes('image'));
  const url = images[n]?.image_url ?? images[n]?.url;
  const match = typeof url === 'string' ? /^data:(image\/[a-z]+);base64,/.exec(url) : null;
  // Only raster data URLs: remote URLs are never fetched, and SVG could carry script.
  if (!match || !Object.hasOwn(TYPES, match[1])) return null;
  return { type: match[1], data: Buffer.from(url.slice(match[0].length), 'base64'), count: images.length, detail: typeof images[n]?.detail === 'string' ? images[n].detail : null };
}
