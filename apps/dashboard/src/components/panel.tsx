import type { PropsWithChildren, ReactNode } from "react";

interface PanelProps extends PropsWithChildren {
  title: string;
  subtitle?: string;
  className?: string;
  rightSlot?: ReactNode;
}

export function Panel({ title, subtitle, className, rightSlot, children }: PanelProps) {
  return (
    <section className={`panel-surface rounded-2xl p-3 ${className ?? ""}`}>
      <header className="mb-3 flex items-start justify-between gap-2 border-b border-slate-700/60 pb-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold leading-none text-slate-100 sm:text-lg">{title}</h2>
          {subtitle ? <p className="mt-1 text-[11px] tracking-wide text-slate-400 sm:text-xs">{subtitle}</p> : null}
        </div>
        {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
      </header>
      {children}
    </section>
  );
}
