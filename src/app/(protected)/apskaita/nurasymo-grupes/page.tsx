import { redirect } from "next/navigation";
import { Info } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ActDefaultsForm,
  AddRuleForm,
  DeleteRuleButton,
  GroupEditForm,
  NewGroupForm,
  type ActDefaults,
} from "@/components/nurasymo-grupes/group-forms";
import { WRITE_OFF_KIND_OPTIONS, WRITE_OFF_KINDS, WRITE_OFF_RULE_FIELDS } from "@/lib/write-off-kinds";
import type { WriteOffKind, WriteOffSignatory } from "@/lib/supabase/types";

function signatoriesText(raw: string | undefined): string {
  try {
    const rows = JSON.parse(raw ?? "[]") as WriteOffSignatory[];
    return rows.map((r) => `${r.title} | ${r.name}`).join("\n");
  } catch {
    return "";
  }
}

// Nurašymo aktų grupės (Priedas §2.9 paskirstymas pagal grupes) — the
// template's group columns, how usage is mapped onto them, and the act
// header defaults. Admin only.
export default async function NurasymoGrupesPage() {
  const session = await getCurrentProfile();
  if (session?.profile.role !== "admin") redirect("/apskaita");

  const supabase = await createClient();
  const [groupsRes, rulesRes, delproGroupsRes, animalsRes, settingsRes] = await Promise.all([
    supabase.from("write_off_groups").select("*").order("sort_order").order("name"),
    supabase.from("write_off_group_rules").select("*").order("created_at"),
    supabase.from("delpro_groups").select("name").eq("active", true).order("name"),
    supabase.from("animals").select("sex").eq("active", true).not("sex", "is", null),
    supabase.from("system_settings").select("setting_key, setting_value").like("setting_key", "write_off_%"),
  ]);

  const groups = groupsRes.data ?? [];
  const rules = rulesRes.data ?? [];
  const delproGroups = (delproGroupsRes.data ?? []).map((g) => g.name);
  const sexes = [...new Set((animalsRes.data ?? []).map((a) => a.sex).filter((s): s is string => !!s))].sort((a, b) =>
    a.localeCompare(b, "lt"),
  );
  const settings = new Map((settingsRes.data ?? []).map((s) => [s.setting_key, s.setting_value ?? ""]));

  const groupById = new Map(groups.map((g) => [g.id, g]));
  // DelPro groups that no active group's rule covers, per template.
  const unmapped = (kind: WriteOffKind) =>
    delproGroups.filter(
      (name) =>
        !rules.some((r) => {
          const g = groupById.get(r.write_off_group_id);
          return (
            g?.active && g.act_kinds.includes(kind) && r.match_field === "delpro_group" && r.match_value.toLowerCase() === name.toLowerCase()
          );
        }),
    );

  const defaults: ActDefaults = {
    letterheadAddress: settings.get("write_off_letterhead_address") ?? "",
    approverTitle: settings.get("write_off_approver_title") ?? "",
    approverName: settings.get("write_off_approver_name") ?? "",
    medziagosAccount: settings.get("write_off_medziagos_account") ?? "",
    medziagosExpenseObject: settings.get("write_off_medziagos_expense_object") ?? "",
    signatories: {
      vaistai: signatoriesText(settings.get("write_off_signatories_vaistai")),
      priedai: signatoriesText(settings.get("write_off_signatories_priedai")),
      medziagos: signatoriesText(settings.get("write_off_signatories_medziagos")),
    },
  };

  return (
    <div className="flex flex-col">
      <PageHeader title="Nurašymo grupės" description="Nurašymo aktų stulpeliai (grupės), gyvulių priskyrimo taisyklės ir aktų antraštės" />
      <div className="space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex gap-3 rounded-panel border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-text-primary">
          <Info className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="space-y-1">
            <p>
              Kol taisyklių nėra, kiekis akte rodomas kaip <b>„Nepriskirta“</b> ir paskirstomas rankiniu būdu. Aktą galima patvirtinti
              tik paskirsčius visą kiekį.
            </p>
            <p className="text-text-secondary">Taisyklė: gyvulio DelPro grupė arba lytis → akto grupė.</p>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            {WRITE_OFF_KIND_OPTIONS.map((kind) => {
              const kindGroups = groups.filter((g) => g.act_kinds.includes(kind.value));
              return (
                <Card key={kind.value}>
                  <CardHeader>
                    <CardTitle>
                      {kind.label}
                      <span className="ml-2 text-[12px] font-normal text-text-muted">{WRITE_OFF_KINDS[kind.value].title}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {kindGroups.length === 0 && <p className="text-[13px] text-text-muted">Šiam aktui grupių nėra.</p>}
                    {kindGroups.map((g) => {
                      const groupRules = rules.filter((r) => r.write_off_group_id === g.id);
                      return (
                        <div key={g.id} className="rounded-panel border border-border p-4">
                          <div className="mb-3 flex flex-wrap items-center gap-2">
                            <p className="text-[14px] font-semibold text-text-primary">{g.name}</p>
                            {!g.active && <Badge tone="neutral">Neaktyvi</Badge>}
                            {g.act_kinds.length > 1 && (
                              <span className="text-[11px] text-text-muted">
                                bendra su: {g.act_kinds.filter((k) => k !== kind.value).map((k) => WRITE_OFF_KINDS[k].label).join(", ")}
                              </span>
                            )}
                          </div>
                          <div className="mb-3 flex flex-wrap items-center gap-1.5">
                            {groupRules.length === 0 ? (
                              <span className="text-[12px] text-text-muted">Taisyklių nėra — priskiriama tik rankiniu būdu.</span>
                            ) : (
                              groupRules.map((r) => {
                                const label = `${WRITE_OFF_RULE_FIELDS[r.match_field]} = ${r.match_value}`;
                                return (
                                  <span
                                    key={r.id}
                                    className="inline-flex items-center gap-1 rounded-badge border border-border-strong bg-surface-secondary py-0.5 pl-2.5 pr-1 text-[12px] text-text-secondary"
                                  >
                                    {label}
                                    <DeleteRuleButton id={r.id} label={label} />
                                  </span>
                                );
                              })
                            )}
                          </div>
                          <AddRuleForm groupId={g.id} delproGroups={delproGroups} sexes={sexes} />
                          <details className="mt-3">
                            <summary className="cursor-pointer text-[12px] text-accent-hover">Redaguoti grupę</summary>
                            <div className="mt-3">
                              <GroupEditForm group={g} />
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="space-y-6">
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>Nepriskirtos DelPro grupės</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-[13px]">
                {delproGroups.length === 0 ? (
                  <p className="text-text-muted">DelPro grupių dar nėra — jos atsiras po pirmo sinchronizavimo.</p>
                ) : (
                  WRITE_OFF_KIND_OPTIONS.map((kind) => {
                    const left = unmapped(kind.value);
                    return (
                      <div key={kind.value}>
                        <p className="mb-1 font-medium text-text-primary">{kind.label}</p>
                        {left.length === 0 ? (
                          <Badge tone="success">Visos priskirtos</Badge>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {left.map((n) => (
                              <Badge key={n} tone="warning">
                                {n}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>Nauja grupė</CardTitle>
              </CardHeader>
              <CardContent>
                <NewGroupForm />
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Aktų antraštės ir parašai</CardTitle>
          </CardHeader>
          <CardContent>
            <ActDefaultsForm defaults={defaults} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
