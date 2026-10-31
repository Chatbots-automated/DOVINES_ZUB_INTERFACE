import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

// Which Gateway object records a medicine GIVEN to an animal, and how its
// properties map. Nothing here is assumed: the file treatment-model.json is
// written by a person on the farm PC from the read-only probe
// (`npm run treatment-probe`) plus one medicine entered by hand in DelPro and
// read back, and must say "verified": true. Without it, the pilot refuses to
// write — a diagnosis event with medicine names in its Comment is not a
// medication record.
//
// {
//   "verified": true, "verified_by": "...", "verified_at": "YYYY-MM-DD", "evidence": "what was checked",
//   "usage_object": "<object name>",            // the per-animal drug usage object
//   "key_property": "ObjectGuid",
//   "properties": {                             // GVET meaning -> Gateway property name
//     "event": "...",  "drug": "...",                                   // required
//     "date": "..."                                                     // optional
//   },                       // Dosage / DrugParams / Frequency / TreatCowDays are fixed (treatment-gateway.js USAGE_PROPS)
//   "event_treatment_property": null            // set only if the event itself carries a Treatment protocol reference
// }
export const MODEL_FILE = process.env.TREATMENT_MODEL_FILE || path.join(ROOT, "treatment-model.json");
const REQUIRED = ["event", "drug"];

export function validateModel(model) {
  const errors = [];
  if (!model) return ["treatment-model.json nėra — vaistų naudojimo objektas DelPro Gateway dar nepatikrintas (npm run treatment-probe)."];
  if (model.verified !== true) errors.push("treatment-model.json nepažymėtas \"verified\": true.");
  if (!model.usage_object) errors.push("Nenurodytas usage_object.");
  for (const k of REQUIRED) if (!model.properties?.[k]) errors.push(`Nenurodyta savybė properties.${k}.`);
  return errors;
}

export function loadTreatmentModel(file = MODEL_FILE) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
