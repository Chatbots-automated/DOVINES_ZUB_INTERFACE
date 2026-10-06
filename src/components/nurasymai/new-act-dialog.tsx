"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { generateWriteOffAct, type WriteOffActionResult } from "@/lib/actions/write-offs";
import { WRITE_OFF_KIND_OPTIONS } from "@/lib/write-off-kinds";

function previousMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Generates a draft act from everything consumed in the period that no
// other act has written off yet, for one of the farm's three templates
// (generate_write_off_act, 0012).
export function NewWriteOffActDialog() {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<WriteOffActionResult | null, FormData>(generateWriteOffAct, null);
  const month = React.useMemo(() => previousMonth(), []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Naujas nurašymo aktas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Naujas nurašymo aktas</DialogTitle>
        </DialogHeader>
        <form action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
            <p className="text-[12px] text-text-muted">
              Į aktą įtraukiami visi mėnesio sunaudoti šio tipo produktai (gydymai, vakcinacijos, biocidai, sunaudojimas be gyvulio),
              dar neįtraukti į kitą aktą. Paskirstymas pagal grupes pasiūlomas automatiškai — jį galėsite pataisyti prieš tvirtinant.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="act_kind">Akto tipas *</Label>
                <Select id="act_kind" name="act_kind" required defaultValue="vaistai">
                  {WRITE_OFF_KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="month">Mėnuo *</Label>
                <Input id="month" name="month" type="month" required defaultValue={month} />
              </div>
              <div>
                <Label htmlFor="act_number">Akto Nr.</Label>
                <Input id="act_number" name="act_number" placeholder="Automatiškai, pvz. 20260705" />
              </div>
            </div>
            <div>
              <Label htmlFor="notes">Pastabos</Label>
              <Textarea id="notes" name="notes" rows={2} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Formuojama..." : "Formuoti aktą"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
