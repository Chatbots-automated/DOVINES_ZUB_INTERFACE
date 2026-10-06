import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { NewAnimalDialog } from "@/components/gyvunai/new-animal-dialog";
import { NewTreatmentDialog } from "@/components/gyvunai/new-treatment-dialog";
import { NewVaccinationDialog } from "@/components/vakcinacijos/new-vaccination-dialog";
import { AnimalsTable } from "@/components/gyvunai/animals-table";
import { loadAnimalLookups } from "@/lib/animal-lookups";

export default async function GyvunaiPage() {
  const supabase = await createClient();
  const session = await getCurrentProfile();

  const [{ data: animals }, { data: withdrawal }, lookups] = await Promise.all([
    supabase.from("animals").select("*").order("animal_no"),
    supabase.from("vw_withdrawal_status").select("*"),
    loadAnimalLookups(),
  ]);
  const { diseases, products, groups } = lookups;

  const activeAnimals = (animals ?? []).filter((a) => a.active);
  const animalOptions = activeAnimals.map((a) => ({ id: a.id, tag_no: a.tag_no, animal_no: a.animal_no, group_name: a.group_name }));

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Gyvūnai"
        actions={
          <div className="flex items-center gap-2">
            <NewVaccinationDialog animals={animalOptions} groups={groups} products={products} currentVetName={session?.profile.full_name} />
            <NewTreatmentDialog animals={animalOptions} diseases={diseases} products={products} currentVetName={session?.profile.full_name} />
            <NewAnimalDialog />
          </div>
        }
      />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <AnimalsTable
          animals={animals ?? []}
          withdrawal={withdrawal ?? []}
          lookups={lookups}
        />
      </div>
    </div>
  );
}
