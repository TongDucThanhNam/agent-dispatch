import { cn } from '@/lib/utils';
import { stateLabel, TONE_ICON, tone, toneSoft, toneText, type Tone } from '@/lib/status';

export function StatusIcon({ state, className }: { state?: string | null; className?: string }) {
  const t = tone(state), Icon = TONE_ICON[t];
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', toneText[t], t === 'running' && 'animate-spin [animation-duration:2.4s]', className)} />;
}

/** Pill with a tone colour, e.g. "Running", "Ready for review", "Repeated tool errors". */
export function StatusBadge({ state, className, toneOverride }: { state?: string | null; className?: string; toneOverride?: Tone }) {
  const t = toneOverride ?? tone(state);
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium ring-1 ring-inset', toneSoft[t], className)}>
      <span className="relative flex size-1.5">
        {t === 'running' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />}
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
      {stateLabel(state)}
    </span>
  );
}

export function LiveDot({ tone: t = 'running', className }: { tone?: Tone; className?: string }) {
  return (
    <span className={cn('relative flex size-2 shrink-0', toneText[t], className)} aria-hidden>
      {t === 'running' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-50" />}
      <span className="relative inline-flex size-2 rounded-full bg-current" />
    </span>
  );
}
