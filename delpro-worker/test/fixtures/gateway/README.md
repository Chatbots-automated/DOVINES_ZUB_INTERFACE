Verbatim DelPro Gateway documents captured on the Dovinės farm PC (PowerShell, 2026-10).
Decoded `GetDataResult` / `CreateDataResult` text only — the outer SOAP response envelopes were not captured
(run `npm run gateway-discover` on the farm PC to save them; add them here when available).

- `animal-337.request.xml`, `animal-337.result.xml` — GetData Animal by Number
- `tdu-197.request.xml`, `tdu-197.result.xml` — GetData TreatmentDrugUsage by Key
- `drugparameters-218.result.xml` — GetData DrugParameters 218 (note the empty ApplicationMethod)
- `createdata-event.result.xml` — CreateData DiagnosesAndTreatmentEvent (diagnosis event for animal 337)
