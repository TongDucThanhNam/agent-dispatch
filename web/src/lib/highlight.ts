import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core';

// Shiki with the JavaScript regex engine: the hub's CSP has no 'wasm-unsafe-eval', so Oniguruma is out.
// Grammars load on first use, one chunk each. Colours come from CSS variables (--code-*) so both themes
// follow the dashboard palette without re-highlighting.

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

const GRAMMARS = {
  json: () => import('shiki/langs/json.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
} satisfies Record<string, Grammar>;

export type Lang = keyof typeof GRAMMARS;

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

/** Characters above which text is shown plain: tokenizing stays well under a frame for anything smaller. */
export const HIGHLIGHT_LIMIT = 120_000;

let core: Promise<HighlighterCore> | null = null;
const loading = new Map<Lang, Promise<void>>();

function highlighter() {
  core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([shiki, engine]) => {
    const theme = shiki.createCssVariablesTheme({ name: 'dashboard', variablePrefix: '--code-', fontStyle: true });
    // Shell variables read better coloured; the stock variable theme leaves them as plain text.
    theme.tokenColors?.push({ scope: ['source.powershell variable', 'source.shell variable'], settings: { foreground: 'var(--code-token-parameter)' } });
    return shiki.createHighlighterCore({ themes: [theme], langs: [], engine: engine.createJavaScriptRegexEngine({ forgiving: true }) });
  });
  return core;
}

// Recent results, so a remounted block (tab switch, reselecting an event) paints highlighted at once.
const cache = new Map<string, ThemedToken[][]>();
const CACHE_SIZE = 60;

export function cachedTokens(text: string, lang: Lang): ThemedToken[][] | undefined {
  return cache.get(`${lang}\u0000${text}`);
}

export async function tokenize(text: string, lang: Lang): Promise<ThemedToken[][]> {
  const key = `${lang}\u0000${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const shiki = await highlighter();
  let ready = loading.get(lang);
  if (!ready) {
    ready = GRAMMARS[lang]().then(module => shiki.loadLanguage(...module.default));
    loading.set(lang, ready);
    ready.catch(() => loading.delete(lang));
  }
  await ready;
  // Very long lines (minified bundles, one-line JSON dumps) stay plain rather than stalling the page.
  const tokens = shiki.codeToTokensBase(text, { lang, theme: 'dashboard', tokenizeMaxLineLength: 5000, tokenizeTimeLimit: 300 });
  cache.set(key, tokens);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return tokens;
}
