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
 *   1. the main read returned fewer rows than `top`, and
 *   2. re-reading per value of `partitionBy` (values taken from DelPro's own
 *      answer, filtered with the verified <equal> condition) neither finds
 *      more rows in total nor finds keys the main read missed. That catches a
 *      Gateway-side cap below `top`. Rows found that way are kept.
 */
export async function readCatalogType(client, type, { maxRows = config.catalogMaxRows } = {}) {
  const keyField = Object.entries(type.fields).find(([, [, kind]]) => kind === "key")[0];
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
  let truncated = main.length >= maxRows;
  let note = null;

  const values = [...new Set(main.map((o) => o.properties[type.partitionBy]?.value).filter((v) => v != null))];
  if (type.partitionBy && values.length > 0 && values.length <= MAX_PARTITIONS) {
    try {
      let partitionTotal = 0;
      for (const value of values) {
        const part = await fetchObjects(client, type, [{ name: type.partitionBy, value }], maxRows);
        partitionTotal += part.length;
        if (part.length >= maxRows) truncated = true;
        add(part);
      }
      if (partitionTotal > main.length || byKey.size > main.length) truncated = true;
    } catch (err) {
      note = "partition_check_failed";
      log.warn(`${type.objectName}: pilnumo patikra nepavyko (${err.message}) — remiamasi tik pagrindine užklausa.`);
    }
  }

  return {
    records: [...byKey.values()],
    returned: main.length,
    limit: maxRows,
    complete: !truncated,
    note: truncated ? "truncated" : note,
    missingKey,
    warnings,
  };
}

/** Gateway Animal ObjectGuid + Number (for the later treatment write). */
export async function readAnimalIds(client, { maxRows = config.catalogMaxRows } = {}) {
  const xml = await client.getDataXml(buildRequestData({ objectName: "Animal", properties: ["ObjectGuid", "Number"], top: maxRows }));
  return parseDdmData(xml)
    .filter((o) => o.objectName === "Animal")
    .map((o) => ({ object_guid: o.properties.ObjectGuid?.value ?? null, number: o.properties.Number?.value ?? null }))
    .filter((a) => a.object_guid && a.number);
}

/**
 * One catalog synchronization: begin run -> per type read + upload in batches
 * -> animal ids -> finish (GVET marks removals for complete types and
 * reconciles). A failed type is reported incomplete; the others still sync.
 */
export async function runCatalogSync(client) {
  const { run_id } = await gvet.catalogBeginRun({ worker_id: config.workerId });
  const types = {};
  const errors = [];

  for (const type of CATALOG_TYPES) {
    try {
      const res = await readCatalogType(client, type);
      for (let i = 0; i < res.records.length; i += UPLOAD_BATCH) {
        await gvet.catalogUpload({ run_id, object_type: type.objectName, records: res.records.slice(i, i + UPLOAD_BATCH) });
      }
      types[type.objectName] = { complete: res.complete, returned: res.returned, limit: res.limit, note: res.note };
      if (!res.complete) {
        log.warn(`${type.objectName}: DelPro grąžino ${res.returned} (riba ${res.limit}) — gali būti ne viskas, pašalinimai nevykdomi.`);
      }
      if (res.missingKey) log.warn(`${type.objectName}: ${res.missingKey} įrašai be rakto praleisti.`);
      for (const w of res.warnings.slice(0, 5)) log.warn(w);
    } catch (err) {
      errors.push(`${type.objectName}: ${err.message}`);
      types[type.objectName] = { complete: false, note: "read_failed" };
      log.error(`DelPro katalogas (${type.objectName}):`, err.message);
    }
  }

  try {
    const animals = await readAnimalIds(client);
    if (animals.length) {
      const res = await gvet.ingestAnimalIds({ run_id, animals });
      log.info(`DelPro gyvulių ObjectGuid → GVET: ${JSON.stringify({ ...res, conflict_samples: undefined })}`);
    }
  } catch (err) {
    errors.push(`Animal: ${err.message}`);
    log.error("DelPro gyvulių ObjectGuid:", err.message);
  }

  const result = await gvet.catalogFinishRun({ run_id, types, error: errors.length ? errors.join("; ").slice(0, 2000) : null });
  log.info(`DelPro katalogas → GVET: ${result?.status} ${JSON.stringify(result?.reconcile ?? {})}`);
  return result;
}
