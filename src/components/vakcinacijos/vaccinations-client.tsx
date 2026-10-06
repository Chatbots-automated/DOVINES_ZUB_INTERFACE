"use client";

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { BulkVaccinationPanel } from "@/components/vakcinacijos/bulk-vaccination-panel";
import { BoosterPlan } from "@/components/vakcinacijos/booster-plan";
import { VaccinationHistory } from "@/components/vakcinacijos/vaccination-history";
import { pendingBoosters, type BoosterPrefill, PickerAnimal, VaccProduct, VaccRow } from "@/lib/vaccinations";

export function VaccinationsClient({
  animals,
  groups,
  products,
  vaccinations,
  currentVetName,
  today,
}: {
  animals: PickerAnimal[];
  groups: string[];
  products: VaccProduct[];
  vaccinations: VaccRow[];
  currentVetName?: string | null;
  today: string;
}) {
  const [tab, setTab] = React.useState("nauja");
  const [prefill, setPrefill] = React.useState<BoosterPrefill | null>(null);

  const overdueCount = React.useMemo(
    () => pendingBoosters(vaccinations, new Set(animals.map((a) => a.id))).filter((e) => e.due < today).reduce((n, e) => n + e.animalIds.length, 0),
    [vaccinations, animals, today],
  );
  const productNames = React.useMemo(() => Object.fromEntries(products.map((p) => [p.id, p.name])), [products]);
  const allGroups = React.useMemo(
    () => [...new Set([...groups, ...vaccinations.map((v) => v.target_group_name ?? v.animal_group_snapshot).filter((g): g is string => !!g)])].sort(),
    [groups, vaccinations],
  );

  const vaccinate = React.useCallback((animalIds: string[], productId: string) => {
    setPrefill({ key: Date.now(), animalIds, productId });
    setTab("nauja");
  }, []);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="nauja">Nauja vakcinacija</TabsTrigger>
        <TabsTrigger value="planas">
          Planas {overdueCount > 0 && <Badge tone="danger" className="ml-1">{overdueCount}</Badge>}
        </TabsTrigger>
        <TabsTrigger value="istorija">Istorija</TabsTrigger>
      </TabsList>
      {/* forceMount keeps the ticked selection when switching tabs. */}
      <TabsContent value="nauja" forceMount className="data-[state=inactive]:hidden">
        <BulkVaccinationPanel
          key={prefill?.key ?? 0}
          animals={animals}
          groups={groups}
          products={products}
          vaccinations={vaccinations}
          currentVetName={currentVetName}
          today={today}
          prefill={prefill}
        />
      </TabsContent>
      <TabsContent value="planas">
        <BoosterPlan vaccinations={vaccinations} animals={animals} productNames={productNames} today={today} onVaccinate={vaccinate} />
      </TabsContent>
      <TabsContent value="istorija">
        <VaccinationHistory vaccinations={vaccinations} productNames={productNames} groups={allGroups} />
      </TabsContent>
    </Tabs>
  );
}
