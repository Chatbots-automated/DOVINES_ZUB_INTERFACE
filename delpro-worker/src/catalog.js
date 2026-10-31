import { config } from "./config.js";
import { gvet } from "./gvet.js";
import { buildRequestData, parseDdmData } from "./gateway.js";
import { log } from "./log.js";

// DelPro catalog -> GVET (0036_delpro_catalog_sync.sql). Read-only towards
// DelPro: GetData only. Types are read in dependency order (parameters before
// the drugs that reference them, usages before treatments, treatments before
// the diagnoses that recommend them). Treatment / TreatmentDrugUsage are
// DelPro's treatment TEMPLATES, not treatment events.
//
// Field spec: snake_case GVET field -> [DelPro property, kind, referenced objectType]
//   kind: key | text | bool | int | num | ref | refs (comma-separated keys)
// `partitionBy` is the property used for the truncation cross-check below.
export const CATALOG_TYPES = [
  {
    objectName: "DrugParameters",
    partitionBy: "UOM",
    fields: {
      key: ["Key", "key"],
      uom: ["UOM", "text"],
      application_method: ["ApplicationMethod", "text"],
      dump_milk_days: ["DumpMilkDays", "int"],
      meat_withhold_days: ["MeatWithholdDays", "int"],
    },
  },
  {
    objectName: "Drug",
    partitionBy: "Active",
    fields: {
      code: ["Code", "key"],
      name: ["Name", "text"],
      active: ["Active", "bool"],
      medicine_name: ["MedicineName", "text"],
      active_substance: ["ActiveSubstance", "text"],
      default_parameters: ["DefaultParameters", "ref", "DrugParameters"],
    },
  },
  {
    objectName: "TreatmentDrugUsage",
    partitionBy: "Frequency",
    fields: {
      key: ["Key", "key"],
      treatment: ["Treatment", "ref", "Treatment"],
      drug: ["Drug", "ref", "Drug"],
      drug_params: ["DrugParams", "ref", "DrugParameters"],
      dosage: ["Dosage", "num"],
      frequency: ["Frequency", "int"],
      treat_cow_days: ["TreatCowDays", "int"],
    },
  },
  {
    objectName: "Treatment",
    partitionBy: "Active",
    fields: {
      code: ["Code", "key"],
      name: ["Name", "text"],
      active: ["Active", "bool"],
      treatment_type: ["TreatmentType", "text"],
      // read-only in the Gateway mapping: usages are separate TreatmentDrugUsage records
      drug_usages: ["DrugUsages", "refs", "TreatmentDrugUsage"],
    },
  },
  {
    objectName: "Diagnosis",
    partitionBy: "Active",
    fields: {
      code: ["Code", "key"],
      name: ["Name", "text"],
      active: ["Active", "bool"],
      recommended_treatment: ["RecommendedTreatment", "ref", "Treatment"],
    },
  },
];

const UPLOAD_BATCH = 500;
const MAX_PARTITIONS = 10;
// Referenced records missing from a possibly truncated type are fetched one by one, at most this many.
const MAX_REF_FETCH = 1000;

// Unparseable values are passed through unchanged: the database re-validates
// every record and counts the bad ones (stats.<type>.invalid) instead of the
// worker silently dropping clinical data.
function typed(kind, value) {
  if (value == null) return kind === "refs" ? [] : null;
  const v = value.trim();
  switch (kind) {
    case "int":
      return /^-?\d+$/.test(v) ? Number(v) : value;
    case "num":
      return /^-?\d+([.,]\d+)?$/.test(v) ? Number(v.replace(",", ".")) : value;
    case "bool":
      if (/^(true|1|yes)$/i.test(v)) return true;
      if (/^(false|0|no)$/i.test(v)) return false;
      return value;
    case "refs":
      return v.split(",").map((k) => k.trim()).filter(Boolean);
    default:
      return v === "" ? null : v;
  }
}

/** One parsed ddmData object -> the typed record delpro_catalog_upload() expects. */
export function normalizeRecord(type, object) {
  const record = {};
  const warnings = [];
  for (const [field, [prop, kind, refType]] of Object.entries(type.fields)) {
    const p = object.properties[prop];
    record[field] = typed(kind, p?.value ?? null);
    if (refType && p?.objectType && p.objectType !== refType) {
      warnings.push(`${type.objectName}.${prop}: objectType ${p.objectType}, laukta ${refType}`);
    }
  }
  return { record, warnings };
}

async function fetchObjects(client, type, where, top) {
  const xml = await client.getDataXml(
    buildRequestData({ objectName: type.objectName, properties: Object.values(type.fields).map(([prop]) => prop), where, top }),
  );
  return parseDdmData(xml).filter((o) => o.objectName === type.objectName);
}

/**
 * Reads one catalog type. `complete` is true only when there is no sign of
 * truncation — only then may GVET mark absent records as removed:
 *   1. the main read returned fewer rows than min(`top`, CATALOG_GATEWAY_ROW_CAP)
 *      — the Gateway has returned exactly 1000 rows on the farm, so 1000 rows
 *      is never taken as the whole catalog, and
 *   2. re-reading per value of `partitionBy` (values taken from DelPro's own
 *      answer, filtered with the verified <equal> condition) neither hits that
 *      cap, finds more rows in total, nor finds keys the main read missed.
 *      Rows found that way are kept. A failed re-read = incomplete.
 * There is no verified paging in the Gateway, so a type over the cap stays
 * incomplete (no removals); referenced records are fetched by key separately
 * (fetchMissingRefs).
 */
export async function readCatalogType(client, type, { maxRows = config.catalogMaxRows, rowCap = config.catalogGatewayRowCap } = {}) {
  const cap = Math.min(maxRows, rowCap || maxRows);
  const keyField = keyFieldOf(type);
  const byKey = new Map();
  const warnings = [];
  let missingKey = 0;
  const add = (objects) => {
    for (const o of objects) {
      const { record, warnings: w } = normalizeRecord(type, o);
      if (!record[keyField]) {
        missingKey += 1;
        continue;
      }
      byKey.set(record[keyField], record);
      warnings.push(...w);
    }
  };

  const main = await fetchObjects(client, type, [], maxRows);
  add(main);
  let truncated = main.length >= cap;
  let note = null;
  let partitions = null;

  const values = [...new Set(main.map((o) => o.properties[type.partitionBy]?.value).filter((v) => v != null))];
  if (type.partitionBy && values.length > 0 && values.length <= MAX_PARTITIONS) {
    try {
      let partitionTotal = 0;
      partitions = {};
      for (const value of values) {
        const part = await fetchObjects(client, type, [{ name: type.partitionBy, value }], maxRows);
        partitions[value] = part.length;
        partitionTotal += part.length;
        if (part.length >= cap) truncated = true;
        add(part);
      }
      if (partitionTotal > main.length || byKey.size > main.length) truncated = true;
    } catch (err) {
      truncated = true;
      note = "partition_check_failed";
      log.warn(`${type.objectName}: pilnumo patikra nepavyko (${err.message}) — tipas laikomas nepilnu.`);
    }
  }

  return {
    records: [...byKey.values()],
    keyField,
    returned: main.length,
    limit: maxRows,
    cap,
    partitions,
    complete: !truncated,
    note: truncated ? (note ?? "truncated") : null,
    missingKey,
    warnings,
  };
}

const keyFieldOf = (type) => Object.entries(type.fields).find(([, [, kind]]) => kind === "key")[0];

/**
 * A type that may be truncated (e.g. DrugParameters over the cap) can still
 * be made to contain every record the other types REFERENCE: each missing
 * key is read with an <equal> on the key property. A lookup that returns a
 * different or more than one record stops the lookups for that type (the
 * filter is then not trusted). The type stays incomplete either way.
 */
export async function fetchMissingRefs(client, results) {
  for (const target of CATALOG_TYPES) {
    const res = results[target.objectName];
    if (!res || res.error || res.complete) continue;
    const keyProp = target.fields[res.keyField][0];
    const have = new Set(res.records.map((r) => r[res.keyField]));
    const wanted = new Set();
    for (const source of CATALOG_TYPES) {
      const src = results[source.objectName];
      if (!src?.records) continue;
      for (const [field, [, kind, refType]] of Object.entries(source.fields)) {
        if (refType !== target.objectName) continue;
        for (const r of src.records) {
          const v = r[field];
          for (const k of kind === "refs" ? (Array.isArray(v) ? v : []) : [v]) if (k != null && typeof k === "string" && !have.has(k)) wanted.add(k);
        }
      }
    }
    if (!wanted.size) continue;

    const keys = [...wanted].slice(0, MAX_REF_FETCH);
    let fetched = 0;
    const missing = [...wanted].slice(MAX_REF_FETCH);
    for (const key of keys) {
      const found = await fetchObjects(client, target, [{ name: keyProp, value: key }], 2);
      const exact = found.filter((o) => (o.properties[keyProp]?.value ?? "").trim() === key);
      if (found.length > 1 || (found.length === 1 && exact.length !== 1)) {
        res.note = "ref_lookup_unreliable";
        log.warn(`${target.objectName}: paieška pagal ${keyProp}=${key} grąžino ${found.length} kitų įrašų — paieška pagal raktą nutraukta.`);
        missing.push(...keys.slice(keys.indexOf(key)));
        break;
      }
      if (exact.length === 0) {
        missing.push(key);
        continue;
      }
      const { record } = normalizeRecord(target, exact[0]);
      res.records.push(record);
      have.add(key);
      fetched += 1;
    }
    res.refFetched = fetched;
    res.refMissing = missing;
    log.info(`${target.objectName}: pagal nuorodas papildomai nuskaityta ${fetched}, DelPro nerasta ${missing.length}.`);
  }
}

/**
 * Gateway Animal ObjectGuid + Number + ORN (for the treatment write). Matching only — a capped read never removes anything.
 * The ORN property name is not verified on every DelPro: if the Gateway rejects it, the read is repeated with Number only.
 */
export async function readAnimalIds(client, { maxRows = config.catalogMaxRows, rowCap = config.catalogGatewayRowCap, ornProperty = config.gateway.animalOrnProperty } = {}) {
  const read = async (props) => parseDdmData(await client.getDataXml(buildRequestData({ objectName: "Animal", properties: props, top: maxRows }))).filter((o) => o.objectName === "Animal");
  let objects;
  let ornError = null;
  if (ornProperty) {
    try {
      objects = await read(["ObjectGuid", "Number", ornProperty]);
    } catch (err) {
      ornError = err.message;
      log.warn(`Animal: DelPro nepriėmė savybės ${ornProperty} (${err.message}) — susiejama tik pagal Number.`);
    }
  }
  if (!objects) objects = await read(["ObjectGuid", "Number"]);
  const animals = objects
    .map((o) => ({
      object_guid: o.properties.ObjectGuid?.value ?? null,
      number: o.properties.Number?.value ?? null,
      orn: ornProperty && !ornError ? (o.properties[ornProperty]?.value ?? null) : null,
    }))
    .filter((a) => a.object_guid && (a.number || a.orn));
  const withOrn = animals.filter((a) => a.orn).length;
  if (ornProperty && !ornError && objects.length > 0 && withOrn === 0) log.warn(`Animal: DelPro negrąžino ${ornProperty} reikšmių — susiejama tik pagal Number.`);
  return { animals, returned: objects.length, withOrn, ornError, complete: objects.length < Math.min(maxRows, rowCap || maxRows) };
}

/** Everything one catalog synchronization reads from DelPro (GetData only). Nothing is sent to GVET here. */
export async function readCatalog(client) {
  const types = {};
  const errors = [];
  for (const type of CATALOG_TYPES) {
    try {
      types[type.objectName] = await readCatalogType(client, type);
    } catch (err) {
      errors.push(`${type.objectName}: ${err.message}`);
      types[type.objectName] = { error: err.message, complete: false, note: "read_failed" };
      log.error(`DelPro katalogas (${type.objectName}):`, err.message);
    }
  }
  try {
    await fetchMissingRefs(client, types);
  } catch (err) {
    errors.push(`nuorodos: ${err.message}`);
    log.error("DelPro katalogas (nuorodos):", err.message);
  }
  for (const [name, res] of Object.entries(types)) {
    if (res.error) continue;
    if (!res.complete) {
      log.warn(`${name}: DelPro grąžino ${res.returned} (riba ${res.cap}) — gali būti ne viskas, pašalinimai nevykdomi.`);
    }
    if (res.missingKey) log.warn(`${name}: ${res.missingKey} įrašai be rakto praleisti.`);
    for (const w of res.warnings.slice(0, 5)) log.warn(w);
  }

  let animals = null;
  try {
    animals = await readAnimalIds(client);
    if (!animals.complete) log.warn(`Animal: DelPro grąžino ${animals.returned} — gali būti ne visi gyvuliai (tik susiejama, niekas nešalinama).`);
  } catch (err) {
    errors.push(`Animal: ${err.message}`);
    log.error("DelPro gyvulių ObjectGuid:", err.message);
  }
  return { types, animals, errors };
}

/** What finish_run / preview get per type (no records). */
const typeInfo = (res) => ({
  complete: res.complete,
  returned: res.returned ?? null,
  limit: res.limit ?? null,
  note: res.note ?? null,
  ...(res.refFetched != null ? { ref_fetched: res.refFetched, ref_missing: res.refMissing.length } : {}),
});

/**
 * One catalog synchronization: read everything -> begin run -> upload per type
 * in batches -> animal ids -> finish (GVET marks removals for complete types and
 * reconciles). A failed type is reported incomplete; the others still sync.
 */
export async function runCatalogSync(client) {
  const read = await readCatalog(client);
  const { run_id } = await gvet.catalogBeginRun({ worker_id: config.workerId });
  const types = {};
  const errors = [...read.errors];

  for (const type of CATALOG_TYPES) {
    const res = read.types[type.objectName];
    if (!res.error) {
      try {
        for (let i = 0; i < res.records.length; i += UPLOAD_BATCH) {
          await gvet.catalogUpload({ run_id, object_type: type.objectName, records: res.records.slice(i, i + UPLOAD_BATCH) });
        }
      } catch (err) {
        errors.push(`${type.objectName}: ${err.message}`);
        types[type.objectName] = { complete: false, note: "upload_failed" };
        log.error(`DelPro katalogas (${type.objectName}):`, err.message);
        continue;
      }
    }
    types[type.objectName] = typeInfo(res);
  }

  if (read.animals?.animals.length) {
    try {
      const res = await gvet.ingestAnimalIds({ run_id, animals: read.animals.animals });
      log.info(`DelPro gyvulių ObjectGuid → GVET: ${JSON.stringify({ ...res, conflict_samples: undefined })}`);
    } catch (err) {
      errors.push(`Animal: ${err.message}`);
      log.error("DelPro gyvulių ObjectGuid:", err.message);
    }
  }

  const result = await gvet.catalogFinishRun({ run_id, types, error: errors.length ? errors.join("; ").slice(0, 2000) : null });
  log.info(`DelPro katalogas → GVET: ${result?.status} ${JSON.stringify(result?.reconcile ?? {})}`);
  return result;
}

/**
 * Dry run: the same DelPro reads, then ONE call to delpro_catalog_preview,
 * which runs the real GVET pipeline and rolls it back. No begin/upload/finish/
 * ingest call is made, so nothing in GVET or DelPro changes.
 */
export async function previewCatalogSync(client) {
  const read = await readCatalog(client);
  const types = {};
  for (const [name, res] of Object.entries(read.types)) {
    types[name] = res.error ? { complete: false, note: "read_failed" } : { ...typeInfo(res), records: res.records };
  }
  const preview = await gvet.catalogPreview({
    worker_id: config.workerId,
    types,
    animals: read.animals?.animals ?? [],
    error: read.errors.length ? read.errors.join("; ").slice(0, 2000) : null,
  });
  if (preview?.dry_run !== true || preview?.rolled_back !== true) {
    throw new Error("delpro_catalog_preview negrąžino dry_run/rolled_back patvirtinimo — sustabdyta.");
  }
  return { read, preview };
}
