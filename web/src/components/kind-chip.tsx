import { cn } from '@/lib/utils';
import { kindMeta } from '@/lib/status';

/** Small role chip for a trajectory event: User, Assistant, Tool, … */
export function KindChip({ kind, error, className, compact }: { kind: string; error?: boolean; className?: string; compact?: boolean }) {
  const meta = kindMeta(kind), Icon = meta.icon;
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium',
      error ? 'bg-destructive/12 text-destructive' : meta.soft, className)}>
      <Icon aria-hidden className="size-3" />
      {!compact && meta.role}
    </span>
  );
}
