import { addDays, vilniusDay } from "@/lib/visits";

// Period selector for the Pagrindinis / Analitika pages (?period=…).
export const PERIOD_OPTIONS = [
  { value: "30d", label: "30 d." },
  { value: "90d", label: "90 d." },
  { value: "12m", label: "12 mėn." },
  { value: "ytd", label: "Šie metai" },
] as const;

export type PeriodKey = (typeof PERIOD_OPTIONS)[number]["value"];

export type Period = { key: PeriodKey; label: string; from: string; to: string; today: string };

const MONTHS_SHORT = ["Sau", "Vas", "Kov", "Bal", "Geg", "Bir", "Lie", "Rgp", "Rgs", "Spa", "Lap", "Gru"];

/** Resolves ?period= against the farm's calendar day; unknown values fall back. */
export function resolvePeriod(raw: string | undefined, fallback: PeriodKey): Period {
  const key = (PERIOD_OPTIONS.find((p) => p.value === raw)?.value ?? fallback) as PeriodKey;
  const today = vilniusDay(new Date());
  const [y, m] = today.split("-").map(Number);
  let from: string;
  if (key === "30d") from = addDays(today, -29);
  else if (key === "90d") from = addDays(today, -89);
  else if (key === "ytd") from = `${y}-01-01`;
  else {
    const d = new Date(Date.UTC(y, m - 1 - 11, 1));
    from = d.toISOString().slice(0, 10);
  }
  return { key, label: PERIOD_OPTIONS.find((p) => p.value === key)!.label, from, to: today, today };
}

/** First day of every month from..to (YYYY-MM-01). */
export function monthStarts(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** "Spa" / "Spa '26" for the first column and every January. */
export function monthLabel(monthStart: string, withYear: boolean): { short: string; year: string | null } {
  const [y, m] = monthStart.split("-").map(Number);
  return { short: MONTHS_SHORT[m - 1], year: withYear || m === 1 ? `'${String(y).slice(2)}` : null };
}
