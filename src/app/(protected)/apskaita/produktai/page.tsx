import Link from "next/link";
import { Pencil, Pill } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductFormDialog } from "@/components/produktai/product-form-dialog";
import { Select } from "@/components/ui/input";
import { SubcategoryManager } from "@/components/produktai/subcategory-manager";
import type { SubcategoryOption } from "@/lib/product-subcategories";
import type { ProductCategory } from "@/lib/supabase/types";
import { PRODUCT_CATEGORY_LABELS, PRODUCT_CATEGORY_OPTIONS } from "@/lib/product-categories";
import { WRITE_OFF_KINDS, productWriteOffKind } from "@/lib/write-off-kinds";

export default async function ProduktaiPage({ searchParams }: { searchParams: Promise<{ category?: string; subcategory?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: allProducts }, { data: groups }, { data: subs }] = await Promise.all([
    supabase.from("products").select("*").order("name"),
    supabase.from("write_off_groups").select("id, name, act_kinds").eq("active", true).order("sort_order"),
    supabase.from("product_subcategories").select("id, category, name, active").order("category").order("sort_order").order("name"),
  ]);
  const groupOptions = groups ?? [];
  const subcategories: SubcategoryOption[] = subs ?? [];
  const subById = new Map(subcategories.map((s) => [s.id, s]));
  const counts: Record<string, number> = {};
  for (const p of allProducts ?? []) if (p.subcategory_id) counts[p.subcategory_id] = (counts[p.subcategory_id] ?? 0) + 1;

  const categoryFilter = sp.category && sp.category in PRODUCT_CATEGORY_LABELS ? (sp.category as ProductCategory) : "";
  const filterSubs = subcategories.filter((s) => !categoryFilter || s.category === categoryFilter);
  const subFilter = sp.subcategory && filterSubs.some((s) => s.id === sp.subcategory) ? sp.subcategory : "";
  const products = (allProducts ?? []).filter(
    (p) => (!categoryFilter || p.category === categoryFilter) && (!subFilter || p.subcategory_id === subFilter),
  );

  return (
    <div className="flex flex-col">
      <PageHeader title="Produktai" actions={
          <div className="flex items-center gap-2">
            <SubcategoryManager subcategories={subcategories} counts={counts} />
            <ProductFormDialog groups={groupOptions} subcategories={subcategories} />
          </div>
        }
      />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
          <Select name="category" defaultValue={categoryFilter} aria-label="Kategorija" className="w-auto min-w-44">
            <option value="">Visos kategorijos</option>
            {PRODUCT_CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
          <Select name="subcategory" defaultValue={subFilter} aria-label="Subkategorija" className="w-auto min-w-44">
            <option value="">Visos subkategorijos</option>
            {filterSubs.map((s) => (
              <option key={s.id} value={s.id}>
                {PRODUCT_CATEGORY_LABELS[s.category]} · {s.name}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" variant="outline">
            Filtruoti
          </Button>
          {(categoryFilter || subFilter) && (
            <Button asChild size="sm" variant="ghost">
              <Link href="/apskaita/produktai">Išvalyti</Link>
            </Button>
          )}
        </form>
        {products.length === 0 ? (
          <EmptyState icon={Pill} title="Produktų nėra" />
        ) : (
          <div className="overflow-x-auto rounded-panel border border-border bg-surface">
            <table className="w-full min-w-[1140px] text-left text-[14px]">
              <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-3 font-medium">Pavadinimas</th>
                  <th className="px-4 py-3 font-medium">Kategorija</th>
                  <th className="px-4 py-3 font-medium">Subkategorija</th>
                  <th className="px-4 py-3 font-medium">Vienetas</th>
                  <th className="px-4 py-3 font-medium">Karencija (pienas/mėsa)</th>
                  <th className="px-4 py-3 font-medium">Reg. Nr. / veiklioji m.</th>
                  <th className="px-4 py-3 font-medium">Antimikrobinis</th>
                  <th className="px-4 py-3 font-medium">Aktas</th>
                  <th className="px-4 py-3 font-medium">Nom. Nr.</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 font-medium text-text-primary">{p.name}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {PRODUCT_CATEGORY_LABELS[p.category] ?? p.category}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {(p.subcategory_id && subById.get(p.subcategory_id)?.name) || "—"}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {p.unit}
                      {p.pack_size && (
                        <span className="block text-[11px] text-text-muted">
                          pak. {p.pack_size} {p.unit}
                        </span>
                      )}
                      {p.standard_amount && (
                        <span className="block text-[11px] text-text-muted">
                          std. {p.standard_amount} {p.unit}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      🥛 {p.withdrawal_days_milk} d. · 🥩 {p.withdrawal_days_meat} d.
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {p.registration_code ?? "—"}
                      {p.active_substance && <span className="text-text-muted"> · {p.active_substance}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {p.is_antimicrobial ? <Badge tone="warning">Taip</Badge> : <span className="text-text-muted">—</span>}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {WRITE_OFF_KINDS[productWriteOffKind(p.category, p.write_off_kind)].label}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{p.nomenclature_no ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <ProductFormDialog
                        product={p}
                        groups={groupOptions}
                        subcategories={subcategories}
                        trigger={
                          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Redaguoti ${p.name}`}>
                            <Pencil className="size-4" />
                          </Button>
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
