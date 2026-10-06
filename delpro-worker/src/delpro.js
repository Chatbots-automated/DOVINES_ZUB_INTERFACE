import fs from "node:fs";
import { config, readQuery, isPlaceholder } from "./config.js";

// DelPro access. `mssql` is imported lazily so the json source (tests,
// manual-export fallback) runs without the driver installed.
let poolPromise = null;

async function pool() {
  if (!poolPromise) {
    const sql = (await import("mssql")).default;
    poolPromise = sql.connect({
      server: config.sql.server,
      database: config.sql.database,
      user: config.sql.user,
      password: config.sql.password,
      options: {
        instanceName: config.sql.instance || undefined,
        encrypt: false, // local SQL Server Express, no TLS certificate
        trustServerCertificate: true,
      },
      pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
    });
    poolPromise.catch(() => {
      poolPromise = null;
    });
  }
  return poolPromise;
}

export async function query(sqlText, params = {}) {
  const p = await pool();
  const req = p.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v ?? null);
  const result = await req.query(sqlText);
  return result.recordset ?? [];
}

function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

const str = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const bool = (v) => (v == null || v === "" ? null : v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true");
const toIsoTimestamp = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** DelPro may give the bulls as one string or a list; GVET stores a comma-separated string. */
const joinList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join(", ") || null : str(v));
/** Missing / blind teats: array or comma-separated string of FL, FR, HL, HR. */
function teats(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\s]+/) : [];
  const ok = list.map((x) => String(x).trim().toUpperCase()).filter((x) => ["FL", "FR", "HL", "HR"].includes(x));
  return v == null ? null : ok;
}

function normalizeAnimal(r) {
  return {
    delpro_animal_id: r.delpro_animal_id == null ? null : String(r.delpro_animal_id).trim(),
    animal_no: r.animal_no == null ? null : String(r.animal_no).trim(),
    tag_no: r.tag_no == null ? null : String(r.tag_no).trim(),
    name: r.name ?? null,
    sex: r.sex ?? null,
    breed: r.breed ?? null,
    birth_date: toIsoDate(r.birth_date),
    group_id: r.group_id == null ? null : String(r.group_id),
    group_name: r.group_name ?? null,
    lactation_no: r.lactation_no ?? null,
    active: r.active === undefined || r.active === null ? true : Boolean(r.active),
    // DairyPlan-style fields (Priedas §3.3 "kiti suderinti laukai"); all optional,
    // null = DelPro did not supply it (GVET keeps the previous value).
    reproduction_status: str(r.reproduction_status),
    last_calving_date: toIsoDate(r.last_calving_date),
    days_in_milk: num(r.days_in_milk),
    milk_yield_kg: num(r.milk_yield_kg),
    last_milking_at: toIsoTimestamp(r.last_milking_at),
    last_milking_kg: num(r.last_milking_kg),
    produces_milk: bool(r.produces_milk),
    last_insemination_date: toIsoDate(r.last_insemination_date),
    insemination_count: num(r.insemination_count),
    last_bulls: joinList(r.last_bulls),
    is_pregnant: bool(r.is_pregnant),
    pregnancy_days: num(r.pregnancy_days),
    expected_calving_date: toIsoDate(r.expected_calving_date),
    dry_off_date: toIsoDate(r.dry_off_date),
    genetic_worth: str(r.genetic_worth),
    blood_line: str(r.blood_line),
    missing_teats: teats(r.missing_teats),
    health_alert: str(r.health_alert),
    group_since: toIsoDate(r.group_since),
  };
}

/** Full herd snapshot + group list, in the shape upsert_animals_from_delpro() expects. */
export async function readHerd() {
  if (config.source === "json") {
    const data = JSON.parse(fs.readFileSync(config.jsonFile, "utf8"));
    return { groups: data.groups ?? [], animals: (data.animals ?? []).map(normalizeAnimal) };
  }

  const animalsSql = readQuery("animals.sql");
  if (isPlaceholder(animalsSql)) {
    throw new Error("queries/animals.sql dar neužpildyta (TODO(discovery)) — paleiskite `npm run discover` ir užpildykite užklausą.");
  }
  const groupsSql = readQuery("groups.sql");
  const [animals, groups] = await Promise.all([
    query(animalsSql),
    isPlaceholder(groupsSql) ? Promise.resolve([]) : query(groupsSql),
  ]);
  return {
    groups: groups.map((g) => ({ delpro_group_id: g.delpro_group_id == null ? null : String(g.delpro_group_id), name: g.name, active: g.active ?? true })),
    animals: animals.map(normalizeAnimal),
  };
}

/** Flattens an approved GVET payload into the named SQL parameters. */
export function treatmentParams(job) {
  const d = job.delpro;
  return {
    sync_id: job.sync_id,
    delpro_animal_id: job.animal.delpro_animal_id,
    animal_no: job.animal.animal_no,
    tag_no: job.animal.tag_no,
    event_date: d.event_date,
    diagnosis: d.diagnosis,
    diagnosis_code: d.diagnosis_code,
    treatment_code: d.treatment_code,
    treatment_text: d.products.map((p) => `${p.name} ${p.qty} ${p.unit ?? ""}`.trim()).join("; "),
    milk_withdrawal_days: d.milk_withdrawal_days,
    meat_withdrawal_days: d.meat_withdrawal_days,
    withdrawal_until_milk: d.withdrawal_until_milk,
    withdrawal_until_meat: d.withdrawal_until_meat,
    vet_name: d.vet_name,
  };
}

export function outboundReady() {
  return !isPlaceholder(readQuery("insert-treatment.sql")) && !isPlaceholder(readQuery("readback-treatment.sql"));
}

/** Writes one approved treatment into DelPro and reads it back for verification. */
export async function writeTreatment(job) {
  const params = treatmentParams(job);
  await query(readQuery("insert-treatment.sql"), params);
  const [row] = await query(readQuery("readback-treatment.sql"), params);
  if (!row) throw new Error("Įrašas DelPro nerastas po įrašymo (readback grąžino 0 eilučių).");
  return {
    animal_no: row.animal_no == null ? null : String(row.animal_no),
    event_date: toIsoDate(row.event_date),
    diagnosis: row.diagnosis ?? null,
    treatment_code: row.treatment_code ?? null,
    milk_withdrawal_days: row.milk_withdrawal_days ?? null,
    meat_withdrawal_days: row.meat_withdrawal_days ?? null,
  };
}
