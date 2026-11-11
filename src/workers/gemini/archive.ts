import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Preserve every original archive payload and unpacked entry; append replacements. */
export function readArchive(data: Buffer) {
  if (data.length < 16 || data.readUInt32LE(0) !== 4) throw Error('Invalid ASAR prefix.');
  const size = data.readUInt32LE(4), length = data.readUInt32LE(12), start = 8 + size;
  if (size < 8 || length > size - 8 || start > data.length) throw Error('Invalid ASAR header.');
  const header = JSON.parse(data.subarray(16, 16 + length).toString('utf8'));
  const entry = (name: string) => {
    if (!name || name.split('/').some(p => !p || ['.', '..', '__proto__', 'constructor'].includes(p))) throw Error('Invalid archive path.');
    let node = header;
    for (const part of name.split('/')) node = node?.files?.[part];
    return node;
  };
  return { header, start, entry, read(name: string) {
    const node = entry(name), offset = Number(node?.offset);
    if (!node || node.unpacked || node.link || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(node.size) || node.size < 0 || start + offset + node.size > data.length) throw Error('Invalid packed ASAR entry: ' + name);
    return data.subarray(start + offset, start + offset + node.size);
  } };
}

export function patchArchive(data: Buffer, files: Record<string, Buffer | string>) {
  const archive = readArchive(data), payloads = [data.subarray(archive.start)];
  let offset = payloads[0].length;
  for (const [name, value] of Object.entries(files)) {
    archive.entry(name); // Validate before walking or creating keys.
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value), parts = name.split('/');
    let node = archive.header;
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} });
    const blockSize = 4 * 1024 * 1024, blocks: string[] = [];
    for (let i = 0; i < content.length; i += blockSize) blocks.push(digest(content.subarray(i, i + blockSize)));
    node.files[parts.at(-1)!] = { ...(node.files[parts.at(-1)!]?.executable ? { executable: true } : {}), size: content.length, offset: String(offset), integrity: { algorithm: 'SHA256', hash: digest(content), blockSize, blocks } };
    payloads.push(content); offset += content.length;
  }
  const json = Buffer.from(JSON.stringify(archive.header)), padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
  const result = Buffer.concat([prefix, ...payloads]);
  for (const [name, value] of Object.entries(files)) if (!readArchive(result).read(name).equals(Buffer.from(value))) throw Error('ASAR verification failed.');
  return result;
}

export function inspectGeminiInstall(executable: string) {
  const root = path.dirname(fs.realpathSync(executable));
  const dirs = fs.existsSync(path.join(root, 'resources/app.asar')) ? [root] : fs.readdirSync(root)
    .filter(n => /^app-\d+\.\d+\.\d+$/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(n => path.join(root, n));
  if (!dirs.length) throw Error('Gemini application archive not found.');
  const dir = dirs[0], exe = path.join(dir, 'Gemini.exe'), archivePath = path.join(dir, 'resources/app.asar');
  const data = fs.readFileSync(archivePath), archive = readArchive(data);
  const packageBytes = archive.entry('package.json')?.unpacked ? fs.readFileSync(archivePath + '.unpacked/package.json') : archive.read('package.json');
  if (packageBytes.length > 100_000) throw Error('Invalid Gemini package size.');
  const pkg = JSON.parse(packageBytes.toString());
  if (pkg.name !== 'gemini' || pkg.main !== 'src/main.js' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw Error('Unsupported Gemini package.');
  const binary = fs.readFileSync(exe), sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const at = binary.indexOf(sentinel) + sentinel.length;
  if (at < sentinel.length || binary[at] !== 1 || binary[at + 1] < 6) throw Error('Unknown Electron fuse format; refusing to patch.');
  if (binary[at + 6] !== 48) throw Error('Gemini enforces ASAR integrity. Its security fuses will not be changed.');
  return { exe, archivePath, version: pkg.version, data, hash: digest(data), integrityEnforced: false };
}
