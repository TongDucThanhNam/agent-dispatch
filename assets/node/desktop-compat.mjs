import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

function decrypt(value, env = process.env) {
  if (!value?.startsWith('enc:v1:')) return value;
  const secret = env.ZCODE_CREDENTIAL_SECRET || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
  const [iv, tag, data] = value.slice(7).split('.').map(x => Buffer.from(x, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Desktop already stores account-scoped keys. Native 0.16.9 additionally
// requires an identity pointer. Supply that pointer in memory, never a key copy.
export function desktopCredentialAliases(saved, decode = decrypt) {
  const result = { ...saved };
  for (const family of ['zai', 'bigmodel']) {
    const info = saved[`oauth:${family}:user_info`];
    if (!info) continue;
    let user;
    try { user = JSON.parse(decode(info)); } catch { continue; }
    const identity = user?.user_id ?? user?.id;
    if (typeof identity !== 'string' || !identity.trim()) continue;
    const provider = `account:${family}-individual-coding-plan`;
    const pointer = `account-provider:${provider}:identity`;
    const key = `account-provider:coding-plan:${provider}:account:${encodeURIComponent(identity)}:api-key`;
    if (!result[pointer] && saved[key]) result[pointer] = identity;
  }
  return result;
}

export function patchNativeModelList(source) {
  // CLI 0.16.9's formatter still reads id, while its catalog returns
  // providerId/modelId. Patch only the formatter, with a strict shape guard.
  const marker = 'function LXa(e,t){';
  if (!source.includes('"0.16.9"') || source.split(marker).length !== 2) return source;
  return source.replace(marker, marker + 't=t.map(x=>({...x,id:x.id??(x.ref?.providerId&&x.ref?.modelId?`${x.ref.providerId}/${x.ref.modelId}`:x.providerId&&x.modelId?`${x.providerId}/${x.modelId}`:undefined)}));');
}

export function installDesktopCompatibility(env = process.env) {
  const root = env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir();
  const credentials = path.resolve(root, '.zcode/v2/credentials.json').toLowerCase();
  const isCredentials = file => {
    try { return path.resolve(file instanceof URL ? fileURLToPath(file) : String(file)).toLowerCase() === credentials; } catch { return false; }
  };
  const project = (value, options) => {
    const saved = JSON.parse(value.toString().replace(/^\uFEFF/, ''));
    const bytes = Buffer.from(JSON.stringify(desktopCredentialAliases(saved, x => decrypt(x, env))));
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  };
  const syncRead = fs.readFileSync, asyncRead = fsp.readFile;
  fs.readFileSync = (file, options) => {
    const value = syncRead(file, options);
    return isCredentials(file) ? project(value, options) : value;
  };
  fsp.readFile = async (file, options) => {
    const value = await asyncRead(file, options);
    return isCredentials(file) ? project(value, options) : value;
  };
  syncBuiltinESMExports();
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/zcode.cjs')) return result;
    const source = result.source?.toString() ?? syncRead(fileURLToPath(url), 'utf8');
    return { ...result, source: patchNativeModelList(source) };
  } });
}

if (path.basename(process.argv[1] ?? '').toLowerCase() === 'zcode.cjs') installDesktopCompatibility();
