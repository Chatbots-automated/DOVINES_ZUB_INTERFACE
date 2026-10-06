"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ProductCategory } from "@/lib/supabase/types";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";

// Produktų subkategorijos (0023_product_subcategories.sql). Writes are
// admin/staff-only via RLS. Inline "create" from the product form goes
// through /api/produktai/subcategories (the product form is itself a <form>);
// both share createSubcategoryImpl.

export type SubcategoryActionResult = { ok: true; message?: string } | { ok: false; error: string };
export type CreatedSubcategory = { id: string; category: ProductCategory; name: string; active: boolean };
export type CreateSubcategoryResult = { ok: true; subcategory: CreatedSubcategory } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/apskaita/produktai");
  revalidatePath("/veterinarija/nagos");
}

export async function createSubcategoryImpl(category: string, rawName: string): Promise<CreateSubcategoryResult> {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "Įveskite subkategorijos pavadinimą." };
  if (!(category in PRODUCT_CATEGORY_LABELS)) return { ok: false, error: "Neteisinga kategorija." };

  const supabase = await createClient();
  const { data: last } = await supabase
    .from("product_subcategories")
    .select("sort_order")
    .eq("category", category as ProductCategory)
    .order("sort_order", { ascending: false })
    .limit(1);
  const sort_order = (last?.[0]?.sort_order ?? 0) + 1;

  const { data, error } = await supabase
    .from("product_subcategories")
    .insert({ category: category as ProductCategory, name, sort_order })
    .select("id, category, name, active")
    .single();
  if (error || !data) {
    const dup = error?.code === "23505";
    return { ok: false, error: dup ? "Tokia subkategorija jau yra." : (error?.message ?? "Nepavyko sukurti subkategorijos.") };
  }
  revalidate();
  return { ok: true, subcategory: data };
}

export async function createSubcategory(_prev: SubcategoryActionResult | null, formData: FormData): Promise<SubcategoryActionResult> {
  const res = await createSubcategoryImpl(String(formData.get("category") ?? ""), String(formData.get("name") ?? ""));
  return res.ok ? { ok: true, message: "Subkategorija sukurta." } : res;
}

export async function saveSubcategory(_prev: SubcategoryActionResult | null, formData: FormData): Promise<SubcategoryActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const active = formData.get("active") === "on";
  if (!id) return { ok: false, error: "Subkategorija nerasta." };
  if (!name) return { ok: false, error: "Įveskite pavadinimą." };

  const supabase = await createClient();
  const { error } = await supabase.from("product_subcategories").update({ name, active }).eq("id", id);
  if (error) return { ok: false, error: error.code === "23505" ? "Tokia subkategorija jau yra." : error.message };
  revalidate();
  return { ok: true, message: "Išsaugota." };
}
