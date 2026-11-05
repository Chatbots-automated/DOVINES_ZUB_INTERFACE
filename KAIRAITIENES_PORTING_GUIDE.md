# Dovinės → Kairaitienės: what Dovinės does that Kairaitienės doesn't (yet)

Written 2026-11-05 from Dovinės ŽŪB GVET at migration **0068** and Kairaitienės GVET at migration **0028**
(`797b0af`). Each item says what the farm sees, where it lives in Dovinės, what Kairaitienės has today, and how
to build it **on Kairaitienės' own model**. Don't copy Dovinės migrations: the schemas are different.

## 0. Read first: the two projects are built differently

| | Dovinės | Kairaitienės |
|---|---|---|
| DelPro ids | on the record: `animals.delpro_object_guid`, `delpro_catalog_links` (Drug/Diagnosis ↔ product/disease) | per installation: `delpro_integrations` + `delpro_animal_mappings` / `delpro_drug_mappings` / `delpro_diagnosis_mappings` / `delpro_treatment_mappings` (`mapping_status` auto/runner/confirmed/stale) |
| Worker auth | service-role key on the farm PC, RPCs called directly | runner token → `/api/integrations/delpro/rpc/[fn]`, every worker RPC takes `p_integration_id` |
| Job | `delpro_sync_jobs`, payload built live, frozen at approval (`approved_payload`) | `delpro_sync_jobs` = **immutable snapshot** made at save (`delpro_enqueue_treatment_sync`, `fn_delpro_sync_jobs_immutable`); live mappings merged at claim (`delpro_job_envelope`) |
| Job statuses | pending_approval → approved → processing → success / error / verification_failed / rejected | pending → (retry / awaiting_mapping / failed) → success, cancelled; leases (`delpro_expire_leases`) |
| Plan problems | `fn_delpro_treatment_plan(job)->problems` | `delpro_treatment_plan(job)` — **same problem codes** (`medicine_not_linked`, `medicine_params_missing`, `unit_mismatch`, `withdrawal_mismatch`, `frequency_missing`, `course_days_missing`, `missing_dose`, `no_animal_guid`, `no_diagnosis_code`, `no_medicine`, + `animal_inactive`) |
| Stock writes | every stock-consuming save is ONE plpgsql RPC (`create_treatment…`) | `gyvunai/actions.ts` inserts treatment → usage_items → courses → course_doses as **separate PostgREST calls** (not atomic) |
| Server Actions | only via `useActionState` + form, or Route Handler + fetch (Netlify drops directly-called actions as an empty 403) | `delpro/job-actions.tsx` calls `retryJob()` / `cancelJob()` **directly** → same Netlify risk |

Two things to settle before porting the big items:
1. **Atomic writes.** Masinis gydymas, Greitas taisymas, sync mass-apply and course dose times all assume "one RPC = one
   transaction". Port `create_treatment` into Kairaitienės first, or each item has to do its own rollback.
2. **Direct Server Action calls.** Switch the DelPro screen to a Route Handler + fetch (Dovinės `/api/delpro/action` +
   `useDelproAction`, `src/lib/delpro-ops.ts`) before adding more buttons to it.

**Scope:** everything below except §1.1–1.4 was added in Dovinės at the farm's request and billed separately
(Sutartis §2.5/§4.6). Check Kairaitienės' Priedas Nr. 1 before building, and flag anything outside it.

---

## 1. DelPro screen (highest value: the farm deals with these errors every day)

### 1.1 Greitas taisymas (quick fix per failed record) — Dovinės 0067 + 0068
**Farm sees:** a **Greitas taisymas** button on every blocked or failed treatment transfer. The dialog lists each
problem, says in plain Lithuanian *why* it happened and **„Ką padarysime: …“**, asks only for what a person must choose,
and **Pataisyti ir siųsti iš naujo** fixes it, resends, and follows the record until it reaches DelPro.

**Dovinės files:** `supabase/migrations/0067_delpro_quick_fix.sql`, `0068_delpro_quick_fix_hardening.sql`,
`src/components/delpro/quick-fix-dialog.tsx`, `src/app/api/delpro/quick-fix/route.ts`, tests in
`supabase/tests/scenario.sql` (0067, 0068 blocks).

**How it works (copy the design, not the SQL):**
- `delpro_quick_fixes(job)` (admin, read): current problems = approval checks + plan checks. It keeps the PC-only ones
  stored on the job (live DelPro checks) and **drops stored GVET-side ones that are now fixed**. Then one fix per
  problem, plus DelPro candidates ranked by name: same normalized name = 100, contains = 60, same first word = 30.
- `delpro_apply_quick_fix({job_id, fixes[]})` (admin): all fixes in one transaction. Then:
  - nothing left → release;
  - something left → keep the fixes and return what's left;
  - needs fresh DelPro data → set `retry_after_catalog_at` and request a catalog sync.

  After a release it also re-releases every *other* failed job the same fix cured. That sweep is wrapped in its own
  exception block, so one bad record never undoes the fix.
- Trigger on catalog-run completion re-releases the waiting jobs, or writes the new reason onto them. **Wrap it in an
  exception block: it runs inside the worker's sync and must never fail it.**
- A hint is added when a medicine's DrugParameters record wasn't seen by the last full catalog read. On Dovinės live,
  DelPro's Drug still pointed at deleted parameters 23629 and 34134. This is a hint only and never blocks sending.

**Fix kinds → Kairaitienės equivalent**

| Problem code | Fix | In Kairaitienės |
|---|---|---|
| `medicine_not_linked` | pick a DelPro Drug (ranked) / "created it in DelPro → refresh" | upsert `delpro_drug_mappings` (integration_id, product_id, delpro_code, `delpro_default_parameters_key` from the catalog item, `mapping_status='confirmed'`) |
| `no_diagnosis_code` | pick a DelPro Diagnosis | upsert `delpro_diagnosis_mappings` (confirmed) |
| `frequency_missing` / `course_days_missing` | two inputs, prefilled 1 / course days | wherever K stores per-medicine frequency (grep `frequency_per_day`). **The job is an immutable snapshot**: cancel it and `delpro_enqueue_treatment_sync()` a new one. |
| `unit_mismatch` | "1 GVET vnt = N DelPro ml" → `products.delpro_dose_factor`; plan sends `qty × factor` in DelPro's UOM, expected UOM = DelPro's | add the column; change `delpro_treatment_plan` (and the snapshot builder if it carries qty). Stock / acts / karencija stay in GVET units. |
| `withdrawal_mismatch` | take DelPro's days into GVET (recommended) / "fixed DelPro → refresh" | ⚠️ K compares the **route-specific** days GVET computed (`withdrawal_{route}_{milk,meat}` columns). Update the column the plan actually used, then recompute stored karencija dates (see §1.5). |
| `no_animal_guid` | fake tag (not `LT` + 12 digits) → reject; real → fix the tag + refresh | `delpro_animal_mappings` come from `delpro_ingest_animal_ids` by ORN = `tag_no` → fix `animals.tag_no`, request a sync |
| `medicine_params_missing`, worker `params_not_in_delpro`, `drug_not_in_delpro`, `diagnosis_not_in_delpro`, `animal_not_in_delpro`, `withdrawal_changed_in_delpro` | refresh DelPro data, resend automatically when done | `delpro_request_catalog_sync(integration)`; the hook is the end of `delpro_ingest_catalog`. K already re-plans parked jobs there (0027 ~line 199) — extend it to re-release `retry_after_catalog_at` jobs. |
| `no_medicine`, `missing_dose`, `animal_inactive` | reject (cancel) | `cancelJob` → bulk version (§1.3) |
| transport errors / unknown | resend the same | K: `retry` status / retryJob |

K already has a partial version: status `awaiting_mapping` + `delpro_requeue_awaiting_mapping()` + catalog-driven
re-planning. Greitas taisymas sits on top of that: it explains each problem, does the fix, and resends.

**Tests to port** (both scenario blocks), including the negatives (vet refused; a failed sync keeps waiting; a broken
record after a sync gets its new reason and the sync still completes).

### 1.2 Simpler DelPro screen + built-in troubleshooting — Dovinės 2026-11-05
**Farm sees:**
- 4 status tiles: Ūkio kompiuteris, Gydymai į DelPro, Vaistai ir ligos, Dienos ataskaita.
- Tabs (`?skirtukas=`): Gydymai → DelPro / Vaistai ir ligos / Dienos ataskaitos / Gyvuliai / Nustatymai. Advanced catalog
  tools live under Nustatymai.
- A **„Ką čia daryti“** box at the top of each section.
- A **„Jei kas nors neveikia“** drawer (top right): every error, why it happens and the steps to fix it, searchable.
- A one-line **„Ką daryti:“** under each problem in the queue.

**Dovinės files:** `src/lib/delpro-help.ts` (≈30 entries, `findHelp(code | message)`),
`src/components/delpro/help-drawer.tsx`, `how-to.tsx`, `sync-queue.tsx`, `src/app/(protected)/veterinarija/delpro/page.tsx`.

**Porting:**
- Copy `how-to.tsx` and `help-drawer.tsx` as they are.
- Rewrite `delpro-help.ts` for K: its statuses (awaiting_mapping, leases), its mapping screens, the runner token flow, and
  its PC paths and restart command (see `delpro-worker/DEPLOY-WINDOWS.md`).
- Keep the rule: a new problem code needs a help entry.

### 1.3 Reject / cancel many at once — Dovinės 0065
Tick records → **Atmesti pažymėtus** (one confirmation). It also works for failed records, but never for
`verification_failed` (DelPro may already hold it). K has single `cancelJob` only: add `delpro_cancel_jobs(uuid[])`
(admin, one transaction, returns the count) plus checkboxes / „Pažymėti visus“ in the queue.

### 1.4 Materials stay in GVET only — Dovinės 0063
Gels, bandages, syringes and supplements (non-drug categories) used in a gydymas are not sent to DelPro and don't block
the transfer. They're listed as `gvet_only`. Only drug categories, or products the farm linked to a DelPro Drug, go in
`medicines`. **Check K's `delpro_treatment_plan`**: if it puts every usage line in `medicines`, any material fails the
whole transfer with "nesusietas su DelPro vaistu".

### 1.5 Live karencija + DelPro as master — Dovinės 0060
- **(A)** Changing a product's withdrawal days recomputes the stored `withdrawal_until_*` of every treatment, course and
  vaccination that used it (`trg_products_withdrawal_recalc`). K recomputes on usage_items / courses changes (0004);
  **check** whether a product edit propagates to old treatments.
- **(B)** Catalog mode `delpro`: DelPro values are imported and applied automatically, except a field changed only in
  GVET. Only port this if the Kairaitienės farm wants DelPro to be master (a farm decision).

### 1.6 DelPro daily Excel reports — Dovinės 0042 (only if the farm asks)
The farm PC uploads each XLSX from `C:\GVET\Ataskaitos\Dienine` to a Netlify function. GVET stores per-animal values;
new columns become fields automatically. Not in K.

### 1.7 DelPro → GVET inseminations — Dovinės 0053–0055
"Deliberately not included" in K. Listed only so it's a conscious choice.

---

## 2. Veterinarija

### 2.1 Kurso planavimas per dose time — Dovinės 0064
- **Farm sees:** each course day row has **kartai per dieną, kas kiek val., pirmas kartas**. Each time gets its own planned
  visit and its own „Skirti HH:MM“ button. Extra doses later on day 1 are possible.
- **Dovinės:**
  - `course_doses.scheduled_time` (Vilnius wall clock; null = once that day, 09:00);
  - one visit per (course, date, time), shared by medicines given at the same time;
  - planner `src/lib/treatments/planner.ts` (`generateCourseRows`, `courseDaysPayload`, `rowSlots`);
  - `course-planner.tsx`, Gydymo kursai board.
- **K:** `course_doses` has `scheduled_date` only; courses are written from `gyvunai/actions.ts`.
- **Port:**
  - add `scheduled_time`;
  - one dose row per time;
  - visits per time, if K links course doses to `animal_visits`;
  - copy the planner (pure TS, has tests);
  - do it inside the atomic `create_treatment` from §0.

### 2.2 Sinchronizacijos tab + mass apply + editing steps — Dovinės 0025, 0059, 0066
- **Farm sees:** `/veterinarija/sinchronizacijos` with four parts:
  - **Nauja sinchronizacija:** pick animals + protocol → planned steps for all of them, in one transaction.
  - **Žingsniai:** grouped by day and protocol step; record all due steps at once. **Redaguoti** per group lets you:
    - tick animals;
    - move the date/time, optionally moving later steps by the same number of days;
    - change medicine/dose/title;
    - skip the step;
    - add animals to the group.
  - **Vykdomi ir istorija**
  - **Protokolai** (templates)
- **K:** a protocol is a *course* (`0024_course_dose_insemination`: the last dose can be an insemination), started from
  Vizitai. There's no tab, no mass apply and no step editing.
- **Port:** decide the model first.
  - Either keep K's course-based protocols and build the tab on `course_doses`: edit = move `scheduled_date` / `time`,
    skip = mark not given, add animals = same course template per animal.
  - Or adopt Dovinės' `sync_protocols` + planned `animal_visits`.

  Dovinės' editing rules worth keeping: only open steps change, the template and recorded steps never change, one open
  protocol per animal, and everything happens in one transaction.

### 2.3 Masinis gydymas, atomic — Dovinės 0056
- K has `/veterinarija/masinis-gydymas` (`bulk-treatment-form.tsx`). Check that it saves **all animals in one
  transaction**. In Dovinės, `create_mass_treatment(jsonb)` means any stock shortfall saves nothing.
- Each gydymas still becomes its own ordinary DelPro job, and **Siųsti į DelPro (N)** releases the whole group.

### 2.4 Frequency + duration per medicine — Dovinės 0046
K ported the DelPro side (0027 plan codes `frequency_missing` / `course_days_missing`). **Check** the treatment dialog
requires both per gydymas medicine and never defaults them, otherwise every job fails in the plan. Old treatments get
fixed with Greitas taisymas (§1.1).

### 2.5 Biocidų planas — Dovinės 0057
- Product + quantity per day + period (≤ 3 months) → one planned row per day. Planning writes nothing off.
- **Patvirtinti** turns chosen due days (today or earlier) into normal biocide usages dated by the planned day. All in one
  transaction; "Nenaudota" = skip.
- Not in K (K has a simple `BiocideUsageForm`).

---

## 3. Apskaita

### 3.1 Pajamavimas → Redagavimas — Dovinės 0058
- Edit a received invoice: header, lines, add/remove lines, and supplier name. Stock without an invoice can be edited
  too.
- Rule: used = received − left. A line can't go below what was already used, and a used line can't change product or
  be removed. Serija, galiojimas and price may change.
- Not in K (receive only).

### 3.2 Product duplicates + merge — Dovinės 0062
- Produktai shows **Produktai tuo pačiu pavadinimu**; `merge_products(keep, remove)` (admin) moves every reference.
- It finds FKs via `pg_constraint`, plus product ids inside JSON columns. In K that's also the `delpro_*_mappings`, so the
  same rules apply: same unit required, not both DelPro-linked.
- Not in K.

---

## 4. Suggested order for Kairaitienės

1. §0 foundations: atomic `create_treatment`, and DelPro screen calls through a Route Handler.
2. §1.4 materials GVET-only (small, stops false failures).
3. §1.2 DelPro screen + help (no DB change).
4. §1.3 bulk cancel.
5. §1.1 Greitas taisymas, on top of K's mapping tables / awaiting_mapping.
6. §2.4 check, §1.5 A check.
7. Then the farm-requested features (§2.1, 2.2, 2.3, 2.5, 3.1, 3.2), each confirmed and billed separately.

For each item: a migration plus a `scenario.sql` block with negative checks, hand-written `types.ts` kept in sync, and a
note in AGENTS.md. Run tsc, eslint and build before pushing.
