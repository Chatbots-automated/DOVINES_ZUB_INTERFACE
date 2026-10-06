"use client";

import * as React from "react";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { AnimalProfile } from "@/components/gyvunai/animal-profile";
import type { AnimalLookups } from "@/lib/animal-lookups";
import type { AnimalRow, WithdrawalRow } from "@/lib/animal-profile";

// Sidepanel opened from AnimalsTable (Priedas §2.7/§2.10): the same animal
// card as /veterinarija/gyvunai/[id] — hero, karencija countdowns, DelPro
// card, histories and quick actions — without leaving the list.
export function AnimalDetailDrawer({
  animal,
  withdrawal,
  open,
  onOpenChange,
  lookups,
}: {
  animal: AnimalRow | null;
  withdrawal?: WithdrawalRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lookups: AnimalLookups;
}) {
  if (!animal) return null;
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width="xl" aria-describedby={undefined}>
        <AnimalProfile animal={animal} withdrawal={withdrawal} lookups={lookups} variant="drawer" active={open} />
      </DrawerContent>
    </Drawer>
  );
}
