import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { JournalTable } from "@/components/ataskaitos/journal-table";
import { NewMedicalWasteDialog } from "@/components/ataskaitos/new-medical-waste-dialog";

// Priedas §2.8 journals. Titles are the document names from the contract;
// print layouts are adjusted to the farm's templates once supplied (§5.2).
const JOURNAL_ROW_LIMIT = 10000;

const TITLES = {
  drug: "Veterinarinių vaistų ir veterinarinių preparatų apskaitos žurnalas",
  treated: "Gydomų gyvūnų žurnalas",
  treatedSummary: "Gydomų gyvūnų apskaita",
  biocide: "Biocidinių produktų žurnalas",
  biocideReceipts: "Biocidinių produktų žurnalas — gavimas",
  waste: "Veterinarinių medicininių atliekų žurnalas",
  amu: "Antimikrobinių vaistų skyrimo ir sunaudojimo ataskaita",
};

export default async function AtaskaitosPage() {
  const supabase = await createClient();

  const [drugJournal, treatedAnimals, treatedSummary, biocideJournal, biocideReceipts, medicalWaste, antimicrobial] = await Promise.all([
    supabase.from("vw_vet_drug_journal").select("*").order("receipt_date", { ascending: false }).limit(JOURNAL_ROW_LIMIT),
    supabase.from("vw_treated_animals").select("*").order("reg_date", { ascending: false }).limit(JOURNAL_ROW_LIMIT),
    supabase.from("vw_treated_animals_summary").select("*").order("reg_date", { ascending: false }).limit(JOURNAL_ROW_LIMIT),
    supabase.from("vw_biocide_journal").select("*").order("use_date", { ascending: false }).limit(JOURNAL_ROW_LIMIT),
    supabase.from("vw_biocide_receiving_journal").select("*").order("receipt_date", { ascending: false }).limit(JOURNAL_ROW_LIMIT),
    supabase.from("vw_medical_waste").select("*").order("waste_date", { ascending: false }).limit(JOURNAL_ROW_LIMIT),
    supabase.from("vw_antimicrobial_usage").select("*").order("used_on", { ascending: false }).limit(JOURNAL_ROW_LIMIT),
  ]);

  return (
    <div className="flex flex-col">
      <PageHeader title="Žurnalai ir ataskaitos" description="Pasirinkite laikotarpį ir spausdinkite / eksportuokite žurnalą" />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <Tabs defaultValue="drug">
          <TabsList className="flex-wrap">
            <TabsTrigger value="drug">Vaistų apskaita</TabsTrigger>
            <TabsTrigger value="treated">Gydomų gyvūnų žurnalas</TabsTrigger>
            <TabsTrigger value="treated-summary">Gydomų gyvūnų apskaita</TabsTrigger>
            <TabsTrigger value="biocide">Biocidai</TabsTrigger>
            <TabsTrigger value="waste">Medicininės atliekos</TabsTrigger>
            <TabsTrigger value="amu">Antimikrobiniai</TabsTrigger>
          </TabsList>

          <TabsContent value="drug">
            <JournalTable
              title={TITLES.drug}
              rows={(drugJournal.data ?? []) as unknown as Record<string, unknown>[]}
              dateField="receipt_date"
              searchPlaceholder="Ieškoti pagal produktą, tiekėją, partiją, sąskaitą..."
              columns={[
                { key: "receipt_date", label: "Gavimo data", format: "date" },
                { key: "product_name", label: "Pavadinimas" },
                { key: "registration_code", label: "Reg. Nr." },
                { key: "supplier_name", label: "Tiekėjas" },
                { key: "invoice_number", label: "Dokumento Nr." },
                { key: "batch_number", label: "Serija / partija" },
                { key: "expiry_date", label: "Tinka iki", format: "date" },
                { key: "received_qty", label: "Gauta", qtyUnitKey: "unit" },
                { key: "quantity_used", label: "Sunaudota", qtyUnitKey: "unit" },
                { key: "quantity_remaining", label: "Likutis", qtyUnitKey: "unit" },
              ]}
            />
          </TabsContent>

          <TabsContent value="treated">
            <JournalTable
              title={TITLES.treated}
              rows={(treatedAnimals.data ?? []) as unknown as Record<string, unknown>[]}
              dateField="used_on"
              searchPlaceholder="Ieškoti pagal gyvūną, diagnozę, produktą..."
              columns={[
                { key: "used_on", label: "Data", format: "date" },
                { key: "animal_no", label: "Nr." },
                { key: "tag_no", label: "Ausies įsaga" },
                { key: "sex", label: "Kategorija" },
                { key: "animal_group", label: "Grupė" },
                { key: "diagnosis", label: "Diagnozė" },
                { key: "product_name", label: "Vaistas" },
                { key: "batch_number", label: "Serija" },
                { key: "qty", label: "Kiekis", qtyUnitKey: "unit" },
                { key: "administration_route", label: "Būdas" },
                { key: "withdrawal_until_milk", label: "🥛 karencija iki", format: "date" },
                { key: "withdrawal_until_meat", label: "🥩 karencija iki", format: "date" },
                { key: "outcome", label: "Baigtis" },
                { key: "vet_name", label: "Gydytojas" },
              ]}
            />
          </TabsContent>

          <TabsContent value="treated-summary">
            <JournalTable
              title={TITLES.treatedSummary}
              rows={(treatedSummary.data ?? []) as unknown as Record<string, unknown>[]}
              dateField="reg_date"
              searchPlaceholder="Ieškoti pagal gyvūną, ligą..."
              columns={[
                { key: "reg_date", label: "Registravimo data", format: "date" },
                { key: "animal_no", label: "Nr." },
                { key: "tag_no", label: "Ausies įsaga" },
                { key: "sex", label: "Kategorija" },
                { key: "disease_name", label: "Liga" },
                { key: "diagnosis", label: "Diagnozė" },
                { key: "products_used", label: "Vaistai" },
                { key: "course_days", label: "Kurso d." },
                { key: "withdrawal_until_milk", label: "🥛 iki", format: "date" },
                { key: "withdrawal_until_meat", label: "🥩 iki", format: "date" },
                { key: "outcome", label: "Baigtis" },
                { key: "outcome_date", label: "Baigties data", format: "date" },
                { key: "vet_name", label: "Gydytojas" },
              ]}
            />
          </TabsContent>

          <TabsContent value="biocide">
            <JournalTable
              title={TITLES.biocide}
              rows={(biocideJournal.data ?? []) as unknown as Record<string, unknown>[]}
              dateField="use_date"
              searchPlaceholder="Ieškoti pagal produktą, tikslą..."
              columns={[
                { key: "use_date", label: "Data", format: "date" },
                { key: "name", label: "Produktas" },
                { key: "registration_code", label: "Reg. Nr." },
                { key: "active_substance", label: "Veiklioji medžiaga" },
                { key: "batch_number", label: "Serija" },
                { key: "purpose", label: "Paskirtis" },
                { key: "work_scope", label: "Apdorota vieta / apimtis" },
                { key: "qty", label: "Kiekis", qtyUnitKey: "unit" },
                { key: "used_by_name", label: "Atliko" },
              ]}
            />
            <div className="mt-6">
              <JournalTable
                title={TITLES.biocideReceipts}
                rows={(biocideReceipts.data ?? []) as unknown as Record<string, unknown>[]}
                dateField="receipt_date"
                searchPlaceholder="Ieškoti pagal produktą, tiekėją, sąskaitą..."
                columns={[
                  { key: "receipt_date", label: "Gauta", format: "date" },
                  { key: "name", label: "Produktas" },
                  { key: "registration_code", label: "Reg. Nr." },
                  { key: "supplier_name", label: "Tiekėjas" },
                  { key: "invoice_number", label: "Sąskaita" },
                  { key: "batch_number", label: "Serija" },
                  { key: "expiry_date", label: "Galioja iki", format: "date" },
                  { key: "received_qty", label: "Gauta kiekis", qtyUnitKey: "unit" },
                  { key: "quantity_remaining", label: "Likutis", qtyUnitKey: "unit" },
                ]}
              />
            </div>
          </TabsContent>

          <TabsContent value="waste">
            <div className="mb-3 flex justify-end">
              <NewMedicalWasteDialog />
            </div>
            <JournalTable
              title={TITLES.waste}
              rows={(medicalWaste.data ?? []) as unknown as Record<string, unknown>[]}
              dateField="waste_date"
              searchPlaceholder="Ieškoti pagal atliekos pavadinimą, vežėją..."
              columns={[
                { key: "waste_date", label: "Data", format: "date" },
                { key: "waste_code", label: "Kodas" },
                { key: "name", label: "Atliekos" },
                { key: "qty_generated", label: "Susidarė (g)" },
                { key: "qty_transferred", label: "Perduota" },
                { key: "transfer_date", label: "Perdavimo data", format: "date" },
                { key: "carrier", label: "Vežėjas" },
                { key: "processor", label: "Tvarkytojas" },
                { key: "doc_no", label: "Dokumento Nr." },
                { key: "responsible", label: "Atsakingas" },
              ]}
            />
          </TabsContent>

          <TabsContent value="amu">
            <JournalTable
              title={TITLES.amu}
              rows={(antimicrobial.data ?? []) as unknown as Record<string, unknown>[]}
              dateField="used_on"
              searchPlaceholder="Ieškoti pagal gyvūną, produktą, veikliąją medžiagą..."
              columns={[
                { key: "used_on", label: "Data", format: "date" },
                { key: "animal_no", label: "Nr." },
                { key: "tag_no", label: "Ausies įsaga" },
                { key: "animal_group", label: "Grupė" },
                { key: "name", label: "Vaistas" },
                { key: "active_substance", label: "Veiklioji medžiaga" },
                { key: "qty", label: "Kiekis", qtyUnitKey: "unit" },
                { key: "administration_route", label: "Būdas" },
                { key: "diagnosis", label: "Diagnozė" },
                { key: "vet_name", label: "Paskyrė" },
              ]}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
