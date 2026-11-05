"use client";

import * as React from "react";
import { ChevronDown, LifeBuoy, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Drawer, DrawerBody, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { DELPRO_HELP, HELP_GROUP_LABEL, type HelpEntry, type HelpGroup } from "@/lib/delpro-help";
import { cn } from "@/lib/utils";

const GROUPS = Object.keys(HELP_GROUP_LABEL) as HelpGroup[];

function Entry({ entry, open, onToggle }: { entry: HelpEntry; open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-control border border-border bg-surface">
      <button type="button" onClick={onToggle} className="flex w-full items-start justify-between gap-3 px-3.5 py-2.5 text-left">
        <span className="text-[13.5px] font-semibold text-text-primary">{entry.title}</span>
        <ChevronDown className={cn("mt-0.5 size-4 shrink-0 text-text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-border px-3.5 py-3 text-[13px] leading-relaxed">
          <p className="text-text-secondary">
            <span className="font-semibold text-text-primary">Kodėl taip būna. </span>
            {entry.why}
          </p>
          <div>
            <p className="mb-1 font-semibold text-text-primary">Ką daryti</p>
            <ol className="list-decimal space-y-1 pl-5 text-text-secondary">
              {entry.steps.map((s, i) => (
                <li key={i} className="break-words">
                  {s}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

// "Jei kas nors neveikia" — every error the DelPro screen can show, why it happens and
// what to do, searchable. Content: src/lib/delpro-help.ts.
export function DelproHelpDrawer() {
  const [q, setQ] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = DELPRO_HELP.filter((h) => {
    if (tokens.length === 0) return true;
    const hay = `${h.title} ${h.why} ${h.steps.join(" ")} ${(h.match ?? []).join(" ")}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });

  return (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline" size="sm">
          <LifeBuoy className="size-4" /> Jei kas nors neveikia
        </Button>
      </DrawerTrigger>
      <DrawerContent width="xl">
        <DrawerHeader>
          <DrawerTitle>Jei kas nors neveikia</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-5">
          <div className="space-y-2 text-[13px] leading-relaxed text-text-secondary">
            <p>
              Čia surašytos visos klaidos, kurias gali rodyti šis puslapis. Įrašykite kelis žodžius iš klaidos teksto (pvz. „ObjectGuid“, „karencija“,
              „nesusietas“) arba atsidarykite skyrių.
            </p>
            <p>
              Svarbu: kol klaida neišspręsta, niekas neprarandama. Gydymai GVET lieka išsaugoti, atsargos nurašytos, o siuntimas į DelPro tiesiog
              laukia. Pataisę priežastį, prie įrašo spauskite „Kartoti“.
            </p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-text-muted" />
            <Input className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ieškoti klaidos..." autoFocus />
          </div>
          {visible.length === 0 && <p className="text-[13px] text-text-muted">Nieko nerasta. Pabandykite kitą žodį iš klaidos teksto.</p>}
          {GROUPS.map((g) => {
            const entries = visible.filter((h) => h.group === g);
            if (entries.length === 0) return null;
            return (
              <section key={g} className="space-y-2">
                <h3 className="text-[12px] font-bold uppercase tracking-wide text-text-muted">{HELP_GROUP_LABEL[g]}</h3>
                {entries.map((h) => (
                  <Entry key={h.id} entry={h} open={openId === h.id || tokens.length > 0} onToggle={() => setOpenId(openId === h.id ? null : h.id)} />
                ))}
              </section>
            );
          })}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
