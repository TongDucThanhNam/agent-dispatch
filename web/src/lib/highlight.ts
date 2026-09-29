import type { ThemedToken } from 'shiki/core';
import type { Lang } from './highlight-core';
export type { Lang } from './highlight-core';

const ALIASES: Record<string, Lang> = {
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', geojson: 'json',
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', typescript: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  ps: 'powershell', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', pwsh: 'powershell', powershell: 'powershell',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', shellscript: 'shellscript', console: 'shellscript',
  py: 'python', python: 'python', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', vue: 'html', svelte: 'html', xml: 'xml', svg: 'xml', plist: 'xml', csproj: 'xml',
  sql: 'sql', rs: 'rust', rust: 'rust', go: 'go', cs: 'csharp', csharp: 'csharp', java: 'java', kt: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', 'c++': 'cpp',
  ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini', dockerfile: 'dockerfile', docker: 'dockerfile',
  diff: 'diff', patch: 'diff',
};

/** A fence info string or file extension as a supported language, or null for plain text. */
export const langOf = (name?: string | null): Lang | null => (name ? ALIASES[name.trim().toLowerCase()] ?? null : null);

/** The language of a file path by its extension (or name, for Dockerfile). */
export function langFromPath(file?: string | null): Lang | null {
  if (!file) return null;
  const base = file.split(/[\\/]/).pop() ?? '';
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? langOf(base.slice(dot + 1)) : null;
}

/** Codex on Windows runs PowerShell; everything else is treated as POSIX shell. */
export function shellLang(command: string): Lang {
  return /\$\w+\s*=|\$LASTEXITCODE|\$ErrorActionPreference|\b(?:Get|Set|Select|Where|ForEach|Write|Test|New|Remove|Out|Join|Split|Resolve|Start|Stop|Invoke|Measure|Sort|Copy|Move)-[A-Z]\w+|-LiteralPath\b|\*>\s*\$null/.test(command)
    ? 'powershell' : 'shellscript';
}

/** Very large blocks remain plain; smaller blocks are tokenized off the main thread. */
export const HIGHLIGHT_LIMIT = 120_000;

// LRU bounded by both entry count and source size; in-flight work is deduplicated.
const cache = new Map<string, ThemedToken[][]>();
const inflight = new Map<string, Promise<ThemedToken[][]>>();
const jobs = new Map<number, { resolve: (tokens: ThemedToken[][]) => void; reject: (error: Error) => void }>();
let worker: Worker | null = null, sequence = 0, cachedChars = 0;

function highlighterWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module', name: 'syntax-highlighter' });
  worker.onmessage = (event: MessageEvent<{ id: number; tokens?: ThemedToken[][]; error?: string }>) => {
    const job = jobs.get(event.data.id);
    if (!job) return;
    jobs.delete(event.data.id);
    if (event.data.tokens) job.resolve(event.data.tokens); else job.reject(new Error(event.data.error ?? 'Highlighting failed.'));
  };
  worker.onerror = () => {
    for (const job of jobs.values()) job.reject(new Error('Highlighting is unavailable.'));
    jobs.clear(); worker?.terminate(); worker = null;
  };
  return worker;
}

export function cachedTokens(text: string, lang: Lang): ThemedToken[][] | undefined {
  const key = lang + '\0' + text, tokens = cache.get(key);
  if (tokens) { cache.delete(key); cache.set(key, tokens); }
  return tokens;
}

export function tokenize(text: string, lang: Lang): Promise<ThemedToken[][]> {
  const hit = cachedTokens(text, lang);
  if (hit) return Promise.resolve(hit);
  const key = lang + '\0' + text, pending = inflight.get(key);
  if (pending) return pending;
  const request = new Promise<ThemedToken[][]>((resolve, reject) => {
    const target = highlighterWorker(), id = ++sequence;
    jobs.set(id, { resolve, reject }); target.postMessage({ id, text, lang });
  }).then(tokens => {
    cache.set(key, tokens); cachedChars += key.length;
    while (cache.size > 60 || cachedChars > 500_000) {
      const oldest = cache.keys().next().value!; cachedChars -= oldest.length; cache.delete(oldest);
    }
    return tokens;
  }).finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}
