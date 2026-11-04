"use client";

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { MassTreatmentPanel } from "@/components/masinis-gydymas/mass-treatment-panel";
import { MassTreatmentHistory } from "@/components/masinis-gydymas/mass-treatment-history";
import type { Product } from "@/components/gyvunai/new-treatment-dialog";
import type { MassAnimal, MassDelproInfo, MassHistoryRow } from "@/lib/mass-treatments";

export function MassTreatmentClient({
  animals,
  groups,
  diseases,
  products,
  history,
  delpro,
  currentVetName,
  canWrite,
  today,
}: {
  animals: MassAnimal[];
  groups: string[];
  diseases: { id: string; name: string }[];
  products: Product[];
  history: MassHistoryRow[];
  delpro: MassDelproInfo;
  currentVetName?: string | null;
  canWrite: boolean;
  today: string;
}) {
  const [tab, setTab] = React.useState(canWrite ? "naujas" : "istorija");
  const waiting = React.useMemo(() => history.reduce((n, h) => n + (h.delpro_status_counts.pending_approval ?? 0), 0), [history]);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        {canWrite && <TabsTrigger value="naujas">Naujas masinis gydymas</TabsTrigger>}
        <TabsTrigger value="istorija">
          Istorija {delpro.enabled && waiting > 0 && <Badge tone="warning" className="ml-1">{waiting}</Badge>}
        </TabsTrigger>
      </TabsList>
      {canWrite && (
        // forceMount keeps the ticked selection when switching tabs.
        <TabsContent value="naujas" forceMount className="data-[state=inactive]:hidden">
          <MassTreatmentPanel
            animals={animals}
            groups={groups}
            diseases={diseases}
            products={products}
            delpro={delpro}
            currentVetName={currentVetName}
            today={today}
          />
        </TabsContent>
      )}
      <TabsContent value="istorija">
        <MassTreatmentHistory history={history} products={products} delpro={delpro} />
      </TabsContent>
    </Tabs>
  );
}
