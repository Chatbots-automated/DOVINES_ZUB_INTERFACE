import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { AnimalProfile } from "@/components/gyvunai/animal-profile";
import { loadAnimalLookups } from "@/lib/animal-lookups";

// Per-animal card (Priedas §2.10 "istorija") as a full page: the very same
// AnimalProfile the list opens in its side panel — info + DelPro card,
// karencija, gydymai, vakcinacijos, sėklinimai, vizitai, nagai, įvykiai.
export default async function AnimalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: animal }, { data: withdrawal }, lookups] = await Promise.all([
    supabase.from("animals").select("*").eq("id", id).maybeSingle(),
    supabase.from("vw_withdrawal_status").select("*").eq("animal_id", id).maybeSingle(),
    loadAnimalLookups(),
  ]);
  if (!animal) notFound();

  return (
    <div className="flex flex-col">
      <PageHeader
        title={animal.animal_no ? `Nr. ${animal.animal_no}` : animal.tag_no}
        description="Gyvūno kortelė — pilna istorija"
        actions={
          <Link href="/veterinarija/gyvunai" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent-hover hover:underline">
            <ArrowLeft className="size-4" /> Atgal į sąrašą
          </Link>
        }
      />
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        <AnimalProfile animal={animal} withdrawal={withdrawal ?? undefined} lookups={lookups} variant="page" />
      </div>
    </div>
  );
}
