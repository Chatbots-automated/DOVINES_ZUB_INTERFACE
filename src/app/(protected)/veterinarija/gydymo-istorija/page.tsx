import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { JournalTable } from "@/components/ataskaitos/journal-table";

// "Gydymų istorija" — dedicated searchable/filterable treatment log
// (Priedas §2.10 "paieška, filtrai ir istorija": pagal gyvūną, produktą,
// laikotarpį, diagnozę). Same underlying view as the Ataskaitos "Gydomų
// gyvūnų žurnalas" tab, surfaced here as its own full-page search tool
// rather than one tab among six.
export default async function GydymoIstorijaPage() {
  const supabase = await createClient();
  const { data } = await supabase.from("vw_treated_animals").select("*").order("reg_date", { ascending: false }).limit(5000);

  return (
    <>
      <PageHeader title="Gydymų istorija" />
      <div className="p-4 sm:p-6 lg:p-8">
        <JournalTable
          rows={(data ?? []) as unknown as Record<string, unknown>[]}
          dateField="reg_date"
          title="Gydymų istorija"
          columnFilters={[
            { key: "animal_no", label: "Gyvūno Nr.", kind: "combo" },
            { key: "product_name", label: "Produktas" },
            { key: "disease_name", label: "Liga" },
            { key: "diagnosis", label: "Diagnozė", kind: "combo" },
            { key: "animal_group", label: "Grupė" },
          ]}
          searchPlaceholder="Ieškoti pagal gyvūno Nr., įsagą, diagnozę, produktą, gydytoją..."
          columns={[
            { key: "reg_date", label: "Data", format: "date" },
            { key: "animal_no", label: "Nr." },
            { key: "tag_no", label: "Ausies įsaga" },
            { key: "animal_group", label: "Grupė" },
            { key: "disease_name", label: "Liga" },
            { key: "diagnosis", label: "Diagnozė" },
            { key: "product_name", label: "Produktas" },
            { key: "qty", label: "Kiekis", qtyUnitKey: "unit" },
            { key: "withdrawal_until_milk", label: "🥛 karencija", format: "date" },
            { key: "withdrawal_until_meat", label: "🥩 karencija", format: "date" },
            { key: "outcome", label: "Baigtis" },
            { key: "vet_name", label: "Gydytojas" },
          ]}
        />
      </div>
    </>
  );
}
