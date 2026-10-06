import { Input, Label } from "@/components/ui/input";
import { ADMINISTRATION_ROUTES, withdrawalFieldKey, type WithdrawalFieldKey } from "@/lib/administration-routes";

// Optional per-administration-route karencija overrides, shown when
// creating/editing a product. Used by ProductFormDialog — plain named
// inputs (uncontrolled, read via FormData server-side) to match the rest
// of that form. If a route's field is left blank, the treatment/course UI
// falls back to the product's flat "Pienui / Mėsai" default above (see
// getRouteWithdrawalDays() in lib/administration-routes.ts and
// fn_route_withdrawal_days() in migration 0012).
// `defaults` pre-fills the inputs in edit mode.
export function WithdrawalRouteFields({ defaults }: { defaults?: Partial<Record<WithdrawalFieldKey, number | null>> } = {}) {
  return (
    <div>
      <p className="mb-1 text-[13px] font-semibold text-text-primary">Karencija pagal skyrimo būdą (neprivaloma)</p>
      <p className="mb-3 text-[11px] text-text-muted">
        Jei skirtingi skyrimo būdai turi skirtingą karenciją, nurodykite čia. Gydymo ar kurso metu pasirinkus būdą, sistema
        naudos atitinkamą reikšmę; jei laukas tuščias, naudojama bendra karencija aukščiau.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ADMINISTRATION_ROUTES.map((route) => {
          const milkKey = withdrawalFieldKey(route.code, "milk");
          const meatKey = withdrawalFieldKey(route.code, "meat");
          return (
            <div key={route.code} className="rounded-control border border-border bg-surface p-2.5">
              <p className="mb-1.5 truncate text-[11px] font-semibold text-text-secondary" title={route.fullLabel}>
                {route.fullLabel}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <Label className="mb-1 text-[10px]">🥛</Label>
                  <Input type="number" min="0" name={milkKey} defaultValue={defaults?.[milkKey] ?? ""} placeholder="—" className="h-7 px-1.5 text-[12px]" />
                </div>
                <div>
                  <Label className="mb-1 text-[10px]">🥩</Label>
                  <Input type="number" min="0" name={meatKey} defaultValue={defaults?.[meatKey] ?? ""} placeholder="—" className="h-7 px-1.5 text-[12px]" />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
