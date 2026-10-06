"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Integracija → VIC (0013_vic_credentials.sql). Admin check + storage live in
// the vic_save_credentials RPC; the password is never read back.

export type VicActionResult = { ok: true; message?: string } | { ok: false; error: string };

export async function saveVicCredentials(_prev: VicActionResult | null, formData: FormData): Promise<VicActionResult> {
  const username = String(formData.get("vic_username") ?? "").trim();
  const password = String(formData.get("vic_password") ?? "");
  const isActive = formData.get("is_active") === "on";
  if (!username) return { ok: false, error: "Įveskite VIC prisijungimo vardą." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("vic_save_credentials", {
    p_username: username,
    p_password: password || null,
    p_is_active: isActive,
    p_farm_code: String(formData.get("vic_farm_code") ?? "").trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/veterinarija/vic");
  return { ok: true, message: "VIC prisijungimo duomenys išsaugoti." };
}
