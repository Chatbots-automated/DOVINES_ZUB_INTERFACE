"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { WriteOffGroupRuleField, WriteOffKind } from "@/lib/supabase/types";

// Nurašymo grupės (0012_write_off_templates.sql) — admin config of the
// template groups, the animal → group rules and the act header defaults.
// Form-bound actions; admin-only writes are enforced by RLS.

export type WriteOffGroupActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PATH = "/apskaita/nurasymo-grupes";
const KINDS: WriteOffKind[] = ["vaistai", "priedai", "medziagos"];
const RULE_FIELDS: WriteOffGroupRuleField[] = ["delpro_group", "animal_sex"];

function done(message?: string): WriteOffGroupActionResult {
  revalidatePath(PATH);
  revalidatePath("/apskaita/nurasymo-aktai", "layout");
  return { ok: true, message };
}

function readKinds(formData: FormData): WriteOffKind[] {
  return formData.getAll("act_kinds").map(String).filter((k): k is WriteOffKind => KINDS.includes(k as WriteOffKind));
}

export async function saveWriteOffGroup(_prev: WriteOffGroupActionResult | null, formData: FormData): Promise<WriteOffGroupActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const act_kinds = readKinds(formData);
  const sort_order = Math.round(Number(formData.get("sort_order") ?? 0) || 0);
  const active = formData.get("active") === "on";
  if (!name) return { ok: false, error: "Įveskite grupės pavadinimą." };
  if (act_kinds.length === 0) return { ok: false, error: "Pasirinkite bent vieną akto tipą." };

  const supabase = await createClient();
  const { error } = id
    ? await supabase.from("write_off_groups").update({ name, act_kinds, sort_order, active }).eq("id", id)
    : await supabase.from("write_off_groups").insert({ name, act_kinds, sort_order, active: true });
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Tokia grupė jau yra." };
    return { ok: false, error: error.message };
  }
  return done(id ? "Išsaugota." : "Grupė sukurta.");
}

export async function addWriteOffGroupRule(_prev: WriteOffGroupActionResult | null, formData: FormData): Promise<WriteOffGroupActionResult> {
  const write_off_group_id = String(formData.get("write_off_group_id") ?? "");
  const match_field = String(formData.get("match_field") ?? "") as WriteOffGroupRuleField;
  const match_value = String(formData.get("match_value") ?? "").trim();
  if (!write_off_group_id || !RULE_FIELDS.includes(match_field)) return { ok: false, error: "Neteisingi duomenys." };
  if (!match_value) return { ok: false, error: "Įveskite reikšmę." };

  const supabase = await createClient();
  const { error } = await supabase.from("write_off_group_rules").insert({ write_off_group_id, match_field, match_value });
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Tokia taisyklė jau yra." };
    return { ok: false, error: error.message };
  }
  return done();
}

export async function deleteWriteOffGroupRule(_prev: WriteOffGroupActionResult | null, formData: FormData): Promise<WriteOffGroupActionResult> {
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.from("write_off_group_rules").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return done();
}

// "Pareigos | Vardas Pavardė" per line -> [{ title, name }].
function parseSignatories(raw: string): { title: string; name: string }[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, ...rest] = line.split("|");
      return { title: title.trim(), name: rest.join("|").trim() };
    });
}

export async function saveWriteOffActDefaults(_prev: WriteOffGroupActionResult | null, formData: FormData): Promise<WriteOffGroupActionResult> {
  const text = (key: string) => String(formData.get(key) ?? "").trim() || null;
  const updates: Array<[string, string | null]> = [
    ["write_off_letterhead_address", text("write_off_letterhead_address")],
    ["write_off_approver_title", text("write_off_approver_title")],
    ["write_off_approver_name", text("write_off_approver_name")],
    ["write_off_medziagos_account", text("write_off_medziagos_account")],
    ["write_off_medziagos_expense_object", text("write_off_medziagos_expense_object")],
    ...KINDS.map(
      (k) =>
        [`write_off_signatories_${k}`, JSON.stringify(parseSignatories(String(formData.get(`signatories_${k}`) ?? "")))] as [
          string,
          string,
        ],
    ),
  ];

  const supabase = await createClient();
  for (const [setting_key, setting_value] of updates) {
    const { error } = await supabase.from("system_settings").upsert({ setting_key, setting_value }, { onConflict: "setting_key" });
    if (error) return { ok: false, error: error.message };
  }
  return done("Nustatymai išsaugoti — bus taikomi naujiems aktams.");
}
