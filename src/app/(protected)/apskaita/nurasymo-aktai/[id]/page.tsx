import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AllocationEditor, type AllocationInput } from "@/components/nurasymai/allocation-editor";
import { ActHeaderForm, ActStatusActions } from "@/components/nurasymai/act-actions";
import { WRITE_OFF_STATUS as STATUS_LABEL } from "@/lib/write-off-status";
import { WRITE_OFF_KINDS, writeOffPeriodLabel } from "@/lib/write-off-kinds";
import { formatDate, formatDateTime, formatEur } from "@/lib/utils";

export default async function WriteOffActPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: act } = await supabase.from("write_off_acts").select("*").eq("id", id).maybeSingle();
  if (!act) notFound();

  const [{ data: items }, { data: targets }] = await Promise.all([
    supabase
      .from("write_off_act_items")
      .select("*, write_off_act_allocations(write_off_group_id, label, quantity, animal_count, suggested)")
      .eq("act_id", id)
      .order("line_no"),
    supabase.from("vw_write_off_allocation_targets").select("id, label, act_kinds, sort_order").order("sort_order").order("label"),
  ]);

  type Item = NonNullable<typeof items>[number] & { write_off_act_allocations: AllocationInput[] };
  const rows = (items ?? []) as Item[];
  const kindTargets = (targets ?? []).filter((t) => t.act_kinds.includes(act.act_kind)).map((t) => ({ id: t.id, label: t.label }));
  const editable = act.status === "draft";
  const allBalanced = rows.every(
    (i) =>
      Math.abs(i.quantity - i.write_off_act_allocations.reduce((s, a) => s + Number(a.quantity), 0)) <= 0.001 &&
      i.write_off_act_allocations.every((a) => a.write_off_group_id),
  );

  // Totals per group across all products — the template's group columns.
  const byGroup = new Map<string, number>();
  for (const i of rows) {
    for (const a of i.write_off_act_allocations) {
      byGroup.set(a.label, (byGroup.get(a.label) ?? 0) + Number(a.quantity) * Number(i.unit_price));
    }
  }

  const status = STATUS_LABEL[act.status];
  const kind = WRITE_OFF_KINDS[act.act_kind];

  return (
    <div className="flex flex-col">
      <PageHeader
        title={`Aktas Nr. ${act.act_number}`}
        description={`${kind.title} · ${writeOffPeriodLabel(act.period_start, act.period_end)}`}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/apskaita/nurasymo-aktai" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
              <ArrowLeft className="size-4" /> Visi aktai
            </Link>
            <Link
              href={`/spausdinti/nurasymo-aktas/${act.id}`}
              target="_blank"
              className="inline-flex h-8 items-center gap-1.5 rounded-control bg-danger px-3 text-[13px] font-semibold text-white hover:bg-danger/90"
            >
              <Printer className="size-4" /> Spausdinti / PDF
            </Link>
          </div>
        }
      />
      <div className="space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge tone={status?.tone ?? "neutral"}>{status?.label ?? act.status}</Badge>
              <span className="text-[13px] font-normal text-text-muted">
                {kind.label} · suma {formatEur(act.total_amount)}
                {act.approved_at && ` · patvirtinta ${formatDateTime(act.approved_at)}`}
                {act.cancelled_at && ` · anuliuota ${formatDateTime(act.cancelled_at)}`}
              </span>
            </CardTitle>
            <ActStatusActions actId={act.id} status={act.status} allBalanced={allBalanced} />
          </CardHeader>
          <CardContent>
            {editable ? (
              <ActHeaderForm
                actId={act.id}
                actNumber={act.act_number}
                actDate={act.act_date}
                isMaterials={act.act_kind === "medziagos"}
                accountNo={act.account_no}
                expenseObject={act.expense_object}
                approverTitle={act.approver_title}
                approverName={act.approver_name}
                signatories={act.signatories ?? []}
                notes={act.notes}
              />
            ) : (
              <div className="grid gap-3 text-[13px] sm:grid-cols-3">
                <p>
                  <span className="text-text-muted">Akto data:</span> {formatDate(act.act_date)}
                </p>
                <p>
                  <span className="text-text-muted">Tvirtina:</span> {[act.approver_title, act.approver_name].filter(Boolean).join(" ") || "—"}
                </p>
                <p>
                  <span className="text-text-muted">Pasirašo:</span>{" "}
                  {(act.signatories ?? []).map((s) => `${s.title} ${s.name}`).join("; ") || "—"}
                </p>
                {act.act_kind === "medziagos" && (
                  <p className="sm:col-span-3">
                    <span className="text-text-muted">Sąskaita:</span> {act.account_no ?? "—"} ·{" "}
                    <span className="text-text-muted">Išlaidų objektas:</span> {act.expense_object ?? "—"}
                  </p>
                )}
                {act.notes && (
                  <p className="whitespace-pre-line sm:col-span-3">
                    <span className="text-text-muted">Pastabos:</span> {act.notes}
                  </p>
                )}
              </div>
            )}
            {editable && !allBalanced && (
              <p className="mt-3 rounded-control bg-warning-soft px-3 py-2 text-[12px] text-warning">
                Ne visi produktai paskirstyti į grupes. Aktą bus galima patvirtinti tik tada, kai kiekvieno produkto paskirstymas sutaps su bendru
                kiekiu ir neliks „Nepriskirta grupei“ eilučių. Automatinis priskyrimas nustatomas{" "}
                <Link href="/apskaita/nurasymo-grupes" className="underline">
                  Nurašymo grupėse
                </Link>
                .
              </p>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            {rows.map((i) => (
              <AllocationEditor
                key={i.id}
                actId={act.id}
                itemId={i.id}
                lineNo={i.line_no}
                productName={i.product_name}
                nomenclatureNo={i.nomenclature_no}
                lots={i.lots}
                unit={i.unit_label ?? i.unit}
                quantity={Number(i.quantity)}
                unitPrice={Number(i.unit_price)}
                totalPrice={Number(i.total_price)}
                allocations={i.write_off_act_allocations.map((a) => ({ ...a, quantity: Number(a.quantity) }))}
                targets={kindTargets}
                editable={editable}
              />
            ))}
          </div>
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Suma pagal grupes</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {[...byGroup.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([label, sum]) => (
                    <div key={label} className="flex items-center justify-between px-5 py-2 text-[13px]">
                      <span className="text-text-primary">{label}</span>
                      <span className="tabular-nums text-text-secondary">{formatEur(sum)}</span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
