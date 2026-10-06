// Shared shape for every module's loading.tsx. Next.js wraps each module
// layout's {children} slot in a Suspense boundary automatically whenever a
// sibling loading.tsx exists — this is what actually shows the instant the
// user clicks a nav link, while the destination page's own data fetches
// stream in behind it. Without any loading.tsx (the state before this),
// navigation had zero visual feedback until a page's queries fully
// resolved server-side, which is what made switching tabs feel frozen
// regardless of the actual latency involved — see AGENTS.md.
export function RouteLoadingSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="border-b border-border bg-surface px-4 py-4 sm:px-6 lg:px-8">
        <div className="h-6 w-40 animate-pulse rounded-control bg-surface-secondary" />
      </div>
      <div className="space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-panel border border-border bg-surface-secondary" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-panel border border-border bg-surface-secondary" />
      </div>
    </div>
  );
}
