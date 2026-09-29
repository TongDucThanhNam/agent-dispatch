import type { ReactNode } from 'react';

export function Fields({ fields }: { fields: [string, ReactNode][] }) {
  const shown = fields.filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== '—');
  if (!shown.length) return null;
  return (
    <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {shown.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="min-w-0 break-words tabular">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mt-5 mb-2 flex items-baseline gap-2 first:mt-0">
      <h3 className="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{children}</h3>
      {aside && <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">{aside}</span>}
    </div>
  );
}
