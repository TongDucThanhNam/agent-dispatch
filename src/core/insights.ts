import fs from 'node:fs';
import path from 'node:path';
import { readJson, isAlive } from './fsutil.ts';
import { shortRef } from './config.ts';
import { isSettled } from './status.ts';
import { openTelemetry } from '../monitor/monitor-core.ts';
import { readEventPreviews, readEventContent, readToolCallId, readToolOutputBytes } from '../monitor/event-content.ts';
import { readToolImage } from '../monitor/event-images.ts';
import { computeInsights, needsPreview, type Finding } from '../../shared/insights/insights.ts';
import type { Run, Preview, TrajectoryEvent } from '../../web/src/lib/types.ts';
import { labelled } from '../protocol/errors.ts';
import { prune } from '../protocol/output.ts';

const MAX_INPUT = 256 * 1024, MAX_INPUT_BYTES = 32 * 1024 * 1024;
const EDITS = /edit|write|patch|replace|create|todo|notebook/i;
const WRITES = /\b(?:apply_patch|writeFileSync|writeFile|appendFileSync|appendFile)\s*\(|\b(?:Set-Content|Add-Content|Out-File)\b/i;
const FILE_EXT = /\.(?:[cm]?[jt]sx?|json[lc5]?|mdx?|ya?ml|toml|ini|cfg|conf|txt|log|csv|sql|sqlite|db|html?|css|scss|vue|svelte|py|rs|go|java|[ch](?:pp)?|cs|sh|ps1|bat|cmd|exe|png|jpe?g|webp|svg|gif|pdf|zip)$/i;

function load(runDir: string, now: number) {
  const config = readJson(path.join(runDir, 'config.json')), state = readJson(path.join(runDir, 'status.json'));
  if (state.runId !== config.runId || path.resolve(config.runDir) !== path.resolve(runDir)) throw new Error('Run record identity differs.');
  const settled = isSettled({ ...state, runnerAlive: isAlive(state.runnerPid) });
  const ref = shortRef(state.runId), coverage = { available: false, settled };
  if (!state.sessionId) return { ref, coverage: { ...coverage, reason: 'The run has no recorded session.' } };
  if (!config.dbPath || !fs.existsSync(config.dbPath)) return { ref, coverage: { ...coverage, reason: 'Session database is not available yet.' } };
  const source = { sessionId: state.sessionId, project: config.project, startedAt: state.startedAt };
  const reader = openTelemetry(config.dbPath);
  let telemetry;
  try { telemetry = reader.read({ ...source, runId: state.runId, includeTrajectory: true }); } finally { reader.close(); }
  if (!telemetry.available) throw new Error(telemetry.reason);
  if (!telemetry.trajectory) return { ref, coverage: { ...coverage, reason: 'The run has no recorded trajectory.' } };
  const run = { ...state, ref, project: config.project, active: !settled, trajectory: telemetry.trajectory } as Run;
  const previews = new Map<string, Preview>(), ids = run.trajectory.events.filter(needsPreview).map(e => e.id);
  for (let i = 0; i < ids.length; i += 100) {
    const result = readEventPreviews(config.dbPath, { ...source, ids: ids.slice(i, i + 100) });
    for (const [id, preview] of Object.entries(result.previews)) previews.set(id, preview as Preview);
  }
  const analysis = computeInsights(run, previews, now);
  return { ref, config, source, run, analysis, coverage: { available: true, settled,
    trajectory: { events: run.trajectory.events.length, truncated: !!run.trajectory.truncated }, previews: analysis.coverage } };
}

/** Path mentions are evidence of navigation, not proof that the file was read. */
export function inputPaths(input: string, project: string): string[] {
  const strings: { text: string; isPath: boolean }[] = [];
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') strings.push({ text: value, isPath: /^(?:path|file_?path|AbsolutePath|TargetFile)$/i.test(key) });
    else if (Array.isArray(value)) value.forEach(v=>visit(v,key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v])=>visit(v,k));
  };
  try { visit(JSON.parse(input)); } catch { strings.push({ text: input, isPath: false }); }
  const prefix = project.replace(/\\+/g, '/').replace(/\/$/, '') + '/';
  const paths = new Set<string>();
  for (const { text, isPath } of strings) {
    const tokens = isPath ? [text] : text.replace(/\b(?:https?|data):\S+/g, '').replace(/\b[\w$]+\.[\w$]+(?=\s*\()/g, '')
      .match(/['"](?:[A-Za-z]:)?[\w.@~+\-/\\ ]+['"]|(?:[A-Za-z]:)?[\w.@~+\-/\\]+/g) ?? [];
    for (let token of tokens) {
      const quoted = /^['"]/.test(token);
      token = token.replace(/^['"]|['"]$/g, '').replace(/\\+/g, '/').replace(/^\.\//, '');
      if (!isPath && token.includes(' ') && !/^(?:[A-Za-z]:\/|\/)/.test(token)) {
        for (const file of inputPaths(token, project)) paths.add(file);
        continue;
      }
      if (token.toLowerCase() === prefix.slice(0,-1).toLowerCase()) continue;
      if (token.toLowerCase().startsWith(prefix.toLowerCase())) token = token.slice(prefix.length);
      if (!token || /(?:^|\/)\.agent-dispatch(?:\/|$)/i.test(token) || /^(?:https?|data):/i.test(token)) continue;
      const named = isPath || /^(?:Dockerfile|Makefile|LICENSE|README|\.env(?:\.[\w.-]+)?|\.gitignore|\.gitattributes|\.npmrc|\.editorconfig)$/.test(token);
      if (!token.includes('/') && !named && !(quoted || token === text || FILE_EXT.test(token))) continue;
      if (!named && !/^[\w .@~+-]+\.[a-zA-Z0-9]+$/.test(token.split('/').at(-1)!)) continue;
      if (!token.replace(/[.\/]/g, '')) continue;
      paths.add(path.posix.normalize(token));
    }
  }
  return [...paths];
}

function readEvidence(runDir: string, config, source, events: TrajectoryEvent[], full: boolean) {
  const tools = events.filter(e => e.kind === 'tool'), eligible = tools.filter(e => !EDITS.test(e.label));
  const files = new Map<string, { path: string; calls: number; firstIds: string[] }>();
  let bytes = 0, loaded = 0, missing = 0, truncated = 0, writes = 0;
  for (const event of eligible) {
    if (bytes >= MAX_INPUT_BYTES) break;
    let input = '', offset = 0, cut = false;
    for (;;) {
      const result = readEventContent(config.dbPath, { ...source, eventId: event.id, field: 'input', offset, limit: 65536 });
      const section = result.sections[0];
      if (!section) break;
      input += section.text; bytes += Buffer.byteLength(section.text);
      if (section.nextOffset == null) break;
      if (section.nextOffset >= MAX_INPUT || bytes >= MAX_INPUT_BYTES) { cut = true; break; }
      offset = section.nextOffset;
    }
    if (!input) { missing++; continue; }
    loaded++; if (cut) truncated++;
    if (WRITES.test(input)) { writes++; continue; }
    for (const file of inputPaths(input, config.project)) {
      const row = files.get(file) ?? { path: file, calls: 0, firstIds: [] };
      row.calls++; if (full || row.firstIds.length < 3) row.firstIds.push(event.id);
      files.set(file, row);
    }
  }
  const hotFiles = [...files.values()].filter(row => row.calls >= 3).sort((a,b) => b.calls - a.calls || a.path.localeCompare(b.path)).slice(0, 5);
  let images: { count: number; bytes: number } | undefined;
  const imageCoverage = config.workerKind === 'codex' && fs.existsSync(path.join(runDir, 'codex-rollout.jsonl'));
  if (imageCoverage) {
    images = { count: 0, bytes: 0 };
    for (const event of tools) {
      const callId = readToolCallId(config.dbPath, { ...source, eventId: event.id });
      if (!callId) continue;
      const first = readToolImage(runDir, callId, 0);
      if (!first) continue;
      images.count++; images.bytes += first.data.length;
      for (let n = 1; n < first.count; n++) {
        const next = readToolImage(runDir, callId, n);
        if (next) { images.count++; images.bytes += next.data.length; }
      }
    }
  }
  return { reads: { basis: 'paths mentioned in tool inputs', hotFiles, ...(images ? { images } : {}) },
    coverage: { inputs: { loaded, total: eligible.length, missing, truncated, writes, bytes, limitCharsPerCall: MAX_INPUT, limitBytes: MAX_INPUT_BYTES },
      images: imageCoverage ? { available: true, scope: 'trajectory tools; recorded raster data URLs' }
        : { available: false, reason: 'No supported image recording for this run.' } } };
}

export function compactFindings(findings: Finding[], full = false) {
  const selected = (full ? findings : findings.slice(0, 10)).map(f => ({ key: f.key, area: f.area, severity: f.severity,
    title: f.title, detail: f.detail, count: f.ids.length, ids: full ? f.ids : f.ids.slice(0, 3) }));
  return { findings: selected, dropped: { findings: findings.length - selected.length,
    ids: findings.reduce((n,f)=>n + f.ids.length, 0) - selected.reduce((n,f)=>n + f.ids.length, 0) } };
}

/** Optional status enrichment deliberately skips full inputs and image decoding. */
export function insightCounts(runDir: string) {
  try {
    const loaded = load(runDir, Date.now());
    if (!loaded.analysis) return undefined;
    const counts = { high: 0, medium: 0, low: 0 };
    for (const finding of loaded.analysis.findings) if (finding.severity !== 'info') counts[finding.severity]++;
    return counts;
  } catch { return undefined; }
}

export function runInsights(runDir: string, { full = false, now = Date.now() } = {}) {
  return labelled('IO_ERROR', () => {
    const loaded = load(runDir, now);
    if (!loaded.analysis || !loaded.run) return { ref: loaded.ref, coverage: loaded.coverage };
    const { run, config, source, analysis } = loaded;
    const evidence = readEvidence(runDir, config, source, run.trajectory.events, full), stats = run.trajectory.stats ?? {};
    const output = readToolOutputBytes(config.dbPath, source);
    const payload = { ref: loaded.ref, ...compactFindings(analysis.findings, full),
      totals: { requests: stats.requests, inputTokens: stats.inputTokens, cachedTokens: stats.cacheReadTokens,
        outputTokens: stats.outputTokens, toolCalls: run.trajectory.toolCalls, toolOutputBytes: output.bytes },
      reads: evidence.reads, coverage: { ...loaded.coverage, ...evidence.coverage,
        toolOutput: { recorded: output.recorded, total: output.total, basis: 'UTF-8 stored tool output; whole session since run start' } } };
    // Preserve finding text and evidence verbatim; remove lowest-ranked findings to fit the protocol line.
    while (!full && payload.findings.length && JSON.stringify({ v: 1, ok: true, cmd: 'insights', data: prune(payload) }).length > 3999) {
      const removed = payload.findings.pop()!;
      payload.dropped.findings++; payload.dropped.ids += removed.ids.length;
    }
    return payload;
  });
}
