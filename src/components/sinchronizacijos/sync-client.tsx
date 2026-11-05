"use client";

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { SyncMassPanel } from "@/components/sinchronizacijos/sync-mass-panel";
import { SyncStepsPanel } from "@/components/sinchronizacijos/sync-steps-panel";
import { SyncApplicationsPanel } from "@/components/sinchronizacijos/sync-applications-panel";
import { SyncProtocolsPanel } from "@/components/sinchronizacijos/sync-protocols-panel";
import type { SyncAnimal } from "@/lib/sync-mass";
import type { SyncProductOption, SyncProtocolData } from "@/lib/sync-protocols";
import type { Database, SyncApplicationViewRow, SyncOpenStepRow } from "@/lib/supabase/types";

type MassRow = Database["public"]["Views"]["vw_sync_mass_applications"]["Row"];

export function SyncClient({
  animals,
  groups,
  steps,
  applications,
  massApplications,
  protocols,
  protocolProducts,
  allProducts,
  currentVetName,
  canWrite,
  today,
}: {
  animals: SyncAnimal[];
  groups: string[];
  steps: SyncOpenStepRow[];
  applications: SyncApplicationViewRow[];
  massApplications: MassRow[];
  protocols: SyncProtocolData[];
  protocolProducts: SyncProductOption[];
  allProducts: { id: string; name: string; unit: string }[];
  currentVetName?: string | null;
  canWrite: boolean;
  today: string;
}) {
  const [tab, setTab] = React.useState(canWrite ? "nauja" : "zingsniai");
  const due = React.useMemo(() => steps.filter((s) => s.step_date <= today).length, [steps, today]);
  const usage = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of applications) if (a.status === "aktyvus" && a.protocol_id) m[a.protocol_id] = (m[a.protocol_id] ?? 0) + 1;
    return m;
  }, [applications]);
  const running = React.useMemo(() => applications.filter((a) => a.status === "aktyvus").length, [applications]);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="flex-wrap">
        {canWrite && <TabsTrigger value="nauja">Nauja sinchronizacija</TabsTrigger>}
        <TabsTrigger value="zingsniai">
          Žingsniai {due > 0 && <Badge tone="warning" className="ml-1">{due}</Badge>}
        </TabsTrigger>
        <TabsTrigger value="vykdomi">
          Vykdomi ir istorija {running > 0 && <Badge tone="neutral" className="ml-1">{running}</Badge>}
        </TabsTrigger>
        <TabsTrigger value="protokolai">Protokolai</TabsTrigger>
      </TabsList>
      {canWrite && (
        // forceMount keeps the ticked selection when switching tabs.
        <TabsContent value="nauja" forceMount className="mt-4 data-[state=inactive]:hidden">
          <SyncMassPanel animals={animals} groups={groups} currentVetName={currentVetName} today={today} />
        </TabsContent>
      )}
      <TabsContent value="zingsniai" className="mt-4">
        <SyncStepsPanel steps={steps} products={allProducts} currentVetName={currentVetName} today={today} canWrite={canWrite} />
      </TabsContent>
      <TabsContent value="vykdomi" className="mt-4">
        <SyncApplicationsPanel applications={applications} massApplications={massApplications} canWrite={canWrite} />
      </TabsContent>
      <TabsContent value="protokolai" className="mt-4">
        <SyncProtocolsPanel protocols={protocols} products={protocolProducts} usage={usage} canWrite={canWrite} />
      </TabsContent>
    </Tabs>
  );
}
