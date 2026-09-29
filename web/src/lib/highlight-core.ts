import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core';

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

export async function tokenizeLocal(text: string, lang: Lang): Promise<ThemedToken[][]> {
  const shiki = await highlighter();
  let ready = loading.get(lang);
  if (!ready) {
    ready = GRAMMARS[lang]().then(module => shiki.loadLanguage(...module.default));
    loading.set(lang, ready);
    ready.catch(() => loading.delete(lang));
  }
  await ready;
  return shiki.codeToTokensBase(text, { lang, theme: 'dashboard', tokenizeMaxLineLength: 5000, tokenizeTimeLimit: 300 });
}
