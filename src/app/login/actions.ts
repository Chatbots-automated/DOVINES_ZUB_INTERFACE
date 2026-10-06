"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error: string | null; email: string };

// Sign-in runs on the server so the form still submits even if the client
// bundle fails to hydrate; session cookies are set via the server client.
export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Įveskite el. paštą ir slaptažodį.", email };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return { error: "Neteisingas el. paštas arba slaptažodis.", email };
    }
  } catch {
    return {
      error: "Nepavyko prisijungti. Patikrinkite interneto ryšį ir bandykite dar kartą.",
      email,
    };
  }

  redirect("/");
}
