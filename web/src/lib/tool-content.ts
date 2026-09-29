// Parsers for recorded tool calls, so the event panel can show commands, patches and results as such
// rather than as escaped JSON. Shapes follow what the hub serves (src/monitor/event-content.ts): Codex
// code-mode calls carry `command`, `code` (the JavaScript the model ran) and `actions`; other workers
// send their own argument objects, which fall back to a generic view.

import { langFromPath, type Lang } from './highlight';

export interface ToolAction {
  tool?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  path?: string;
}

/** A complete JSON object, or null for anything else (including a partly loaded one). */
export function jsonObject(text: string): Record<string, unknown> | null {
  if (!/^\s*\{/.test(text)) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** Any complete JSON value in `text`, or undefined. */
export function jsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

export const actionsOf = (input: Record<string, unknown> | null): ToolAction[] =>
  Array.isArray(input?.actions) ? input.actions.filter((a): a is ToolAction => Boolean(a) && typeof a === 'object') : [];

export const actionMs = (action: ToolAction) =>
  action.durationMs ?? (action.startedAt != null && action.endedAt != null ? action.endedAt - action.startedAt : null);

// ── JavaScript string literals (Codex code mode embeds commands and patches in them) ──────────────

/** The value of the JS string literal whose opening quote is at `start`, with its end index. */
export function readStringLiteral(source: string, start: number): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === quote) return { value, end: i + 1 };
    if (quote === '`' && ch === '$' && source[i + 1] === '{') return null;
    if (ch !== '\\') { value += ch; continue; }
    const next = source[++i];
    switch (next) {
      case 'n': value += '\n'; break;
      case 't': value += '\t'; break;
      case 'r': value += '\r'; break;
      case 'b': value += '\b'; break;
      case 'f': value += '\f'; break;
      case 'v': value += '\v'; break;
      case '0': value += '\0'; break;
      case 'x': value += String.fromCharCode(parseInt(source.slice(i + 1, i + 3), 16)); i += 2; break;
      case 'u': {
        if (source[i + 1] === '{') {
          const close = source.indexOf('}', i);
          value += String.fromCodePoint(parseInt(source.slice(i + 2, close), 16)); i = close;
        } else { value += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16)); i += 4; }
        break;
      }
      case '\r': if (source[i + 1] === '\n') i++; break;
      case '\n': break;
      case undefined: return null;
      default: value += next;
    }
  }
  return null;
}

/** Labelled commands from the common `const cmds=[["label","command"], …]` batching pattern. */
export function labelledCommands(code: string): Map<string, string> {
  const map = new Map<string, string>();
  const pair = /\[\s*(["'])([\w .:/-]{1,40})\1\s*,\s*(?=["'`])/g;
  for (let match; (match = pair.exec(code));) {
    const literal = readStringLiteral(code, match.index + match[0].length);
    if (literal) map.set(match[2], literal.value);
  }
  return map;
}

/** Literal commands passed as `cmd: "…"` to tools.exec_command in code-mode scripts. */
export function execCommands(code: string): string[] {
  const commands: string[] = [];
  const key = /\bcmd\s*:\s*(?=["'`])/g;
  for (let match; (match = key.exec(code));) {
    const literal = readStringLiteral(code, match.index + match[0].length);
    if (literal) commands.push(literal.value);
  }
  return commands;
}

// ── apply_patch ──────────────────────────────────────────────────────────────────────────────────

export interface PatchLine { type: 'add' | 'del' | 'ctx' | 'hunk' | 'note'; text: string }
export interface PatchFile { op: 'update' | 'add' | 'delete'; path: string; moveTo?: string; lines: PatchLine[]; added: number; removed: number }

const BEGIN = '*** Begin Patch';

/** Every apply_patch body in `text`, whether raw or embedded in JavaScript string literals. */
export function extractPatches(text: string): string[] {
  const patches: string[] = [];
  let from = 0;
  for (let at; (at = text.indexOf(BEGIN, from)) >= 0;) {
    const quote = text[at - 1];
    const literal = quote === '"' || quote === "'" || quote === '`' ? readStringLiteral(text, at - 1) : null;
    if (literal) { patches.push(literal.value); from = literal.end; continue; }
    const end = text.indexOf('*** End Patch', at);
    patches.push(text.slice(at, end < 0 ? undefined : end + 13));
    from = end < 0 ? text.length : end + 13;
  }
  return patches;
}

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (header) {
      file = { op: header[1].toLowerCase() as PatchFile['op'], path: header[2].trim(), lines: [], added: 0, removed: 0 };
      files.push(file);
      continue;
    }
    if (!file) continue;
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) { file.moveTo = move[1].trim(); continue; }
    if (line.startsWith('*** End Patch')) { file = null; continue; }
    if (line.startsWith('*** End of File')) { file.lines.push({ type: 'note', text: 'End of file' }); continue; }
    if (line.startsWith('@@')) { file.lines.push({ type: 'hunk', text: line.slice(2).trim() }); continue; }
    if (line.startsWith('+')) { file.lines.push({ type: 'add', text: line.slice(1) }); file.added++; continue; }
    if (line.startsWith('-')) { file.lines.push({ type: 'del', text: line.slice(1) }); file.removed++; continue; }
    file.lines.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
  }
  // A trailing empty context line is the newline before End Patch, not content.
  for (const f of files) while (f.lines.at(-1)?.type === 'ctx' && !f.lines.at(-1)?.text) f.lines.pop();
  return files;
}

/** A unified diff (git diff, diff -u) rather than prose that happens to contain + and - lines. */
export const isUnifiedDiff = (text: string) => /^(diff --git |--- \S.*\n\+\+\+ \S|@@ -\d+(,\d+)? \+\d+(,\d+)? @@)/m.test(text);

// ── Script output (Codex code mode) ──────────────────────────────────────────────────────────────

export interface ExecResult {
  label?: string;
  rejected?: boolean;
  exitCode?: number | null;
  wallSeconds?: number;
  tokens?: number;
  output: string;
  running?: boolean;
}

export type OutputPart =
  | { type: 'exec'; exec: ExecResult }
  | { type: 'json'; text: string }
  | { type: 'text'; text: string }
  | { type: 'error'; text: string }
  | { type: 'image' };

export interface ToolOutput { status?: 'completed' | 'failed'; wallSeconds?: number; parts: OutputPart[] }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function execResult(value: unknown): ExecResult | null {
  let label: string | undefined, rejected = false, inner = value;
  // Promise.allSettled entries: {status, value: [label, result] | result} or {status: 'rejected', reason}.
  if (isRecord(value) && (value.status === 'fulfilled' || value.status === 'rejected') && ('value' in value || 'reason' in value)) {
    rejected = value.status === 'rejected';
    inner = rejected ? value.reason : value.value;
    if (Array.isArray(inner) && inner.length === 2 && typeof inner[0] === 'string') { label = inner[0]; inner = inner[1]; }
    if (rejected) return { label, rejected, output: typeof inner === 'string' ? inner : JSON.stringify(inner, null, 2) };
  }
  if (!isRecord(inner) || !('output' in inner) || !('exit_code' in inner || 'wall_time_seconds' in inner || 'session_id' in inner)) return null;
  return {
    label, rejected,
    exitCode: typeof inner.exit_code === 'number' ? inner.exit_code : null,
    wallSeconds: typeof inner.wall_time_seconds === 'number' ? inner.wall_time_seconds : undefined,
    tokens: typeof inner.original_token_count === 'number' ? inner.original_token_count : undefined,
    output: typeof inner.output === 'string' ? inner.output.replace(/\r\n/g, '\n') : JSON.stringify(inner.output, null, 2),
    running: inner.exit_code == null && 'session_id' in inner,
  };
}

/** Splits a tool result into its header, exec results, JSON values and plain text. */
export function parseToolOutput(text: string): ToolOutput {
  const out: ToolOutput = { parts: [] };
  let body = text;
  const script = /^Script (completed|failed)\r?\nWall time ([\d.]+) seconds\r?\nOutput:\r?\n(?:\r?\n)?/.exec(body);
  const wall = script ? null : /^Wall time: ([\d.]+) seconds\r?\n/.exec(body);
  if (script) { out.status = script[1] as ToolOutput['status']; out.wallSeconds = Number(script[2]); body = body.slice(script[0].length); }
  else if (wall) { out.wallSeconds = Number(wall[1]); body = body.slice(wall[0].length); }

  const whole = jsonValue(body);
  if (whole !== undefined) {
    const exec = execResult(whole);
    out.parts.push(exec ? { type: 'exec', exec } : { type: 'json', text: JSON.stringify(whole, null, 2) });
    return out;
  }
  let prose: string[] = [];
  const flush = () => {
    const joined = prose.join('\n');
    if (joined.trim()) out.parts.push({ type: 'text', text: joined.replace(/^\n+|\n+$/g, '') });
    prose = [];
  };
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Script error:\s*$/.test(line)) { flush(); out.parts.push({ type: 'error', text: lines.slice(i + 1).join('\n').trim() }); break; }
    if (line.trim() === '[image]') { flush(); out.parts.push({ type: 'image' }); continue; }
    const value = /^\s*[[{]/.test(line) ? jsonValue(line) : undefined;
    if (value === undefined) { prose.push(line); continue; }
    flush();
    const exec = execResult(value);
    out.parts.push(exec ? { type: 'exec', exec } : { type: 'json', text: JSON.stringify(value, null, 2) });
  }
  flush();
  return out;
}

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

export interface ToolError { title: string; exitCode?: number; command?: string; detail?: string }

/** "Shell failed (exit 1): cmd" and "apply_patch verification failed: …" style messages, split for display. */
export function parseToolError(text: string): ToolError {
  const exit = /^(.{1,60}?) failed \(exit (-?\d+)\)(?::\s*([\s\S]*))?$/.exec(text.trim());
  if (exit) return { title: `${exit[1]} failed`, exitCode: Number(exit[2]), command: exit[3]?.trim() || undefined };
  const colon = /^([^:\n]{3,80}):\s+([\s\S]+)$/.exec(text.trim());
  if (colon && !/[\\/]$/.test(colon[1]) && !/^[A-Za-z]$/.test(colon[1])) return { title: colon[1], detail: colon[2] };
  const [first, ...rest] = text.trim().split('\n');
  return { title: first, detail: rest.join('\n').trim() || undefined };
}

// ── Languages for results ────────────────────────────────────────────────────────────────────────

const READ_COMMAND = /(?:^|[;|&]\s*)(?:Get-Content|gc|cat|type|bat|head|tail|less|more|sed\s+-n\s+\S+|nl)\b[^;|&]*?(['"]?)([^\s'";|&]+\.[\w-]+)\1/i;

/** The language a command's output is in, when the command only prints one file. */
export function outputLang(command?: string): Lang | null {
  // Several statements print several things (headers, status lines), so only single reads qualify.
  if (!command || /;|&&|\|\||\r?\n/.test(command.trim())) return null;
  const read = READ_COMMAND.exec(command);
  return read ? langFromPath(read[2]) : null;
}

/** How to show a block of command output: diff rows, highlighted as a language, or plain. */
export function outputView(text: string, command?: string): { kind: 'diff' } | { kind: 'code'; lang: Lang | null } {
  if (isUnifiedDiff(text)) return { kind: 'diff' };
  const lang = outputLang(command);
  if (lang) return { kind: 'code', lang };
  return { kind: 'code', lang: jsonValue(text) !== undefined ? 'json' : null };
}

/** Shows a path relative to the run's project when it lies inside it. */
export function shortPath(file: string, project?: string | null): string {
  if (!project) return file;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(file), b = norm(project);
  return a.toLowerCase().startsWith(b.toLowerCase() + '/') ? a.slice(b.length + 1) : file;
}
