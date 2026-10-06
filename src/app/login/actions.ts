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

  // HTTP headers only take Latin-1: a key pasted from a masked field ("••••")
  // makes fetch throw an opaque ByteString error. Name the broken variable.
  const badEnv = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"].filter((name) =>
    /[^\x21-\x7e]/.test(process.env[name] ?? ""),
  );
  if (badEnv.length > 0) {
    console.error("[login] env var has invalid characters:", badEnv.join(", "));
    return {
      error: `Netlify kintamasis ${badEnv.join(", ")} turi netinkamų simbolių (pvz. „•“ ar tarpų). Įveskite reikšmę iš naujo ir perkraukite svetainę.`,
      email,
    };
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.error("[login] signInWithPassword failed:", error.status, error.code, error.message);
      // 400 = wrong credentials / unknown user; anything else (bad API key,
      // unreachable project, ...) is a config problem worth showing as-is.
      const credentials = error.status === 400 || error.code === "invalid_credentials";
      return {
        error: credentials
          ? "Neteisingas el. paštas arba slaptažodis."
          : `Prisijungti nepavyko: ${error.message}`,
        email,
      };
    }

    // The middleware signs out any session without a usable public.users
    // row, which looks like a silent bounce back to /login. Say why instead.
    const { data: profile, error: profileError } = await supabase
      .from("users")
      .select("id, is_frozen")
      .eq("id", data.user.id)
      .maybeSingle();
    if (profileError || !profile || profile.is_frozen) {
      console.error("[login] no usable profile:", profileError?.message ?? (profile ? "frozen" : "missing"));
      await supabase.auth.signOut();
      return {
        error: profileError
          ? `Nepavyko nuskaityti profilio: ${profileError.message}`
          : profile
            ? "Jūsų paskyra yra užšaldyta. Susisiekite su administratoriumi."
            : "Paskyra egzistuoja, bet neturi profilio lentelėje „users“. Susisiekite su administratoriumi.",
        email,
      };
    }
  } catch (err) {
    console.error("[login] unexpected error:", err);
    return {
      error: "Nepavyko prisijungti. Patikrinkite interneto ryšį ir bandykite dar kartą.",
      email,
    };
  }

  redirect("/");
}
