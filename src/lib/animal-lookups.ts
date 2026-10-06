import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PRODUCT_WITHDRAWAL_COLUMNS } from "@/lib/administration-routes";
import { vilniusDay } from "@/lib/visits";
import type { Product } from "@/components/gyvunai/new-treatment-dialog";
import type { SemenProduct } from "@/components/seklinimas/new-insemination-dialog";
import type { HoofProductOption } from "@/components/nagos/new-hoof-exam-dialog";

/**
 * Everything the animal card needs to open its quick-action dialogs
 * (gydymas, vakcinacija, vizitas, sėklinimas, nagų apžiūra). Loaded once
 * per page by the server and passed down, so the card itself only fetches
 * the animal's history.
 */
export type AnimalLookups = {
  diseases: { id: string; name: string }[];
  products: Product[];
  groups: string[];
  sperm: SemenProduct[];
  gloves: SemenProduct[];
  conditionCodes: { code: string; description: string; severity_default: number }[];
  hoofProducts: HoofProductOption[];
  today: string;
  currentVetName: string | null;
  canWrite: boolean;
};

export async function loadAnimalLookups(): Promise<AnimalLookups> {
  const supabase = await createClient();
  const session = await getCurrentProfile();
  const today = vilniusDay(new Date());

  const [diseasesRes, productsRes, groupsRes, spermRes, glovesRes, codesRes, hoofProductsRes, batchesRes, subsRes] = await Promise.all([
    supabase.from("diseases").select("id, name").order("name"),
    supabase.from("products").select(PRODUCT_WITHDRAWAL_COLUMNS).eq("is_active", true).order("name"),
    supabase.from("delpro_groups").select("name").eq("active", true).order("name"),
    supabase.from("products").select("id, name, unit").eq("is_active", true).eq("category", "reproduction").order("name"),
    supabase.from("products").select("id, name, unit").eq("is_active", true).eq("category", "treatment_materials").order("name"),
    supabase.from("hoof_condition_codes").select("code, description, severity_default").order("sort_order"),
    supabase
      .from("products")
      .select("id, name, unit, category, subcategory_id, standard_amount")
      .eq("is_active", true)
      .not("category", "in", "(vakcina,reproduction)")
      .order("name"),
    // Same stock basis as create_hoof_exam (FEFO): active, non-expired batches.
    supabase.from("batches").select("product_id, qty_left, expiry_date").eq("status", "active").gt("qty_left", 0),
    supabase.from("product_subcategories").select("id, name, sort_order").eq("active", true).order("sort_order"),
  ]);

  const stock = new Map<string, number>();
  for (const b of batchesRes.data ?? []) {
    if (b.expiry_date && b.expiry_date < today) continue;
    stock.set(b.product_id, (stock.get(b.product_id) ?? 0) + Number(b.qty_left));
  }
  const subById = new Map((subsRes.data ?? []).map((s) => [s.id, s]));
  const hoofProducts: HoofProductOption[] = (hoofProductsRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    unit: p.unit,
    category: p.category,
    subcategory: p.subcategory_id ? (subById.get(p.subcategory_id)?.name ?? null) : null,
    subcategory_order: p.subcategory_id ? (subById.get(p.subcategory_id)?.sort_order ?? 0) : 999,
    standard_amount: p.standard_amount,
    stock: Number((stock.get(p.id) ?? 0).toFixed(4)),
  }));

  return {
    diseases: diseasesRes.data ?? [],
    products: (productsRes.data ?? []) as unknown as Product[],
    groups: (groupsRes.data ?? []).map((g) => g.name),
    sperm: spermRes.data ?? [],
    gloves: glovesRes.data ?? [],
    conditionCodes: codesRes.data ?? [],
    hoofProducts,
    today,
    currentVetName: session?.profile.full_name ?? null,
    canWrite: session?.profile.role !== "viewer",
  };
}
