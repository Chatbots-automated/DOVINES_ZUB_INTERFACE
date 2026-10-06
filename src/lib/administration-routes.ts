import type { AdministrationRoute } from "@/lib/supabase/types";

export interface AdministrationRouteInfo {
  code: AdministrationRoute;
  label: string;
  fullLabel: string;
}

// Routes that carry their own optional karencija override (see migration
// 0012_route_withdrawal_and_packaging.sql). "kita" has no override column —
// it always falls back to the product's flat withdrawal_days_milk/meat.
export const ADMINISTRATION_ROUTES: AdministrationRouteInfo[] = [
  { code: "iv", label: "i.v.", fullLabel: "į veną (i.v.)" },
  { code: "im", label: "i.m.", fullLabel: "į raumenis (i.m.)" },
  { code: "sc", label: "s.c.", fullLabel: "po oda (s.c.)" },
  { code: "iu", label: "i.u.", fullLabel: "į gimdą (i.u.)" },
  { code: "imm", label: "i.mm.", fullLabel: "į spenį (i.mm.)" },
  { code: "pos", label: "p.o.s.", fullLabel: "per burną (p.o.s.)" },
];

export const ROUTE_OPTIONS: { value: AdministrationRoute; label: string }[] = [
  ...ADMINISTRATION_ROUTES.map((r) => ({ value: r.code, label: r.label })),
  { value: "kita", label: "Kita" },
];

// Full products select-column list for the treatment/vaccination/pajamavimas
// forms — includes every per-route withdrawal column so the medicine picker
// can show route-specific karencija (see getRouteWithdrawalDays() below).
export const PRODUCT_WITHDRAWAL_COLUMNS =
  "id, name, unit, category, withdrawal_days_milk, withdrawal_days_meat, withdrawal_iv_milk, withdrawal_iv_meat, withdrawal_im_milk, withdrawal_im_meat, withdrawal_sc_milk, withdrawal_sc_meat, withdrawal_iu_milk, withdrawal_iu_meat, withdrawal_imm_milk, withdrawal_imm_meat, withdrawal_pos_milk, withdrawal_pos_meat";

export type WithdrawalFieldKey =
  | "withdrawal_iv_milk" | "withdrawal_iv_meat"
  | "withdrawal_im_milk" | "withdrawal_im_meat"
  | "withdrawal_sc_milk" | "withdrawal_sc_meat"
  | "withdrawal_iu_milk" | "withdrawal_iu_meat"
  | "withdrawal_imm_milk" | "withdrawal_imm_meat"
  | "withdrawal_pos_milk" | "withdrawal_pos_meat";

export function withdrawalFieldKey(code: AdministrationRoute, kind: "milk" | "meat"): WithdrawalFieldKey {
  return `withdrawal_${code}_${kind}` as WithdrawalFieldKey;
}

export const EMPTY_WITHDRAWAL_ROUTE_FIELDS: Record<WithdrawalFieldKey, string> = {
  withdrawal_iv_milk: "", withdrawal_iv_meat: "",
  withdrawal_im_milk: "", withdrawal_im_meat: "",
  withdrawal_sc_milk: "", withdrawal_sc_meat: "",
  withdrawal_iu_milk: "", withdrawal_iu_meat: "",
  withdrawal_imm_milk: "", withdrawal_imm_meat: "",
  withdrawal_pos_milk: "", withdrawal_pos_meat: "",
};

// Client-side mirror of fn_route_withdrawal_days() in migration 0012 — used
// to preview karencija in the treatment/course UI before the server
// recomputes the real value via the usage_items trigger.
export function getRouteWithdrawalDays(
  product: Partial<Record<WithdrawalFieldKey, number | null>> & {
    withdrawal_days_milk?: number | null;
    withdrawal_days_meat?: number | null;
  } | null | undefined,
  route: AdministrationRoute | null | undefined,
  kind: "milk" | "meat",
): number {
  if (!product) return 0;
  const fallback = (kind === "milk" ? product.withdrawal_days_milk : product.withdrawal_days_meat) ?? 0;
  if (!route || route === "kita") return fallback;
  const routeSpecific = product[withdrawalFieldKey(route, kind)];
  return routeSpecific ?? fallback;
}
