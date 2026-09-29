import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ThemedToken } from 'shiki/core';
import { AlertCircle, Check, Copy, FileMinus2, FilePen, FilePlus2, WrapText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cachedTokens, HIGHLIGHT_LIMIT, langFromPath, langOf, tokenize, type Lang } from '@/lib/highlight';
import { copyText } from '@/lib/hooks';
import { shortPath, type PatchFile, type PatchLine } from '@/lib/tool-content';
import { cn } from '@/lib/utils';

export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    setState(await copyText(text) ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 1400);
  };
  return (
    <Button variant="ghost" size="icon-xs" className={cn('size-5 text-muted-foreground', className)} onClick={() => void copy()} aria-label={`Copy ${label}`}
      title={state === 'failed' ? 'Clipboard unavailable — select the text to copy' : `Copy ${label}`}>
      {state === 'copied' ? <Check className="text-success" /> : state === 'failed' ? <AlertCircle className="text-destructive" /> : <Copy />}
    </Button>
  );
}

/** Highlighted lines once the grammar is loaded (plain text until then, and for very large text). */
export function useTokens(text: string, lang: Lang | null | undefined): ThemedToken[][] | null {
  const enabled = Boolean(lang) && text.length > 0 && text.length <= HIGHLIGHT_LIMIT;
  const [done, setDone] = useState<{ text: string; lang: Lang; tokens: ThemedToken[][] } | null>(null);
  useEffect(() => {
    if (!enabled || !lang || cachedTokens(text, lang)) return;
    let live = true;
    tokenize(text, lang).then(tokens => { if (live) setDone({ text, lang, tokens }); }, () => {});
    return () => { live = false; };
  }, [enabled, text, lang]);
  if (!enabled || !lang) return null;
  return cachedTokens(text, lang) ?? (done && done.text === text && done.lang === lang ? done.tokens : null);
}

const tokenStyle = (token: ThemedToken): CSSProperties => ({
  color: token.color,
  fontStyle: token.fontStyle && token.fontStyle & 1 ? 'italic' : undefined,
  fontWeight: token.fontStyle && token.fontStyle & 2 ? 600 : undefined,
  textDecoration: token.fontStyle && token.fontStyle & 4 ? 'underline' : undefined,
});

const Line = ({ tokens }: { tokens: ThemedToken[] }) => <>{tokens.map((token, i) => <span key={i} style={tokenStyle(token)}>{token.content}</span>)}</>;

const lineCount = (text: string) => { let n = 1; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

// Long blocks start clamped with a fade; the fade is a mask so it works on any background.
const FADE: CSSProperties = { maskImage: 'linear-gradient(to bottom, #000 70%, transparent)' };
// A clamped tail (the end of a failed command's output, where the error is) fades in from the top instead.
const FADE_IN: CSSProperties = { maskImage: 'linear-gradient(to bottom, transparent, #000 4.5em)' };
const LEADING = 1.6;

function Clamp({ lines, maxLines, tail, children }: { lines: number; maxLines: number; tail?: boolean; children: (clamped: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const clampable = maxLines > 0 && lines > maxLines + 6;
  const above = tail && !open;
  const toggle = clampable && (
    <div className={cn('flex items-center justify-center border-dashed py-1', above ? 'border-b' : 'border-t')}>
      <Button variant="ghost" size="xs" className="h-5 text-[11px] text-muted-foreground" onClick={() => setOpen(!open)}>
        {open ? 'Collapse' : tail ? `Showing the last ${maxLines} · show all ${lines.toLocaleString()} lines` : `Show all ${lines.toLocaleString()} lines`}
      </Button>
    </div>
  );
  return <>{above && toggle}{children(clampable && !open)}{!above && toggle}</>;
}

/** A highlighted text block without chrome. */
export function CodeView({ text, lang, wrap = true, maxLines = 24, tail, className }: {
  text: string; lang?: Lang | null; wrap?: boolean; maxLines?: number; tail?: boolean; className?: string;
}) {
  const tokens = useTokens(text, lang);
  const lines = useMemo(() => lineCount(text), [text]);
  return (
    <Clamp lines={lines} maxLines={maxLines} tail={tail}>
      {clamped => {
        const from = clamped && tail ? lines - maxLines : 0;
        const shown = tokens ? tokens.slice(from) : from ? text.split('\n').slice(from).join('\n') : text;
        return (
          <pre className={cn('overflow-x-auto px-3 py-2 font-mono text-[11.5px] text-(--code-foreground)', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
            clamped && 'overflow-hidden', className)}
            style={{ lineHeight: LEADING, ...(clamped ? (tail ? FADE_IN : { ...FADE, maxHeight: `${maxLines * LEADING + 1}em` }) : null) }}>
            {typeof shown === 'string' ? shown || ' ' : shown.map((line, i) => <Fragment key={i}><Line tokens={line} />{i < shown.length - 1 ? '\n' : null}</Fragment>)}
          </pre>
        );
      }}
    </Clamp>
  );
}

export const LANG_LABEL: Partial<Record<Lang, string>> = { shellscript: 'shell', powershell: 'PowerShell', javascript: 'JavaScript', typescript: 'TypeScript', tsx: 'TSX', json: 'JSON' };

/** A titled, highlighted block with wrap and copy controls. */
export function CodeCard({ text, lang, title, meta, actions, tone, maxLines, tail, defaultWrap = true, footer, className }: {
  text: string; lang?: Lang | null; title?: ReactNode; meta?: ReactNode; actions?: ReactNode; tone?: 'danger' | 'success';
  maxLines?: number; tail?: boolean; defaultWrap?: boolean; footer?: ReactNode; className?: string;
}) {
  const [wrap, setWrap] = useState(defaultWrap);
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border bg-background/70', tone === 'danger' && 'border-destructive/35', className)}>
      <div className={cn('flex min-h-7 min-w-0 items-center gap-2 border-b bg-muted/45 py-0.5 pr-1 pl-2.5 text-[11px]', tone === 'danger' && 'border-destructive/25 bg-destructive/6')}>
        {title && <span className="shrink-0 font-medium text-foreground/85">{title}</span>}
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-muted-foreground">{meta}</span>
        <span className="flex shrink-0 items-center gap-0.5">
          {actions}
          {lang && <span className="px-1 text-[10px] text-muted-foreground/80">{LANG_LABEL[lang] ?? lang}</span>}
          <Button variant="ghost" size="icon-xs" className={cn('size-5', wrap ? 'text-foreground/80' : 'text-muted-foreground/70')} onClick={() => setWrap(!wrap)}
            aria-pressed={wrap} aria-label="Wrap long lines" title={wrap ? 'Wrapping long lines' : 'Not wrapping long lines'}>
            <WrapText />
          </Button>
          <CopyButton text={text} label={typeof title === 'string' ? title.toLowerCase() : 'text'} />
        </span>
      </div>
      <CodeView text={text} lang={lang} wrap={wrap} maxLines={maxLines} tail={tail} />
      {footer}
    </div>
  );
}

// ── Diffs ────────────────────────────────────────────────────────────────────────────────────────

const SIGN: Record<PatchLine['type'], string> = { add: '+', del: '−', ctx: ' ', hunk: '', note: '' };

function DiffRows({ lines, lang, wrap, clamped, maxLines }: { lines: PatchLine[]; lang: Lang | null; wrap: boolean; clamped: boolean; maxLines: number }) {
  // Old and new lines are highlighted as one document: close enough for reading, one tokenizer pass.
  const code = useMemo(() => lines.filter(l => l.type === 'add' || l.type === 'del' || l.type === 'ctx').map(l => l.text).join('\n'), [lines]);
  const tokens = useTokens(code, lang);
  let row = 0;
  return (
    <div className={cn('overflow-x-auto py-1 font-mono text-[11.5px]', clamped && 'overflow-hidden')}
      style={{ lineHeight: LEADING, ...(clamped ? { ...FADE, maxHeight: `${maxLines * LEADING + 0.5}em` } : null) }}>
      <div className={cn(!wrap && 'w-max min-w-full')}>
        {lines.map((line, i) => {
          if (line.type === 'hunk' || line.type === 'note') {
            return (
              <div key={i} className="px-3 text-[10.5px] text-info/85 select-none">
                {line.type === 'hunk' ? `@@ ${line.text}` : line.text}
              </div>
            );
          }
          const lineTokens = tokens?.[row++];
          return (
            <div key={i} className={cn('flex', line.type === 'add' && 'bg-success/12', line.type === 'del' && 'bg-destructive/10')}>
              <span className={cn('w-6 shrink-0 text-center select-none', line.type === 'add' ? 'text-success' : line.type === 'del' ? 'text-destructive' : 'text-muted-foreground/40')}>
                {SIGN[line.type]}
              </span>
              <span className={cn('min-w-0 pr-3', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
                {lineTokens ? <Line tokens={lineTokens} /> : line.text || ' '}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const OP = {
  update: { icon: FilePen, label: 'Update', className: 'text-info' },
  add: { icon: FilePlus2, label: 'Add', className: 'text-success' },
  delete: { icon: FileMinus2, label: 'Delete', className: 'text-destructive' },
} as const;

/** One file of an apply_patch body. */
export function PatchFileView({ file, project, maxLines = 40 }: { file: PatchFile; project?: string | null; maxLines?: number }) {
  const [wrap, setWrap] = useState(true);
  const op = OP[file.op], path = shortPath(file.path, project);
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const text = file.lines.map(l => l.type === 'hunk' ? `@@ ${l.text}` : l.type === 'note' ? '' : `${SIGN[l.type] === '−' ? '-' : SIGN[l.type]}${l.text}`).join('\n');
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-background/70">
      <div className="flex min-h-7 min-w-0 items-center gap-2 border-b bg-muted/45 py-0.5 pr-1 pl-2.5 text-[11px]">
        <op.icon className={cn('size-3.5 shrink-0', op.className)} aria-label={op.label} />
        <span className="min-w-0 truncate font-mono text-[11px]" title={file.path}>
          {slash >= 0 && <span className="text-muted-foreground">{path.slice(0, slash + 1)}</span>}
          <span className="font-medium">{path.slice(slash + 1)}</span>
          {file.moveTo && <span className="text-muted-foreground"> → {shortPath(file.moveTo, project)}</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular">
          {file.added > 0 && <span className="text-success">+{file.added}</span>}
          {file.removed > 0 && <span className="text-destructive">−{file.removed}</span>}
          <Button variant="ghost" size="icon-xs" className={cn('size-5', wrap ? 'text-foreground/80' : 'text-muted-foreground/70')} onClick={() => setWrap(!wrap)}
            aria-pressed={wrap} aria-label="Wrap long lines"><WrapText /></Button>
          <CopyButton text={text} label="patch" />
        </span>
      </div>
      {file.lines.length > 0 && (
        <Clamp lines={file.lines.length} maxLines={maxLines}>
          {clamped => <DiffRows lines={file.lines} lang={langFromPath(file.path)} wrap={wrap} clamped={clamped} maxLines={maxLines} />}
        </Clamp>
      )}
    </div>
  );
}

/** Unified diff text (git diff output, ```diff fences) as coloured rows. */
export function UnifiedDiff({ text, title = 'Diff', meta, actions, maxLines = 40 }: {
  text: string; title?: ReactNode; meta?: ReactNode; actions?: ReactNode; maxLines?: number;
}) {
  const [wrap, setWrap] = useState(true);
  const lines = useMemo<PatchLine[]>(() => text.replace(/\r\n/g, '\n').split('\n').map(line =>
    line.startsWith('@@') ? { type: 'hunk', text: line.replace(/^@@\s*/, '') }
      : /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line) ? { type: 'note', text: line }
      : line.startsWith('+') ? { type: 'add', text: line.slice(1) }
      : line.startsWith('-') ? { type: 'del', text: line.slice(1) }
      : { type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line }), [text]);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-background/70">
      <div className="flex min-h-7 min-w-0 items-center gap-2 border-b bg-muted/45 py-0.5 pr-1 pl-2.5 text-[11px]">
        <span className="shrink-0 font-medium text-foreground/85">{title}</span>
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-muted-foreground">{meta}</span>
        <span className="flex shrink-0 items-center gap-0.5">
          {actions}
          <span className="px-1 text-[10px] text-muted-foreground/80">diff</span>
          <Button variant="ghost" size="icon-xs" className={cn('size-5', wrap ? 'text-foreground/80' : 'text-muted-foreground/70')} onClick={() => setWrap(!wrap)}
            aria-pressed={wrap} aria-label="Wrap long lines"><WrapText /></Button>
          <CopyButton text={text} label="diff" />
        </span>
      </div>
      <Clamp lines={lines.length} maxLines={maxLines}>
        {clamped => <DiffRows lines={lines} lang={null} wrap={wrap} clamped={clamped} maxLines={maxLines} />}
      </Clamp>
    </div>
  );
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
const hastText = (node?: HastNode): string => (node ? node.value ?? (node.children ?? []).map(hastText).join('') : '');

const MARKDOWN: Components = {
  // Fenced code goes through Shiki; inline code keeps the .markdown styles.
  pre({ node }) {
    const code = (node as unknown as HastNode | undefined)?.children?.find(child => child.tagName === 'code');
    const classes = code?.properties?.className;
    const name = /language-([\w+#.-]+)/.exec(Array.isArray(classes) ? classes.join(' ') : String(classes ?? ''))?.[1];
    const text = hastText(code).replace(/\n$/, '');
    if (name === 'diff' || name === 'patch') return <UnifiedDiff text={text} maxLines={30} />;
    return <CodeCard text={text} lang={langOf(name)} title={name && !langOf(name) ? name : undefined} maxLines={30} />;
  },
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn('markdown', className)}><ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>{text}</ReactMarkdown></div>;
}
