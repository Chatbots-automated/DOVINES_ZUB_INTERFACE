import { Fragment } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WRITE_OFF_KINDS, writeOffPeriodLabel } from "@/lib/write-off-kinds";
import type { WriteOffSignatory } from "@/lib/supabase/types";
import { PrintTrigger } from "./print-trigger";

// Printable nurašymo aktas (Priedas §2.9) in the farm's own templates
// (Dovinės Excel files, 2026-07): rendered outside the module AppShell so
// only the document prints.
//   vaistai / priedai — one row per product, kiekis+suma per group column,
//                       Viso sunaudota
//   medziagos         — one row per product × group, the group in Pastabos

type Allocation = { write_off_group_id: string | null; label: string; quantity: number };

const num = (v: number, digits: number) =>
  new Intl.NumberFormat("lt-LT", { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(v);
const money = (v: number) => new Intl.NumberFormat("lt-LT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

export default async function PrintWriteOffActPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: act }, { data: items }, { data: settings }, { data: groups }] = await Promise.all([
    supabase.from("write_off_acts").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("write_off_act_items")
      .select("*, write_off_act_allocations(write_off_group_id, label, quantity)")
      .eq("act_id", id)
      .order("line_no"),
    supabase.from("system_settings").select("setting_key, setting_value").in("setting_key", ["farm_name", "write_off_letterhead_address"]),
    supabase.from("write_off_groups").select("id, name, act_kinds, sort_order, active").order("sort_order").order("name"),
  ]);
  if (!act) notFound();

  const farm = new Map((settings ?? []).map((s) => [s.setting_key, s.setting_value ?? ""]));
  type Item = NonNullable<typeof items>[number] & { write_off_act_allocations: Allocation[] };
  const rows = (items ?? []) as Item[];
  const kind = WRITE_OFF_KINDS[act.act_kind];
  const signatories: WriteOffSignatory[] = act.signatories ?? [];

  // Group columns: the template's active groups, plus any label actually
  // used on this act (a since-deactivated group, or a draft's "Nepriskirta").
  const columns: string[] = (groups ?? []).filter((g) => g.active && g.act_kinds.includes(act.act_kind)).map((g) => g.name);
  for (const i of rows) for (const a of i.write_off_act_allocations) if (!columns.includes(a.label)) columns.push(a.label);

  const qtyIn = (i: Item, label: string) =>
    i.write_off_act_allocations.filter((a) => a.label === label).reduce((s, a) => s + Number(a.quantity), 0);
  const sumIn = (label: string) => rows.reduce((s, i) => s + qtyIn(i, label) * Number(i.unit_price), 0);
  const total = rows.reduce((s, i) => s + Number(i.total_price), 0);

  const watermark =
    act.status === "cancelled" ? "ANULIUOTAS" : act.status === "draft" ? "JUODRAŠTIS" : null;

  return (
    <div className="mx-auto max-w-[1000px] bg-white p-8 text-[11px] text-black">
      <style>{`
        @page { size: A4 ${act.act_kind === "medziagos" ? "portrait" : "landscape"}; margin: 12mm; }
        @media print { .no-print { display: none !important; } body { background: #fff !important; } }
        .doc table { width: 100%; border-collapse: collapse; }
        .doc th, .doc td { border: 1px solid #000; padding: 2px 4px; vertical-align: middle; }
        .doc th { font-weight: bold; text-align: center; }
        .doc td.r { text-align: right; white-space: nowrap; }
      `}</style>
      <PrintTrigger />
      <div className="doc">
        {act.act_kind === "medziagos" ? (
          <>
            <div className="ml-auto w-fit text-left">
              <p>Tvirtinu: {act.approver_title}</p>
              <p className="mt-1">{act.approver_name}</p>
            </div>
            <p className="mt-6 font-bold">{farm.get("farm_name")}</p>
            <p>{farm.get("write_off_letterhead_address")}</p>
            <h1 className="mt-6 text-center text-[13px] font-bold">
              {kind.title} Nr. {act.act_number}
            </h1>
            <p className="mt-2 text-center">{writeOffPeriodLabel(act.period_start, act.period_end)}</p>
            {watermark && <p className="text-center font-bold">{watermark}</p>}
            <p className="mt-4">Sąskaita {act.account_no ?? ""}</p>
            <p className="mb-3 mt-1">Išlaidų objektas {act.expense_object ?? ""}</p>

            <table>
              <thead>
                <tr>
                  <th>Nom. Nr.</th>
                  <th>{kind.itemHeader}</th>
                  <th>Mato vnt.</th>
                  <th>Kiekis</th>
                  <th>Kaina</th>
                  <th>Suma</th>
                  <th>Pastabos</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) =>
                  i.write_off_act_allocations.map((a, idx) => (
                    <tr key={`${i.id}-${idx}`}>
                      <td>{i.nomenclature_no ?? ""}</td>
                      <td>{i.product_name}</td>
                      <td>{i.unit_label ?? i.unit ?? ""}</td>
                      <td className="r">{num(Number(a.quantity), 3)}</td>
                      <td className="r">{num(Number(i.unit_price), 3)}</td>
                      <td className="r">{money(Number(a.quantity) * Number(i.unit_price))}</td>
                      <td>{a.label}</td>
                    </tr>
                  )),
                )}
                <tr>
                  <td />
                  <td className="font-bold">Viso:</td>
                  <td colSpan={3} />
                  <td className="r font-bold">{money(total)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
            {act.notes && <p className="mt-3 whitespace-pre-line">Pastabos: {act.notes}</p>}

            <div className="mt-10 space-y-6">
              {signatories.map((s, idx) => (
                <p key={idx}>
                  {s.title} &nbsp; {s.name} &nbsp; ____________________
                </p>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-6">
              <div>
                <p className="font-bold uppercase">{farm.get("farm_name")}</p>
                <p>{farm.get("write_off_letterhead_address")}</p>
              </div>
              <div className="text-left">
                <p>Tvirtinu:</p>
                <p>{act.approver_title}</p>
                <p>{act.approver_name}</p>
              </div>
            </div>
            <h1 className="mt-6 text-center text-[13px] font-bold">
              {kind.title} Nr. {act.act_number}
            </h1>
            <p className="mb-3 mt-2 text-center">{writeOffPeriodLabel(act.period_start, act.period_end)}</p>
            {watermark && <p className="mb-2 text-center font-bold">{watermark}</p>}

            <table>
              <thead>
                <tr>
                  <th rowSpan={2}>Eil. Nr.</th>
                  <th rowSpan={2}>{kind.itemHeader}</th>
                  <th rowSpan={2}>Serija</th>
                  <th rowSpan={2}>Mato vnt.</th>
                  <th rowSpan={2}>Kaina</th>
                  {columns.map((c) => (
                    <th key={c} colSpan={2}>
                      {c}
                    </th>
                  ))}
                  <th colSpan={2}>Viso sunaudota</th>
                </tr>
                <tr>
                  {[...columns, "__total"].map((c) => (
                    <Fragment key={c}>
                      <th>kiekis</th>
                      <th>suma</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="r">{i.line_no}</td>
                    <td>{i.product_name}</td>
                    <td>{i.lots ?? ""}</td>
                    <td>{i.unit_label ?? i.unit ?? ""}</td>
                    <td className="r">{num(Number(i.unit_price), 3)}</td>
                    {columns.map((c) => {
                      const q = qtyIn(i, c);
                      return (
                        <Fragment key={c}>
                          <td className="r">{q ? num(q, 3) : ""}</td>
                          <td className="r">{q ? money(q * Number(i.unit_price)) : ""}</td>
                        </Fragment>
                      );
                    })}
                    <td className="r">{num(Number(i.quantity), 3)}</td>
                    <td className="r">{money(Number(i.total_price))}</td>
                  </tr>
                ))}
                <tr>
                  <td />
                  <td className="font-bold">Viso:</td>
                  <td colSpan={3} />
                  {columns.map((c) => (
                    <Fragment key={c}>
                      <td />
                      <td className="r font-bold">{money(sumIn(c))}</td>
                    </Fragment>
                  ))}
                  <td />
                  <td className="r font-bold">{money(total)}</td>
                </tr>
              </tbody>
            </table>
            {act.notes && <p className="mt-3 whitespace-pre-line">Pastabos: {act.notes}</p>}

            <div className="mt-10 flex justify-between gap-8">
              {signatories.map((s, idx) => (
                <div key={idx}>
                  <p>{s.title}</p>
                  <p className="mt-6">______________________</p>
                  <p>{s.name}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
