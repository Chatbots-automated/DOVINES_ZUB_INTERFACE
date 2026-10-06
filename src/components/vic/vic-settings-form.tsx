"use client";

import * as React from "react";
import { useActionState } from "react";
import { Eye, EyeOff, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { saveVicCredentials, type VicActionResult } from "@/lib/actions/vic";

export function VicSettingsForm({
  username,
  farmCode,
  passwordSet,
  isActive,
}: {
  username: string;
  farmCode: string;
  passwordSet: boolean;
  isActive: boolean;
}) {
  const [state, formAction, pending] = useActionState<VicActionResult | null, FormData>(saveVicCredentials, null);
  const [showPassword, setShowPassword] = React.useState(false);
  const passwordRef = React.useRef<HTMLInputElement>(null);

  // Never keep the typed password around after a successful save.
  React.useEffect(() => {
    if (state?.ok && passwordRef.current) passwordRef.current.value = "";
  }, [state]);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <Label htmlFor="vic_username">VIC prisijungimo vardas *</Label>
        <Input id="vic_username" name="vic_username" required autoComplete="off" defaultValue={username} />
      </div>
      <div>
        <Label htmlFor="vic_password">VIC slaptažodis{passwordSet ? "" : " *"}</Label>
        <div className="relative">
          <Input
            ref={passwordRef}
            id="vic_password"
            name="vic_password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required={!passwordSet}
            placeholder={passwordSet ? "•••••••• (išsaugotas — palikite tuščią, kad nekeistumėte)" : ""}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Slėpti slaptažodį" : "Rodyti slaptažodį"}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>
      <div>
        <Label htmlFor="vic_farm_code">VIC valdos / ūkio kodas</Label>
        <Input id="vic_farm_code" name="vic_farm_code" autoComplete="off" defaultValue={farmCode} />
      </div>
      <label className="flex items-center gap-2 text-[13px] text-text-secondary">
        <input type="checkbox" name="is_active" defaultChecked={isActive} className="size-4 rounded border-border-strong" />
        Aktyvus
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          <Save className="size-4" /> {pending ? "Saugoma..." : "Išsaugoti"}
        </Button>
        {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
        {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
      </div>
    </form>
  );
}
