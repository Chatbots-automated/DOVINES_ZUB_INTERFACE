"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus, Copy, Check, Eye, EyeOff } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ROLE_OPTIONS } from "@/lib/profile";
import { createUserAccount, type CreateUserResult } from "@/lib/actions/users";

// "Naujas vartotojas" — admin-only account creation. Email + password can
// both be set here directly; leaving the password blank falls back to a
// generated temporary one, shown exactly once (Supabase Auth doesn't let us
// retrieve it again afterwards) so the admin can hand it to the new user.
export function NewUserDialog() {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<CreateUserResult | null, FormData>(createUserAccount, null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const [copied, setCopied] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);

  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCopied(false);
          setShowPassword(false);
          formRef.current?.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Naujas vartotojas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Naujas vartotojas</DialogTitle>
        </DialogHeader>

        {state?.ok ? (
          <>
            <DialogBody className="space-y-4">
              <p className="rounded-control bg-success-soft px-3 py-2 text-[13px] text-success">
                {state.generated
                  ? "Vartotojas sukurtas. Nukopijuokite laikiną slaptažodį — jis daugiau nebus rodomas."
                  : "Vartotojas sukurtas su nurodytu slaptažodžiu."}
              </p>
              <div>
                <Label>El. paštas</Label>
                <Input readOnly value={state.email} />
              </div>
              <div>
                <Label>{state.generated ? "Laikinas slaptažodis" : "Slaptažodis"}</Label>
                <div className="flex gap-2">
                  <Input readOnly value={state.tempPassword} className="font-mono" />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(state.tempPassword);
                      setCopied(true);
                    }}
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
                {state.generated && (
                  <p className="mt-1 text-[11px] text-text-muted">Paprašykite vartotojo pasikeisti slaptažodį po pirmo prisijungimo.</p>
                )}
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => setOpen(false)}>
                Uždaryti
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form ref={formRef} action={formAction}>
            <DialogBody className="space-y-4">
              {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}

              <div>
                <Label htmlFor="full_name">Vardas, pavardė</Label>
                <Input id="full_name" name="full_name" autoFocus placeholder="Jonas Jonaitis" />
              </div>
              <div>
                <Label htmlFor="email">El. paštas *</Label>
                <Input id="email" name="email" type="email" required placeholder="vardas@pastas.lt" />
              </div>
              <div>
                <Label htmlFor="password">Slaptažodis</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="Palikite tuščią — bus sugeneruotas automatiškai"
                    minLength={6}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-text-muted">Bent 6 simboliai. Palikus tuščią, bus sugeneruotas laikinas slaptažodis.</p>
              </div>
              <div>
                <Label htmlFor="role">Rolė</Label>
                <Select id="role" name="role" defaultValue="tech">
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Atšaukti
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Kuriama..." : "Sukurti"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
