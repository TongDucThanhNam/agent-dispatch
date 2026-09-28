// Session-log download, modelled on DeepSeek Harness dsh-session-log-export: one streamed ZIP holding the
// run's own files, the worker session's full logical log as canonical JSONL, sub-session logs and
// per-session usage tables. Reads are read-only; the archive is produced incrementally with backpressure.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

export const EXPORT_FORMAT = 'zcode-session-log/1';
const RUN_FILE_LIMIT = 256 * 1024 * 1024;
const SKIP_RUN_FILE = /\.(sqlite(-wal|-shm|-journal)?|zip|lock|partial)$/i;
// Tables whose rows are scoped by session_id and describe the worker's run rather than global preferences.
const SESSION_TABLES = ['model_usage', 'turn_usage', 'tool_usage', 'todo', 'session_entry', 'session_input', 'session_task_link', 'permission'];
const safeName = value => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session';
const normalizedDirectory = value => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const parse = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };

export const sessionLogZipFilename = runId => `${safeName(runId)}-session-log.zip`;

// Batch JSONL lines into bounded chunks so a large session never sits in memory as one string.
async function* jsonl(rows, map = x => x) {
  let chunk = '';
  for (const row of rows) {
    chunk += JSON.stringify(map(row)) + '\n';
    if (chunk.length >= 256 * 1024) { yield Buffer.from(chunk); chunk = ''; }
  }
  if (chunk) yield Buffer.from(chunk);
}

function* sessionLines(db, id, header) {
  yield { type: 'header', format: EXPORT_FORMAT, session: header };
  const parts = db.prepare('SELECT id,message_id,time_created,time_updated,data FROM part WHERE message_id=? ORDER BY time_created,id');
  for (const message of db.prepare('SELECT id,time_created,time_updated,data FROM message WHERE session_id=? ORDER BY time_created,id').iterate(id)) {
    yield { type: 'message', id: message.id, time_created: message.time_created, time_updated: message.time_updated, data: parse(message.data) };
    for (const part of parts.iterate(message.id))
      yield { type: 'part', id: part.id, message_id: part.message_id, time_created: part.time_created, time_updated: part.time_updated, data: parse(part.data) };
  }
}

// Export entries in archive order. The root session is validated against the run project before any byte streams.
export function sessionExportEntries({ runDir, config, state, trajectory = null, exportedAt = Date.now() }) {
  const sessionId = state?.sessionId ?? null, dbPath = config?.dbPath;
  let db: any = null, header: any = null, problem: any = null;
  if (!sessionId) problem = 'The run has no bound worker session yet; only run files are included.';
  else if (!dbPath || !fs.existsSync(dbPath)) problem = 'The session database is not available; only run files are included.';
  else {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');
    header = db.prepare('SELECT * FROM session WHERE id=?').get(sessionId);
    if (!header) problem = 'The worker session was not found in the local database; only run files are included.';
    else if (normalizedDirectory(header.directory) !== normalizedDirectory(config.project)) { db.close(); throw new Error('Session belongs to a different project.'); }
    if (problem) { db.close(); db = null; }
  }
  const tables = db ? new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name)) : new Set<any>();
  // Descendant sessions (subagents, forks) in lineage order.
  const descendants: any[] = [];
  if (db) for (let queue = [sessionId]; queue.length;) {
    const parent = queue.shift();
    for (const child of db.prepare('SELECT * FROM session WHERE parent_id=? ORDER BY time_created,id').all(parent)) {
      if (descendants.length >= 500 || child.id === sessionId || descendants.some(x => x.id === child.id)) continue;
      descendants.push(child); queue.push(child.id);
    }
  }
  const runFiles = fs.readdirSync(runDir, { withFileTypes: true })
    .filter(x => x.isFile() && !SKIP_RUN_FILE.test(x.name)).map(x => x.name).sort();
  const manifest = { format: EXPORT_FORMAT, exportedAt, runId: config.runId, workerKind: config.workerKind ?? 'zcode', project: config.project,
    sessionId, model: state?.model ?? config.expectedModel ?? null, status: state?.status ?? null, startedAt: state?.startedAt ?? null,
    endedAt: state?.endedAt ?? null, subagents: descendants.map(x => x.id), note: problem,
    layout: { 'run/': 'Run directory files (config, status, brief, report, worker logs).', 'session.jsonl': 'Header line, then each message followed by its parts.',
      'tables/': 'Session-scoped usage and state rows as JSONL.', 'subagents/<id>/session.jsonl': 'Descendant session logs.',
      'trajectory.json': 'The dashboard projection at export time.' } };
  let closed = false;
  const close = () => { if (db && !closed) { closed = true; db.close(); } };
  const entries = async function* () {
    try {
      yield { path: 'export.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') };
      for (const name of runFiles) {
        const file = path.join(runDir, name);
        if (fs.statSync(file).size > RUN_FILE_LIMIT) continue;
        yield { path: 'run/' + name, chunks: fs.createReadStream(file, { highWaterMark: 256 * 1024 }) };
      }
      if (trajectory) yield { path: 'trajectory.json', data: Buffer.from(JSON.stringify(trajectory, null, 2) + '\n') };
      if (!db) return;
      yield { path: 'session.jsonl', chunks: jsonl(sessionLines(db, sessionId, header)) };
      for (const table of SESSION_TABLES) {
        if (!tables.has(table)) continue;
        const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(x => x.name);
        if (!columns.includes('session_id')) continue;
        const order = columns.includes('started_at') ? 'started_at' : columns.includes('time_created') ? 'time_created' : 'rowid';
        yield { path: `tables/${table}.jsonl`, chunks: jsonl(db.prepare(`SELECT * FROM ${table} WHERE session_id=? ORDER BY ${order}`).iterate(sessionId)) };
      }
      for (const child of descendants) yield { path: `subagents/${safeName(child.id)}/session.jsonl`, chunks: jsonl(sessionLines(db, child.id, child)) };
    } finally { close(); }
  };
  // close() releases the database when the entries are never consumed (for example a HEAD preflight).
  return { manifest, entries: entries(), close };
}

// Minimal streaming ZIP writer: DEFLATE entries with data descriptors, UTF-8 names, no ZIP64 (fails loudly past 4 GiB).
export async function* zipStream(entries, { level = 6 }: any = {}) {
  const central: any[] = [];
  let offset = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for await (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0808, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt16LE(name.length, 26);
    yield Buffer.concat([local, name]);
    const start = offset; offset += 30 + name.length;
    let crc = 0, size = 0, compressed = 0;
    const deflate = zlib.createDeflateRaw({ level });
    const source = entry.data ? [entry.data] : entry.chunks;
    const feed = (async () => {
      try {
        for await (const chunk of source) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          crc = zlib.crc32(buffer, crc); size += buffer.length;
          if (!deflate.write(buffer)) await once(deflate, 'drain');
        }
        deflate.end();
      } catch (error) { deflate.destroy(error); throw error; }
    })();
    feed.catch(() => {});
    for await (const out of deflate) { compressed += out.length; yield out; }
    await feed;
    offset += compressed;
    if (size > 0xffffffff || compressed > 0xffffffff || offset > 0xffffffff) throw new Error('The session log exceeds the 4 GiB ZIP limit.');
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc >>> 0, 4); descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(size, 12);
    yield descriptor; offset += 16;
    central.push({ name, crc: crc >>> 0, size, compressed, start });
  }
  const directoryStart = offset;
  for (const item of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0808, 8);
    record.writeUInt16LE(8, 10); record.writeUInt16LE(dosTime, 12); record.writeUInt16LE(dosDate, 14); record.writeUInt32LE(item.crc, 16);
    record.writeUInt32LE(item.compressed, 20); record.writeUInt32LE(item.size, 24); record.writeUInt16LE(item.name.length, 28);
    record.writeUInt32LE(item.start, 42);
    yield Buffer.concat([record, item.name]); offset += 46 + item.name.length;
  }
  if (central.length > 0xffff || offset > 0xffffffff) throw new Error('The session log exceeds the ZIP limits.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12); end.writeUInt32LE(directoryStart, 16);
  yield end;
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// Read and validate a managed run directory for export.
export function loadRunForExport(runDir) {
  const resolved = fs.realpathSync(runDir), config = readJson(path.join(resolved, 'config.json')), state = readJson(path.join(resolved, 'status.json'));
  if (state.runId !== config.runId || fs.realpathSync(config.runDir) !== resolved) throw new Error('Run record identity differs.');
  return { runDir: resolved, config, state };
}

// CLI export: write the archive to a file (atomic rename) and return its summary.
export async function exportRunToFile(runDir, out: string | null = null, { trajectory = null }: any = {}) {
  const run = loadRunForExport(runDir);
  const target = path.resolve(out ?? path.join(path.dirname(run.runDir), sessionLogZipFilename(run.config.runId)));
  const temporary = target + '.' + process.pid + '.partial';
  const { manifest, entries } = sessionExportEntries({ ...run, trajectory });
  try { await pipeline(Readable.from(zipStream(entries)), fs.createWriteStream(temporary, { flags: 'wx' })); fs.renameSync(temporary, target); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  return { path: target, bytes: fs.statSync(target).size, sessionId: manifest.sessionId, subagents: manifest.subagents.length, note: manifest.note };
}