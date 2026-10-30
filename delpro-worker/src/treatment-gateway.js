import { buildRequestData, escapeXml, parseDdmData } from "./gateway.js";

// Gateway channel for treatments (0037, delpro_write_channel = 'gateway').
// Writes one DiagnosesAndTreatmentEvent in exactly the shape verified on the
// farm (Animal guid, Diagnosis code, EventDate UTC, EventTime local, Comment)
// and reads it back. The frozen gateway entry's Comment starts with the
// GVET:<sync_id> marker; when GVET says verify_before_write (an earlier
// attempt may have written), the marker is looked up first and an existing
// event is reported instead of creating a second one.

const EVENT = "DiagnosesAndTreatmentEvent";
const READ_PROPS = ["ObjectGuid", "Animal", "Diagnosis", "EventDate", "EventTime", "Comment"];

export function buildEventXml(g) {
  return (
    `<ddmData><object name="${EVENT}">` +
    `<property name="Animal" objectType="Animal">${escapeXml(g.animal_guid)}</property>` +
    `<property name="Diagnosis" objectType="Diagnosis">${escapeXml(g.diagnosis_code)}</property>` +
    `<property name="EventDate">${escapeXml(g.event_at)}</property>` +
    `<property name="EventTime">${escapeXml(g.event_time)}</property>` +
    `<property name="Comment">${escapeXml(g.comment)}</property>` +
    `</object></ddmData>`
  );
}

async function readEvents(client, where) {
  const xml = await client.getDataXml(buildRequestData({ objectName: EVENT, properties: READ_PROPS, where, top: 5 }));
  return parseDdmData(xml).filter((o) => o.objectName === EVENT);
}

const toResult = (o) => ({
  channel: "gateway",
  object_guid: o.properties.ObjectGuid?.value ?? null,
  animal_guid: o.properties.Animal?.value ?? null,
  diagnosis_code: o.properties.Diagnosis?.value ?? null,
  event_date: o.properties.EventDate?.value ?? null,
  event_time: o.properties.EventTime?.value ?? null,
  comment: o.properties.Comment?.value ?? null,
});

/** Returns the read-back (actual_result) for delpro_report_job_result. */
export async function writeTreatmentEvent(client, job) {
  const g = job.gateway;
  if (!g?.animal_guid || !g?.diagnosis_code || !g?.comment?.startsWith("GVET:")) {
    throw new Error("Gateway įrašo duomenys neišsamūs (gyvulio ObjectGuid, diagnozės kodas, žymė).");
  }

  if (job.verify_before_write) {
    // The marker is GVET's own sync id, not a name. Filtered again here because
    // whether the Gateway honours <equal> on Comment is not verified; an event is
    // taken as ours only when it is the single one with the marker AND its
    // animal and diagnosis match — anything else is left to a person.
    const marker = g.comment.split(" ")[0];
    const existing = (await readEvents(client, [{ name: "Comment", value: g.comment }])).filter((o) =>
      (o.properties.Comment?.value ?? "").startsWith(marker),
    );
    if (existing.length > 1) throw new Error(`DelPro rado ${existing.length} įrašus su žyme ${marker} — patikrinkite ranka.`);
    if (existing.length === 1) {
      const found = toResult(existing[0]);
      if (String(found.animal_guid ?? "").toLowerCase() !== String(g.animal_guid).toLowerCase() || found.diagnosis_code !== g.diagnosis_code) {
        throw new Error(`DelPro įrašas su žyme ${marker} yra kitam gyvuliui ar diagnozei — patikrinkite ranka.`);
      }
      return { ...found, found_existing: true };
    }
  }

  const res = await client.createData(buildEventXml(g));
  const created = res.created.find((c) => c.type === EVENT) ?? res.created[0];
  if (!created?.keyValue) throw new Error("DelPro sukūrė įrašą, bet negrąžino ObjectGuid.");
  const [event] = await readEvents(client, [{ name: created.keyProperty || "ObjectGuid", value: created.keyValue }]);
  if (!event) throw new Error(`Įrašas ${created.keyValue} DelPro nerastas po įrašymo.`);
  return toResult(event);
}
