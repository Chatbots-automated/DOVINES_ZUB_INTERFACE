# Agent notes — Dovinės ŽŪB GVET PRO

## Scope

- Source of truth is the signed Paslaugų teikimo sutartis + **Priedas Nr. 1** (summarized in README.md). Before adding a
  table, column or screen, be able to point at the clause it satisfies. Anything else is billed separately (Sutartis §2.5,
  §4.6, Priedas §1.5/§6.3) — flag it, don't build it.
- **Added at the farm's request (2026-10), NOT in Priedas Nr. 1 — billed separately per Sutartis §2.5/§4.6:** Sėklinimas
  (0017), Vizitai (0018), Nagos (0019), Sinchronizacijos protokolai (0025), the bulk vaccination picker/plan, the extended Biocidai tab, VIC login + daily
  animal import (0013/0014). Don't extend them without confirming scope.
- **Not in scope** (built in sibling projects, deliberately removed here): masinis gydymas,
  gydymų savikaina, VIC sync beyond the animal import, UNIFORM. Animals come from DelPro, not VIC.
  The farm asked (2026-10) for an Integracija → VIC tab that only **stores** VIC logins (0013). Since 0024 there are two, one row each in
  `vic_credentials` keyed by `kind`: `seklinimas` (Sėklinimo prisijungimai — the original login) and `veterinaras`
  (Veterinaro prisijungimai — what the n8n animal import reads). Its password is
  write-only from the app (no table grants; `vic_get_settings()` returns `password_set`, never the password). Any actual
  VIC sync is out of scope and billed separately — but the farm asked for the **daily animal import (0014)**, built:
  `upsert_animals_from_vic(jsonb)` (unnamed param, service_role only), called by an external n8n workflow
  (`n8n/vic-daily-animals.json`, schedule 03:00; the VIC login/scrape node is `TODO(discovery)` — copy it from
  Žibartoniai's workflow, same payload). VIC only *enriches* existing tags (fills nulls; never DelPro values, group or
  active) and inserts unknown tags as `source='vic'`; DelPro's tag fallback later adopts them. Full snapshots deactivate
  only `source='vic'` animals; empty snapshots are refused.
- Single-farm, single-tenant: no `farm_id` anywhere.

## Lineage

Forked from `ZUB_ZIBARTONIAI_INTERFACE` (app shell, design system, journals, pajamavimas/PDF, approval queue pattern), with
the DelPro direction taken from `KAIRAITIENES_UKIS_GVETPRO`. Migrations were **squashed** into a fresh `0001…` chain — do
not look for Žibartoniai's 0013–0021 VIC/UNIFORM history here.

## Database

- Migrations are numbered and additive. Once one has been applied to the live project, never edit it — add a new one.
- `src/lib/supabase/types.ts` is hand-written. Keep it in sync with every migration. Row types must be `type` aliases,
  not `interface`s — supabase-js requires `Record<string, unknown>`-compatible rows, and an interface silently turns
  every table into `never`.
- **All stock-consuming writes go through plpgsql RPCs** (`create_treatment`, `administer_course_dose`,
  `create_vaccinations`, `create_biocide_usage` in 0004, `create_general_usage` in 0012, `receive_invoice` / `delete_invoice` in 0015 — pajamavimas; `create_insemination` 0017; `create_visit` + `*_for_visit` 0018; `create_hoof_exam` 0019; `save_sync_protocol` / `apply_sync_protocol` / `cancel_sync_application` 0025), never through several PostgREST calls from TypeScript. One
  function = one transaction: a stock shortfall rolls back the whole save. Žibartoniai did this client-side and could
  leave a treatment with no medication; here every treatment is also sent to DelPro, so a half-saved one must never exist.
  FEFO lives in `fn_consume_fefo()` (locks batches, skips expired ones).
- `treatments.animal_group_snapshot` / `vaccinations.animal_group_snapshot` freeze the animal's DelPro group at insert.
  Nurašymo aktų paskirstymas pagal grupes depends on it — don't "fix" it to read the current group.
- **Sinchronizacijos protokolai** (0025, farm's request, billed separately): `sync_protocols` + `sync_protocol_steps`
  (day offset from the start date, title, `medications` jsonb) are the farm's own templates. There is **no separate
  screen**: they are created/edited/deleted from `SyncProtocolPicker` ("Naujas protokolas" / "Redaguoti"), which sits in
  Naujas vizitas and the animal panel's Sinchronizacija dialog. "Sinchronizacija" is a visit procedure: picking it in Naujas vizitas swaps the form to
  protocol + start date and `apply_sync_protocol` creates one planned `animal_visits` row per step (time fixed in
  Europe/Vilnius), logged in `sync_protocol_applications` (name snapshot). A visit **copies** the step
  (`sync_step_title`, `planned_medications`), so editing/deleting a protocol never rewrites planned visits. Applying
  consumes **no stock**: the vet records the step from the visit card, which pre-fills the planned medicine into the normal
  treatment dialog → `create_treatment_for_visit` (`procedure_type='sinchronizacija'`, FEFO, karencija). That type is not
  queued for DelPro (only `gydymas` is) — ask the farm before changing that. Protocol medicine is limited to the categories
  the treatment dialog can give (`TREATMENT_PRODUCT_CATEGORIES`, enforced in `fn_sync_clean_medications`). One open
  protocol per animal; `cancel_sync_application` (button on an open sync visit card) cancels the open steps.
  A step has a `kind`: `veiksmas` (procedure/medicine) or `sekinimas` (the insemination, usually the last step of a FTAI protocol).
  A sekinimas step makes a visit with procedure `sekinimas` (also selectable on its own in Naujas vizitas); the card's
  **Įrašyti sėklinimą** opens `NewInseminationDialog` → `create_insemination_for_visit` (0029: links `insemination_records.visit_id`,
  FEFO semen + gloves, closes the visit in the same transaction). Deleting a visit keeps the insemination journal row. `applySyncProtocol` (server action) is shared by
  Naujas vizitas → Sinchronizacija and the animal panel's **Sinchronizacija** button (`ApplySyncProtocolDialog`); the panel's
  **Profilaktika** button is just `NewTreatmentDialog` locked to `procedure_type='profilaktika'` (same FEFO/karencija, not sent to DelPro).
- **Profilaktika / Boliusai product types** (0026 enum + 0027 rules, farm's request): drugs like medicines — `fn_is_drug_category()`
  drives serija+galiojimas on pajamavimas, the vet drug journal and pack-based acts (keep `DRUG_CATEGORIES` in
  `src/lib/product-categories.ts` in sync). A profilaktika treatment may only use these two types
  (`PROPHYLAXIS_CATEGORIES`, filtered in `NewTreatmentDialog` — a UI rule, not a DB constraint). Existing products stay in
  their old category until the farm recategorizes them.
- **Pagrindinis analytics** (0032): both main pages take `?period=` (`src/lib/analytics-period.ts`). Aggregation lives in
  security-invoker views (`vw_stock_value_by_category`, `vw_stock_batch_alerts`) and `analytics_*` SQL functions so it stays
  under PostgREST's 1000-row cap; charts are plain server-rendered CSS (`src/components/analitika/charts.tsx`), no chart lib.
  Money = `usage_items.qty × batches.purchase_price` (per unit); batches without a price count as 0 € and are flagged.
- Animal side panel = `src/components/gyvunai/animal-profile.tsx` (shared by the drawer and /gyvunai/[id]). Extra DelPro
  fields (0020: lactation/reproduction/milk/…) arrive through `upsert_animals_from_delpro` with coalesce-patch semantics.
- Course karencija (0021) = **last dose date** + withdrawal days + 1 (was reg_date-based). **0 days = no karencija** (0028:
  `fn_withdrawal_until()` returns NULL, so a 0-day product like Bioestrovet-milk never sets a date; the MAX over a treatment's
  products ignores it). UI mirror: `withdrawalUntil()` in `src/lib/treatments/planner.ts`. Keep both in sync. `products.subcategory_id`
  + `product_subcategories` (0023); `hoof_care` category lands on the medžiagos act.
- `usage_items` has one source column per consumer (treatment, course dose, vaccination, biocide, general usage,
  insemination, hoof finding) with a single-source CHECK, and `vw_usage_items_detailed` exposes them all. A new
  consumer must add its column to both and **keep every earlier column** (`create or replace view` can't drop/rename).
  Drugs/vaccines show on acts as packages: `products.pack_size` (0016); `act_unit*` are legacy.
- **Pajamavimas** (`receive_invoice`, 0015): one transaction for supplier match/create (VAT code → company code → name),
  invoice header, a batch + invoice line per item. `mode='pdf'` refuses a repeat of the same supplier + invoice number;
  `manual` appends to it. qty = pack size × pack count; `purchase_price` on a batch is **per unit** (line total ÷ qty).
  Medicines, vaccines and biocides require serija + non-expired galiojimo terminas (journals §2.8). `delete_invoice` is
  refused once any of the stock was used. The PDF parse webhook is called from the browser (`src/lib/invoice-parse-client.ts`).
  Journals: `vw_vet_drug_journal` is medicines + vaccines only, dated by invoice date; biocide receipts are in
  `vw_biocide_receiving_journal`.
- **Nurašymo aktai follow the farm's three Excel templates** (0012): `act_kind` `vaistai` (vaistai, biocidai),
  `priedai`, `medziagos`. Numbers are `YYYYMMNN`, shared across kinds. The product's act comes from
  `fn_product_write_off_kind()`, which uses an explicit `products.write_off_kind` or else the category. Allocations go
  into fixed `write_off_groups` columns (Melžiamos karvės / Penimi gyvuliai; Karvės / Veršeliai).
  **How an animal maps to a group is not agreed with the farm yet**, so it is data, not code. `write_off_group_rules`
  match the frozen DelPro group or the lytis. Order is in `fn_resolve_write_off_group()`: the group chosen on the usage
  entry, then a DelPro-group rule, then a lytis rule, then the product's default group. Anything unresolved lands on
  „Nepriskirta“, and approval refuses it. Don't hard-code group logic in TS.
- The farm counts drugs in **packages**, not ml. `products.act_unit` / `act_unit_size` convert stock units to act units
  at generation. `write_off_act_items.unit_label` is the printed unit (free text).
- **Nagos kurso planavimas** (0030, farm's request): in `create_hoof_exam` a finding's **drug** lines (`fn_is_drug_category`) and any
  `course_days` go through `create_treatment()` as a linked treatment (`treatments.hoof_finding_id`, `procedure_type='apziura'` → never
  queued for DelPro), so FEFO, karencija (route-aware; 0-day = none) and the Gydymo kursai board work unchanged; doses 2..N consume stock
  only on `administer_course_dose`. Hoof-care materials stay on `usage_items.hoof_finding_id`. Deleting an exam cascades to its treatment
  (guard refuses when any of it is on a nurašymo aktas). The hoof dialog keeps animal/date/vet and offers "Išsaugoti ir pridėti kitą
  nagą" / "Baigti apžiūrą" per hoof.
- Usage without an animal (needles, gloves, boluses, hoof bath) is recorded in `general_usage`, either as a quantity or
  as a counted remaining stock (usage = non-expired stock − remaining, as the Excel did).
- `write_off_act_usage_items.usage_item_id` is UNIQUE: a usage row can be written off by only one non-cancelled act.
  Cancelling an approved act releases its rows. Approval requires every item's allocations to sum to its quantity.
- Tests (no Docker/Supabase needed — PGlite runs real Postgres in WASM):
  - `npm run test:db` — every migration + `supabase/tests/scenario.sql` (DelPro sync, FEFO, courses, karencija,
    DelPro queue, vaccinations, biocides, general usage, write-off templates/groups/lifecycle, VIC credentials, RLS). Negative checks must use the
    `blocked boolean` pattern already in that file — a bare `exception when others` also swallows your own
    `raise exception`, so the check can never fail.
  - `npm run test:worker` — the DelPro worker against a PostgREST-shaped HTTP shim over the same database.

## DelPro integration (Priedas §3-§4)

- DelPro has no API. `delpro-worker/` runs on the farm PC, talks to DelPro's local SQL Server and makes **outbound-only**
  HTTPS calls to service-role RPCs. The database never does network I/O; the Next.js app never talks to DelPro.
- Worker-facing RPCs that take a request body use a single **unnamed** `jsonb` parameter (`upsert_animals_from_delpro`,
  `delpro_report_job_result`, `delpro_worker_heartbeat`) — PostgREST only passes the raw body through to an unnamed
  param; a named one 404s (PGRST202). Proven the hard way in Žibartoniai (its AGENTS.md has the trace).
  `delpro_claim_next_job(p_worker_id)` is named on purpose (body `{"p_worker_id": …}`).
- Worker RPCs are revoked from `authenticated` and granted to `service_role` only.
- Outbound queue: `delpro_sync_jobs`, one row per `procedure_type = 'gydymas'` treatment. The pending payload is **not
  stored** — `vw_delpro_sync_jobs.preview_payload` builds it live, and `approved_payload` is frozen at approval (or at
  auto-claim in `auto` mode). The worker sends only `approved_payload`. (Žibartoniai froze it at insert, before the
  usage_items existed, so its withdrawal fields were always null.)
- `delpro_report_job_result` compares the worker's read-back of the DelPro record with `approved_payload`; a mismatch is
  `verification_failed`, never `success`. That read-back is the evidence for acceptance criterion §5.8.
- `upsert_animals_from_delpro` treats each call as a full herd snapshot and deactivates `source='delpro'` animals that are
  absent. The worker refuses to send an empty snapshot. A tag held by a *different* DelPro animal is skipped (counted
  in `skipped`), never merged.
- **DelPro write path** — preferred order: DelPro's own import function → UI automation → direct SQL insert into DelPro's
  database. Direct SQL bypasses DelPro's own logic and may affect DeLaval support: only with the farm's written OK.
  All DelPro-specific SQL lives in `delpro-worker/queries/*.sql`; files marked `TODO(discovery)` are placeholders and
  the worker refuses to use them.

## Next.js / Netlify

- Server Actions called **directly** (`await action()` from a client component) can vanish on Netlify as an empty-body
  403. Use `useActionState` + `<form action>` (all actions here), or a Route Handler + `fetch()` for direct calls
  (`/api/pajamavimas/*`, `/api/gydymo-kursai/administer-dose`, `/api/vartotojai/set-frozen`). Route Handlers do a
  manual Origin/Host check.
- `getCurrentProfile()` (`src/lib/auth.ts`) is `cache()`d and reads the `x-zub-session` header middleware forwards —
  always use it for "who is logged in"; keep `encodeSessionHeader()` / `decodeSessionHeader()` in sync.
- `(protected)/layout.tsx` forces `dynamic = "force-dynamic"` (opennextjs-netlify static-detection bug).
- Page files may only export Next's page API — shared constants go in `src/lib/`.
- After stock-consuming writes call `revalidateUsageViews()` (`src/lib/revalidate.ts`).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
