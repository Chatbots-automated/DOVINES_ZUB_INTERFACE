"use client";

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Pajamavimas: "Priėmimas" (receive stock / PDF upload) and "Redagavimas" (0058).
// forceMount keeps a half-filled receive form when switching tabs.
export function PajamavimasTabs({
  initialTab,
  priemimas,
  redagavimas,
}: {
  initialTab: "priemimas" | "redagavimas";
  priemimas: React.ReactNode;
  redagavimas: React.ReactNode;
}) {
  const [tab, setTab] = React.useState<string>(initialTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(t) => {
        setTab(t);
        const url = new URL(window.location.href);
        if (t === "priemimas") url.searchParams.delete("tab");
        else url.searchParams.set("tab", t);
        window.history.replaceState(null, "", url);
      }}
    >
      <TabsList>
        <TabsTrigger value="priemimas">Priėmimas</TabsTrigger>
        <TabsTrigger value="redagavimas">Redagavimas</TabsTrigger>
      </TabsList>
      <TabsContent value="priemimas" forceMount className="mt-4 space-y-6 data-[state=inactive]:hidden">
        {priemimas}
      </TabsContent>
      <TabsContent value="redagavimas" className="mt-4">
        {redagavimas}
      </TabsContent>
    </Tabs>
  );
}
