import type { ReactNode } from "react";
import { Info } from "lucide-react";

// The "Ką čia daryti" box at the top of each DelPro section: what the section is for
// and the steps, in the farm's words. Server component (plain markup).
export function HowTo({ title = "Ką čia daryti", intro, steps, note }: { title?: string; intro?: ReactNode; steps: ReactNode[]; note?: ReactNode }) {
  return (
    <div className="rounded-panel border border-info/25 bg-info-soft/60 px-4 py-3 text-[13px] leading-relaxed">
      <p className="mb-1 flex items-center gap-1.5 font-semibold text-text-primary">
        <Info className="size-4 text-info" /> {title}
      </p>
      {intro && <p className="mb-1.5 text-text-secondary">{intro}</p>}
      <ol className="list-decimal space-y-0.5 pl-5 text-text-secondary">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {note && <p className="mt-1.5 text-[12px] text-text-muted">{note}</p>}
    </div>
  );
}
