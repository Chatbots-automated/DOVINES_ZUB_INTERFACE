import { revalidatePath } from "next/cache";

// Anything that consumes stock touches most screens at once: the animal's
// history/karencija, stock levels, the journals, the DelPro queue and the
// write-off acts. The app is small and single-farm, so refresh everything
// under the root layout rather than maintain a per-page list that drifts.
export function revalidateUsageViews() {
  revalidatePath("/", "layout");
}
