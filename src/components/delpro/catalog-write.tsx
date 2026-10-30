import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/components/delpro/action-button";
import { CatalogOutboundModeForm, UncertainStepForm } from "@/components/delpro/catalog-controls";
import {
  catalogJobAction,
  createCatalogTestJob,
  createPilotDrug,
  markCatalogValidated,
  releaseSingleCatalogJob,
  setCatalogWriteEnabled,
  unvalidateCatalogOperation,
} from "@/lib/actions/delpro-catalog";
import {
  CATALOG_JOB_STATUS_LABEL,
  CATALOG_JOB_STATUS_TONE,
  CATALOG_OBJECT_LABEL,
  CATALOG_WRITE_OPERATIONS,
  type CatalogOutboundMode,
} from "@/lib/delpro-catalog";
import { formatDateTime } from "@/lib/utils";
import type { Database } from "@/lib/supabase/types";

export type CatalogJob = Database["public"]["Tables"]["delpro_catalog_jobs"]["Row"];

const OP_LABEL: Record<string, string> = { create: "sukūrimas", update: "atnaujinimas" };

/** Create steps started but never reported done: unknown outcome, decided by an admin (adopt / resend). */
function uncertainSteps(job: CatalogJob) {
  if (!["failed", "needs_review", "verification_failed"].includes(job.status)) return [];
  return job.steps.filter((s) => s.operation === "create" && job.progress[s.id]?.started_at && !job.progress[s.id]?.key);
}

function UncertainSteps({ job }: { job: CatalogJob }) {
  const details = (job.error_details?.details ?? null) as { uncertain_step?: string; candidates?: { key: string; name: string | null }[] } | null;
  return uncertainSteps(job).map((s) => (
    <div key={s.id} className="mt-1 text-[11px] text-text-muted">
      {s.object}
      {s.lookup_name ? ` „${s.lookup_name}“` : ""}: rezultatas nežinomas
      <UncertainStepForm
        jobId={job.id}
        step={s.id}
        keyProperty={s.key_property}
        candidates={details?.uncertain_step === s.id ? (details.candidates ?? []) : []}
      />
    </div>
  ));
}

function opLabel(op: string) {
  const [object, operation] = op.split(".");
  return `${CATALOG_OBJECT_LABEL[object as keyof typeof CATALOG_OBJECT_LABEL] ?? object}: ${OP_LABEL[operation] ?? operation}`;
}

/** The commands an admin runs on the farm PC for the released pilot job (PowerShell 5.1). */
function pilotCommands(jobId: string) {
  return [
    "Set-Location C:\\gvet\\delpro-worker",
    `npm.cmd run catalog:write-check -- ${jobId}`,
    `$env:CATALOG_WRITE_ENABLED = 'true'; npm.cmd run catalog:write-one -- ${jobId}; Remove-Item Env:CATALOG_WRITE_ENABLED`,
  ].join("\n");
}

// 0039: the first real GVET -> DelPro medicine — one inactive test medicine, one job, released alone.
function PilotDrug({ job, singleJob, validated }: { job: CatalogJob | null; singleJob: string | null; validated: boolean }) {
  const released = job !== null && singleJob === job.id;
  const writes = job ? job.steps.filter((s) => s.operation !== "verify_refs") : [];
  return (
    <div className="rounded-md border border-border p-3">
      <p className="mb-1 text-[13px] font-medium">Pirmas tikras vaistas GVET → DelPro (bandymas)</p>
      <p className="mb-2 text-[12px] text-text-muted">
        Sukuriamas vienas neaktyvus GVET vaistas „GVET TEST vaistas …“ (ml, karencija 0 d.) ir jo DelPro sukūrimo užduotis. Ji nevykdoma, kol neleisite
        rašyti <strong>tik jai</strong>; po jos rašymas išsijungia pats. Kitos katalogo ir gydymų rašymo užduotys lieka išjungtos.
      </p>
      {!job ? (
        <ActionButton action={createPilotDrug} fields={{}} label="Sukurti bandomąjį vaistą" confirm="Sukurti neaktyvų GVET vaistą „GVET TEST vaistas …“ ir jo DelPro užduotį?" />
      ) : (
        <div className="space-y-2 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span>{job.label}</span>
            <Badge tone={CATALOG_JOB_STATUS_TONE[job.status]}>{CATALOG_JOB_STATUS_LABEL[job.status]}</Badge>
            <span className="text-text-muted">
              žingsniai {writes.filter((s) => job.progress[s.id]?.key).length}/{writes.length}
              {job.delpro_key ? ` · DelPro Code ${job.delpro_key}` : ""}
            </span>
            {released && <Badge tone="warning">Leista tik šiai užduočiai</Badge>}
          </div>
          {job.error && <div className="text-danger">{job.error}</div>}
          <UncertainSteps job={job} />
          {job.status === "queued" && !released && (
            <ActionButton
              action={releaseSingleCatalogJob}
              fields={{ job_id: job.id }}
              label="Leisti įrašyti tik šią užduotį"
              variant="primary"
              confirm="Įjungti rašymą į DelPro tik šiai vienai užduočiai (DrugParameters + Drug)? Po jos rašymas išsijungs pats."
            />
          )}
          {job.status === "queued" && (
            <div>
              <p className="text-text-secondary">
                Ūkio kompiuteryje (PowerShell): pirmiausia patikra (tik skaito), tada vienas įrašymas.{" "}
                {!released && "Įrašymas veiks tik paspaudus „Leisti įrašyti tik šią užduotį“."}
              </p>
              <pre className="mt-1 overflow-x-auto rounded bg-surface-secondary p-2 text-[11px]">{pilotCommands(job.id)}</pre>
            </div>
          )}
          {job.status === "success" && (
            <div className="space-y-1">
              <p className="text-success">
                Įrašyta į DelPro ir nuskaityta atgal be neatitikimų; GVET ↔ DelPro susiejimas išsaugotas. Pakartotinis paleidimas nieko nesiunčia.
              </p>
              {(job.readback as { object_type: string; record: Record<string, unknown> }[] | null)?.map((r, n) => (
                <div key={n} className="text-text-muted">
                  {r.object_type}: {Object.entries(r.record).map(([k, v]) => `${k}=${v === null ? "—" : String(v)}`).join(", ")}
                </div>
              ))}
              {!validated && (
                <ActionButton
                  action={markCatalogValidated}
                  fields={{ job_id: job.id }}
                  label="Pažymėti „Vaistas: sukūrimas“ patikrinta"
                  confirm="Ar DelPro programoje patikrinote šį vaistą? Po to vaistų sukūrimo užduotys galės būti vykdomos (kai rašymas įjungtas)."
                />
              )}
            </div>
          )}
          {["queued", "failed", "needs_review", "verification_failed"].includes(job.status) && (
            <ActionButton action={catalogJobAction} fields={{ job_id: job.id, action: "cancel" }} label="Atšaukti bandymą" variant="ghost" />
          )}
        </div>
      )}
    </div>
  );
}

// GVET -> DelPro catalog writes (0037): the gate, per-operation validation by
// test records, and the job queue. Nothing here writes to DelPro directly —
// the farm-PC worker executes queued jobs only while every gate is open.
export function CatalogWritePanel({
  writeEnabled,
  workerWriteEnabled,
  validated,
  outboundMode,
  writeChannel,
  jobs,
  singleJob,
}: {
  writeEnabled: boolean;
  workerWriteEnabled: boolean | null;
  validated: string[];
  outboundMode: CatalogOutboundMode;
  writeChannel: string;
  jobs: CatalogJob[];
  singleJob: string | null;
}) {
  const latestTest = (op: string) => jobs.find((j) => j.is_test && `${j.object_type}.${j.operation}` === op);
  const realJobs = jobs.filter((j) => !j.is_test && !j.pilot);
  const pilot = jobs.find((j) => j.pilot && j.status !== "cancelled") ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-text-secondary">Rašymas į DelPro katalogą</span>
        <Badge tone={writeEnabled ? "warning" : "neutral"}>{writeEnabled ? "Įjungtas" : "Išjungtas"}</Badge>
        <ActionButton
          action={setCatalogWriteEnabled}
          fields={{ enabled: writeEnabled ? "0" : "1" }}
          label={writeEnabled ? "Išjungti" : "Įjungti"}
          variant={writeEnabled ? "outline" : "primary"}
          confirm={
            writeEnabled
              ? "Išjungti rašymą į DelPro? Eilė liks, bet nebus vykdoma."
              : "Įjungti rašymą į DelPro? Bus vykdomos tik bandomosios užduotys ir patikrintos operacijos."
          }
        />
        <span className="text-[12px] text-text-muted">
          Ūkio kompiuteryje:{" "}
          {workerWriteEnabled === null ? "nežinoma" : workerWriteEnabled ? "CATALOG_WRITE_ENABLED=true" : "CATALOG_WRITE_ENABLED=false (rašymas neįvyks)"}
        </span>
      </div>

      <PilotDrug job={pilot} singleJob={singleJob} validated={validated.includes("Drug.create")} />

      <CatalogOutboundModeForm mode={outboundMode} />

      <div>
        <p className="mb-1 text-[13px] font-medium">Operacijų patikrinimas bandomaisiais įrašais</p>
        <p className="mb-2 text-[12px] text-text-muted">
          Kiekviena operacija pirmiausia atliekama su neaktyviu „GVET TEST …“ įrašu. Tik kai jis įrašytas ir nuskaitytas atgal be neatitikimų, operaciją galima
          pažymėti patikrinta — tada vykdomos ir tikros užduotys. Bandomuosius įrašus DelPro galima palikti neaktyvius.
        </p>
        <table className="w-full text-[12px]">
          <thead className="border-b border-border text-left text-text-muted">
            <tr>
              <th className="py-1.5 pr-2 font-medium">Operacija</th>
              <th className="px-2 py-1.5 font-medium">Būsena</th>
              <th className="px-2 py-1.5 font-medium">Paskutinis bandymas</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {CATALOG_WRITE_OPERATIONS.map((op) => {
              const test = latestTest(op);
              const isValidated = validated.includes(op);
              return (
                <tr key={op}>
                  <td className="py-1.5 pr-2">{opLabel(op)}</td>
                  <td className="px-2 py-1.5">{isValidated ? <Badge tone="success">Patikrinta</Badge> : <Badge tone="neutral">Nepatikrinta</Badge>}</td>
                  <td className="px-2 py-1.5">
                    {test ? (
                      <>
                        <Badge tone={CATALOG_JOB_STATUS_TONE[test.status]}>{CATALOG_JOB_STATUS_LABEL[test.status]}</Badge>{" "}
                        <span className="text-text-muted">{formatDateTime(test.completed_at ?? test.created_at)}</span>
                        {test.error && <div className="text-danger">{test.error}</div>}
                        <UncertainSteps job={test} />
                      </>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap justify-end gap-2">
                      {isValidated ? (
                        <ActionButton action={unvalidateCatalogOperation} fields={{ operation: op }} label="Atšaukti patikrinimą" variant="ghost" />
                      ) : test?.status === "success" ? (
                        <ActionButton
                          action={markCatalogValidated}
                          fields={{ job_id: test.id }}
                          label="Pažymėti patikrinta"
                          variant="primary"
                          confirm="Ar DelPro programoje patikrinote bandomąjį įrašą? Po to šios operacijos užduotys bus vykdomos su tikrais įrašais."
                        />
                      ) : null}
                      {!isValidated && test?.status !== "queued" && test?.status !== "processing" && (
                        <ActionButton action={createCatalogTestJob} fields={{ operation: op }} label="Bandomasis įrašas" />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <p className="mb-2 text-[13px] font-medium">Užduotys į DelPro ({realJobs.length})</p>
        {realJobs.length === 0 ? (
          <p className="text-[12px] text-text-muted">Nėra.</p>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="border-b border-border text-left text-text-muted">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Įrašas</th>
                <th className="px-2 py-1.5 font-medium">Operacija</th>
                <th className="px-2 py-1.5 font-medium">Būsena</th>
                <th className="px-2 py-1.5 font-medium">Žingsniai</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {realJobs.map((j) => {
                const writes = j.steps.filter((s) => s.operation !== "verify_refs");
                const done = writes.filter((s) => j.progress[s.id]?.key).length;
                const gated = j.status === "queued" && (!writeEnabled || !validated.includes(`${j.object_type}.${j.operation}`));
                return (
                  <tr key={j.id}>
                    <td className="py-1.5 pr-2 align-top">
                      {j.label ?? "—"}
                      {j.delpro_key && <span className="text-text-muted"> · DelPro {j.delpro_key}</span>}
                    </td>
                    <td className="px-2 py-1.5 align-top">{opLabel(`${j.object_type}.${j.operation}`)}</td>
                    <td className="px-2 py-1.5 align-top">
                      <Badge tone={CATALOG_JOB_STATUS_TONE[j.status]}>{CATALOG_JOB_STATUS_LABEL[j.status]}</Badge>
                      {gated && <div className="text-text-muted">laukia: {writeEnabled ? "operacija nepatikrinta" : "rašymas išjungtas"}</div>}
                      {j.error && <div className="text-danger">{j.error}</div>}
                      <UncertainSteps job={j} />
                      <div className="text-text-muted">{formatDateTime(j.completed_at ?? j.created_at)}</div>
                    </td>
                    <td className="px-2 py-1.5 align-top">
                      {done}/{writes.length}
                      {writes.some((s) => s.object === "DrugParameters" && s.operation === "create" && j.operation === "update") && (
                        <div className="text-text-muted">nauji parametrai (bendri nekeičiami)</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 align-top">
                      <div className="flex flex-wrap justify-end gap-2">
                        {["failed", "needs_review", "verification_failed"].includes(j.status) && uncertainSteps(j).length === 0 && (
                          <ActionButton
                            action={catalogJobAction}
                            fields={{ job_id: j.id, action: "retry" }}
                            label="Kartoti"
                            confirm="Kartoti? Jau įrašyti ir patikrinti žingsniai praleidžiami."
                          />
                        )}
                        {["queued", "failed", "needs_review", "verification_failed"].includes(j.status) && (
                          <ActionButton action={catalogJobAction} fields={{ job_id: j.id, action: "cancel" }} label="Atšaukti" variant="ghost" />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[12px] text-text-muted">
        Gydymų rašymo kanalas: <strong>{writeChannel === "gateway" ? "DelPro Gateway" : "UI scenarijus (delpro.ps1)"}</strong>.{" "}
        {writeChannel !== "gateway" && "Gateway kanalas (DiagnosesAndTreatmentEvent) paruoštas, bet neįjungtas — įjungiamas tik suderinus su ūkiu."}{" "}
        Gateway kanalas įrašo tik diagnozės įvykį: vaistai perduodami tik kaip tekstas komentare, DelPro vaistų naudojimo įrašai (HealthEventDrugUsage)
        dar nesinchronizuojami.
      </p>
    </div>
  );
}
