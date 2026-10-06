"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { Database, ProductCategory, Unit, WriteOffKind } from "@/lib/supabase/types";
import { EMPTY_WITHDRAWAL_ROUTE_FIELDS, type WithdrawalFieldKey } from "@/lib/administration-routes";

function readRouteWithdrawalFields(formData: FormData): Record<WithdrawalFieldKey, number | null> {
  const result = {} as Record<WithdrawalFieldKey, number | null>;
  for (const key of Object.keys(EMPTY_WITHDRAWAL_ROUTE_FIELDS) as WithdrawalFieldKey[]) {
    const raw = formData.get(key);
    result[key] = raw ? Number(raw) : null;
  }
  return result;
}

export type ProductRow = Database["public"]["Tables"]["products"]["Row"];
export type ProductActionResult = { ok: true; product: ProductRow } | { ok: false; error: string };

type ProductFields = Database["public"]["Tables"]["products"]["Update"];

// Shared by create + update: every field the product form posts.
function readProductFields(formData: FormData): { name: string; fields: ProductFields } {
  const text = (key: string) => String(formData.get(key) ?? "").trim() || null;
  const num = (key: string) => (formData.get(key) ? Number(formData.get(key)) : null);
  const name = String(formData.get("name") ?? "").trim();

  return {
    name,
    fields: {
      name,
      category: (text("category") || "medicines") as ProductCategory,
      unit: (text("unit") || "vnt") as Unit,
      is_antimicrobial: formData.get("is_antimicrobial") === "on",
      active_substance: text("active_substance"),
      registration_code: text("registration_code"),
      dosage_notes: text("dosage_notes"),
      withdrawal_days_milk: Number(formData.get("withdrawal_days_milk") ?? 0) || 0,
      withdrawal_days_meat: Number(formData.get("withdrawal_days_meat") ?? 0) || 0,
      pack_size: num("pack_size"),
      package_weight_g: num("package_weight_g"),
      min_stock_alert: num("min_stock_alert"),
      // Nurašymo aktai (0012): empty write_off_kind = derived from category.
      write_off_kind: text("write_off_kind") as WriteOffKind | null,
      nomenclature_no: text("nomenclature_no"),
      default_write_off_group_id: text("default_write_off_group_id"),
      subcategory_id: text("subcategory_id"),
      standard_amount: num("standard_amount"),
      ...readRouteWithdrawalFields(formData),
    },
  };
}

function revalidateProductViews() {
  revalidatePath("/apskaita/produktai");
  revalidatePath("/apskaita/pajamavimas");
  revalidatePath("/apskaita/sunaudojimas");
  revalidatePath("/veterinarija/nagos");
}

export async function createProduct(_prev: ProductActionResult | null, formData: FormData): Promise<ProductActionResult> {
  const { name, fields } = readProductFields(formData);
  if (!name) return { ok: false, error: "Įveskite produkto pavadinimą." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .insert({ ...fields, name })
    .select("*")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Nepavyko sukurti produkto." };
  }

  revalidateProductViews();
  return { ok: true, product: data };
}

export async function updateProduct(_prev: ProductActionResult | null, formData: FormData): Promise<ProductActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "Produktas nerastas." };
  const { name, fields } = readProductFields(formData);
  if (!name) return { ok: false, error: "Įveskite produkto pavadinimą." };

  const supabase = await createClient();
  const { data, error } = await supabase.from("products").update(fields).eq("id", id).select("*").single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Nepavyko išsaugoti produkto." };
  }

  revalidateProductViews();
  return { ok: true, product: data };
}
