import type { CliError } from './errors.ts';

/** Protocol version printed in every JSON envelope. Bump only for breaking changes. */
export const PROTOCOL_VERSION = 1;

export interface OutputOptions { pretty?: boolean }

const serialize = (value: unknown, pretty?: boolean) => JSON.stringify(value, null, pretty ? 2 : undefined);

/** Drops null/undefined keys (recursively in plain objects) so compact payloads stay small; absent means null. */
export function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map(prune) as T;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== null && item !== undefined) out[key] = prune(item);
  return out as T;
}

export function okEnvelope(cmd: string, data: unknown, next?: string[]) {
  return { v: PROTOCOL_VERSION, ok: true, cmd, data, ...(next?.length ? { next } : {}) };
}

export function errorEnvelope(cmd: string | null, error: CliError) {
  return { v: PROTOCOL_VERSION, ok: false, ...(cmd ? { cmd } : {}),
    error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}), ...(error.details !== undefined ? { details: error.details } : {}) } };
}

export function writeOk(cmd: string, data: unknown, next: string[] | undefined, options: OutputOptions = {}) {
  process.stdout.write(serialize(okEnvelope(cmd, data, next), options.pretty) + '\n');
}

export function writeError(cmd: string | null, error: CliError, options: OutputOptions = {}) {
  process.stdout.write(serialize(errorEnvelope(cmd, error), options.pretty) + '\n');
}

export function writeText(text: string) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}
