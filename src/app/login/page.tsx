"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { BrandMark } from "@/components/layout/brand-mark";
import { signIn, type LoginState } from "./actions";

export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginForm />
    </React.Suspense>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" size="lg" disabled={pending}>
      {pending ? "Jungiamasi..." : "Prisijungti"}
    </Button>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const [state, formAction] = React.useActionState<LoginState, FormData>(signIn, {
    error: null,
    email: "",
  });

  // Mirror the server's failure reason into the browser console.
  React.useEffect(() => {
    if (state.error) console.error("[login]", state.error);
  }, [state]);

  const deactivated = params.get("deactivated") === "1";

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

          <form action={formAction} className="space-y-4">
            <div>
              <Label htmlFor="email">El. paštas</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                defaultValue={state.email}
              />
            </div>
            <div>
              <Label htmlFor="password">Slaptažodis</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>

            {state.error && <p className="text-[13px] text-danger">{state.error}</p>}

            <SubmitButton />
          </form>
        </div>
        <p className="mt-6 text-center text-[12px] text-text-on-ink/40">
          Prieigą suteikia sistemos administratorius
        </p>
      </div>
    </div>
  );
}
