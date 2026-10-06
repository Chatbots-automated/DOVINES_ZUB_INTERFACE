import { BrandMark } from "@/components/layout/brand-mark";

// Matches the module-selector page's dark hero so navigating to "/" (e.g.
// after sign-out -> sign-in, or the sidebar's "Modulių pasirinkimas" link)
// doesn't flash white while its 4 parallel KPI queries resolve.
export default function ProtectedRootLoading() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center gap-4 overflow-hidden bg-ink">
      <div aria-hidden className="bg-ripples pointer-events-none absolute inset-0 opacity-[0.05]" />
      <div className="relative">
        <BrandMark dark size="lg" />
      </div>
      <div className="relative h-1 w-32 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-white/40" />
      </div>
    </div>
  );
}
