"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { WriteOffSignatory } from "@/lib/supabase/types";

// Nurašymo aktai (Priedas §2.9). All form-bound server actions; the rules
// (balanced split, nothing left "Nepriskirta", approved acts locked, one act
// per usage row) are enforced in the database (0007 + 0012).

export type WriteOffActionResult = { ok: true; message?: string } | { ok: false; error: string };

const LIST_PATH = "/apskaita/nurasymo-aktai";

/** "2026-07" -> first/last day of that month. */
function monthRange(month: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(y, mo, 0).getDate();
  return { start: `${m[1]}-${m[2]}-01`, end: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}` };
}

/** "Pareigos | Vardas Pavardė" per line -> [{title, name}]. */
function parseSignatories(text: string): WriteOffSignatory[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, ...rest] = line.split("|");
      return { title: title.trim(), name: rest.join("|").trim() };
    });
}

export async function generateWriteOffAct(_prev: WriteOffActionResult | null, formData: FormData): Promise<WriteOffActionResult> {
  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const range = monthRange(field("month") ?? "");
  const period_start = field("period_start") ?? range?.start ?? null;
  const period_end = field("period_end") ?? range?.end ?? null;
  if (!period_start || !period_end) return { ok: false, error: "Nurodykite mėnesį." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("generate_write_off_act", {
    p_data: {
      act_kind: field("act_kind") ?? "vaistai",
      period_start,
      period_end,
      act_date: field("act_date") ?? period_end,
      act_number: field("act_number"),
      notes: field("notes"),
    },
  });
  if (error || !data) return { ok: false, error: error?.message ?? "Nepavyko sukurti akto." };

  revalidatePath(LIST_PATH);
  redirect(`${LIST_PATH}/${data}`);
}

export async function saveAllocations(_prev: WriteOffActionResult | null, formData: FormData): Promise<WriteOffActionResult> {
  const itemId = String(formData.get("item_id") ?? "");
  const actId = String(formData.get("act_id") ?? "");
  let rows: Record<string, unknown>[] = [];
  try {
    rows = JSON.parse(String(formData.get("rows") ?? "[]"));
  } catch {
    return { ok: false, error: "Neteisingi duomenys." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_write_off_allocations", { p_item_id: itemId, p_rows: rows });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`${LIST_PATH}/${actId}`);
  return { ok: true, message: "Išsaugota." };
}

export async function updateActHeader(_prev: WriteOffActionResult | null, formData: FormData): Promise<WriteOffActionResult> {
  const actId = String(formData.get("act_id") ?? "");
  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const act_date = field("act_date");
  const act_number = field("act_number");
  if (!act_date) return { ok: false, error: "Nurodykite akto datą." };
  if (!act_number) return { ok: false, error: "Nurodykite akto numerį." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("write_off_acts")
    .update({
      act_number,
      act_date,
      account_no: field("account_no"),
      expense_object: field("expense_object"),
      approver_title: field("approver_title"),
      approver_name: field("approver_name"),
      signatories: parseSignatories(String(formData.get("signatories") ?? "")),
      notes: field("notes"),
    })
    .eq("id", actId)
    .eq("status", "draft");
  if (error) {
    if (error.code === "23505") return { ok: false, error: `Aktas Nr. ${act_number} jau yra.` };
    return { ok: false, error: error.message };
  }
  revalidatePath(`${LIST_PATH}/${actId}`);
  revalidatePath(LIST_PATH);
  return { ok: true, message: "Išsaugota." };
}

export async function approveAct(_prev: WriteOffActionResult | null, formData: FormData): Promise<WriteOffActionResult> {
  const actId = String(formData.get("act_id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_write_off_act", { p_act_id: actId });
  if (error) return { ok: false, error: error.message };
  revalidatePath(LIST_PATH, "layout");
  return { ok: true, message: "Aktas patvirtintas." };
}

export async function cancelAct(_prev: WriteOffActionResult | null, formData: FormData): Promise<WriteOffActionResult> {
  const actId = String(formData.get("act_id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_write_off_act", { p_act_id: actId });
  if (error) return { ok: false, error: error.message };
  revalidatePath(LIST_PATH, "layout");
  return { ok: true, message: "Aktas anuliuotas." };
}

export async function deleteDraftAct(_prev: WriteOffActionResult | null, formData: FormData): Promise<WriteOffActionResult> {
  const actId = String(formData.get("act_id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.from("write_off_acts").delete().eq("id", actId).eq("status", "draft");
  if (error) return { ok: false, error: error.message };
  revalidatePath(LIST_PATH);
  redirect(LIST_PATH);
}
