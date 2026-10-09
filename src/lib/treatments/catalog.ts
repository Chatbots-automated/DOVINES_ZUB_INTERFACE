import { createClient } from "@/lib/supabase/client";
import { PRODUCT_WITHDRAWAL_COLUMNS } from "@/lib/administration-routes";
import { todayIso, type CatalogLot, type CatalogProduct } from "@/lib/treatments/planner";

// What can be given to an animal as a treatment: medicines, vaccines and
// treatment materials (biocides, bull semen, hoof products… are not).
export const TREATMENT_PRODUCT_CATEGORIES = ["medicines", "vakcina", "profilaktika", "boliusai", "treatment_materials"] as const;

type ProductRow = Omit<CatalogProduct, "usable_qty" | "expired_qty" | "lots">;
type BatchRow = CatalogLot & { product_id: string; received_at: string };

/** Products + live usable stock, loaded when the dialog opens so stock is fresh. */
export async function loadTreatmentCatalog(): Promise<CatalogProduct[]> {
  const supabase = createClient();
  const [productsRes, batchesRes] = await Promise.all([
    supabase
      .from("products")
      .select(`${PRODUCT_WITHDRAWAL_COLUMNS}, is_antimicrobial, active_substance, dosage_notes`)
      .eq("is_active", true)
      .in("category", [...TREATMENT_PRODUCT_CATEGORIES])
      .order("name"),
    supabase.from("batches").select("id, product_id, lot, qty_left, expiry_date, received_at").eq("status", "active").gt("qty_left", 0),
  ]);
  if (productsRes.error || batchesRes.error) throw new Error(productsRes.error?.message ?? batchesRes.error?.message);

  const today = todayIso();
  const lotsByProduct = new Map<string, BatchRow[]>();
  for (const b of (batchesRes.data ?? []) as unknown as BatchRow[]) {
    const list = lotsByProduct.get(b.product_id) ?? [];
    list.push(b);
    lotsByProduct.set(b.product_id, list);
  }

  return ((productsRes.data ?? []) as unknown as ProductRow[]).map((p) => {
    const all = lotsByProduct.get(p.id) ?? [];
    const usable = all
      .filter((b) => !b.expiry_date || b.expiry_date >= today)
      .sort((a, b) => (a.expiry_date ?? "9999").localeCompare(b.expiry_date ?? "9999") || a.received_at.localeCompare(b.received_at));
    const expired = all.filter((b) => b.expiry_date && b.expiry_date < today);
    return {
      ...p,
      usable_qty: usable.reduce((s, b) => s + Number(b.qty_left), 0),
      expired_qty: expired.reduce((s, b) => s + Number(b.qty_left), 0),
      lots: usable.map((b) => ({ id: b.id, lot: b.lot, qty_left: Number(b.qty_left), expiry_date: b.expiry_date })),
    };
  });
}

/** Fallback when the stock query fails: props products, stock unknown. */
export function catalogFromProps(
  products: { id: string; name: string; unit: string; withdrawal_days_milk: number | null; withdrawal_days_meat: number | null }[],
): CatalogProduct[] {
  return products.map((p) => ({
    category: null,
    is_antimicrobial: false,
    active_substance: null,
    dosage_notes: null,
    ...p,
    usable_qty: null,
    expired_qty: 0,
    lots: [],
  }));
}
