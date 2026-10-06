"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { BrandMark } from "@/components/layout/brand-mark";

export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginForm />
    </React.Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const deactivated = params.get("deactivated") === "1";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        setError("Neteisingas el. paštas arba slaptažodis.");
        setLoading(false);
        return;
      }

      router.replace("/");
      router.refresh();
    } catch {
      setError("Nepavyko prisijungti. Patikrinkite interneto ryšį ir bandykite dar kartą.");
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink px-4">
      <div aria-hidden className="bg-ripples pointer-events-none absolute inset-0 opacity-[0.05]" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-[560px] -translate-x-1/2 rounded-full bg-accent/25 blur-[120px]"
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandMark dark size="lg" />
        </div>
        <div className="rounded-modal border border-ink-line bg-surface p-7 shadow-elevated">
          <h1 className="mb-1 text-[24px] font-bold tracking-tight text-text-primary">Prisijungimas</h1>
          <p className="mb-6 text-[13px] text-text-secondary">
            Veterinarijos valdymo sistema. Prisijunkite savo paskyra.
          </p>

          {deactivated && (
            <p className="mb-4 rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">
              Jūsų paskyra yra užšaldyta. Susisiekite su administratoriumi.
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="email">El. paštas</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="password">Slaptažodis</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && <p className="text-[13px] text-danger">{error}</p>}

            <Button type="submit" className="w-full" size="lg" disabled={loading}>
              {loading ? "Jungiamasi..." : "Prisijungti"}
            </Button>
          </form>
        </div>
        <p className="mt-6 text-center text-[12px] text-text-on-ink/40">
          Prieigą suteikia sistemos administratorius
        </p>
      </div>
    </div>
  );
}
