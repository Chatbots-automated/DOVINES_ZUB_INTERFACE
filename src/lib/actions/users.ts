"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UserRole } from "@/lib/supabase/types";

export type CreateUserResult =
  | { ok: true; email: string; tempPassword: string; generated: boolean }
  | { ok: false; error: string };

function generateTempPassword(): string {
  // Random 12-char password, guaranteed to satisfy Supabase Auth's default
  // password requirements (letters + digits).
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pw = "";
  for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

// "Naujas vartotojas" — admin-only. Creates the auth.users row via the
// service-role admin client (bypassing RLS is required — a normal user
// session can never create other auth users), then mirrors it into
// public.users (role + freeze flag).
export async function createUserAccount(_prev: CreateUserResult | null, formData: FormData): Promise<CreateUserResult> {
  const supabase = await createClient();
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();
  if (!currentUser) return { ok: false, error: "Neprisijungęs vartotojas." };

  const { data: currentProfile } = await supabase.from("users").select("role").eq("id", currentUser.id).single();
  if (currentProfile?.role !== "admin") {
    return { ok: false, error: "Tik administratorius gali kurti naujus vartotojus." };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { ok: false, error: "Įveskite el. paštą." };
  const full_name = String(formData.get("full_name") ?? "").trim() || null;
  const role = (String(formData.get("role") ?? "").trim() || "tech") as UserRole;

  const providedPassword = String(formData.get("password") ?? "").trim();
  if (providedPassword && providedPassword.length < 6) {
    return { ok: false, error: "Slaptažodis turi būti bent 6 simbolių." };
  }
  const generated = !providedPassword;
  const tempPassword = providedPassword || generateTempPassword();

  const admin = createAdminClient();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: full_name ? { full_name } : undefined,
  });

  if (createError || !created?.user) {
    console.error("[vartotojai] auth user creation failed:", createError);
    const message = createError?.message?.includes("already registered")
      ? "Vartotojas su šiuo el. paštu jau egzistuoja."
      : "Nepavyko sukurti vartotojo paskyros.";
    return { ok: false, error: message };
  }

  const { error: profileError } = await admin.from("users").insert({
    id: created.user.id,
    email,
    full_name,
    role,
  });

  if (profileError) {
    console.error("[vartotojai] profile insert failed:", profileError);
    await admin.auth.admin.deleteUser(created.user.id);
    return { ok: false, error: "Nepavyko išsaugoti vartotojo profilio." };
  }

  revalidatePath("/apskaita/vartotojai");
  return { ok: true, email, tempPassword, generated };
}
