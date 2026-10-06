# Dovinės ŽŪB — GVET PRO

Veterinarinės veiklos valdymo sistema Dovinės žemės ūkio bendrovei su dvipuse **DelPro** (DeLaval) integracija.
Kuriama pagal Paslaugų teikimo sutartį ir **Priedą Nr. 1** (€2 000 vienkartinai + €50/mėn. po priėmimo).

Stack: Next.js 16 (App Router) + TypeScript + Tailwind v4 + Supabase (Postgres/Auth/RLS) via `@supabase/ssr`, deployed on
Netlify. DelPro worker: Node 20+ on the farm's Windows PC. See `AGENTS.md` before changing anything.

## Priedas Nr. 1 → where it lives

| § | Funkcija | Kur |
|---|---|---|
| 2.1 | Produktų kortelės (karencija pienui/mėsai, taip pat pagal skyrimo būdą) | Apskaita → Produktai |
| 2.2 / 2.11 | Pajamavimas, PDF sąskaitos išskleidimas (n8n) | Apskaita → Pajamavimas |
| 2.3 / 2.4 | Gydymo įrašai, kelių dienų kursai, FEFO nurašymas | Gyvūnai → gyvūnas → Naujas gydymas; Gydymo kursai |
| 2.5 | Atsargos, likučiai, galiojimas | Apskaita → Atsargos |
| 2.6 | Vakcinacijos (gyvulys ar DelPro grupė), pakartotinės | Veterinarija → Vakcinacijos |
| 2.7 / 2.10 | Gyvulių sąrašas, kortelė, istorija, karencija, filtrai | Gyvūnai, Gydymų istorija |
| 2.8 | 6 žurnalai + spausdinimas / CSV | Apskaita → Žurnalai ir ataskaitos |
| 2.9 | Nurašymo aktai pagal ūkio šablonus: vaistų/biocidų, priedų, medžiagų | Apskaita → Nurašymo aktai, Nurašymo grupės (admin) |
| 2.5 / 2.9 | Sunaudojimas be gyvulio (kiekis arba inventorizacijos likutis) | Apskaita → Sunaudojimas |
| — | Sėklinimas, Vizitai, Nagos, masinė vakcinacija (ūkio prašymu, ne Priedo dalis) | Veterinarija → atitinkami skirtukai |
| — | VIC prisijungimas + kasdienis gyvulių importas (ūkio prašymu, ne Priedo dalis) | Integracija → VIC (admin), `n8n/vic-daily-animals.json` |
| 3 | DelPro → GVET (gyvuliai, grupės) | `delpro-worker/` + `upsert_animals_from_delpro()` |
| 4 | GVET → DelPro (gydymai) | Veterinarija → DelPro (admin) + `delpro-worker/` |

## Journals (§2.8)

| Žurnalas | View |
|---|---|
| Veterinarinių vaistų ir veterinarinių preparatų apskaitos žurnalas | `vw_vet_drug_journal` |
| Gydomų gyvūnų žurnalas | `vw_treated_animals` |
| Gydomų gyvūnų apskaita | `vw_treated_animals_summary` |
| Biocidinių produktų žurnalas | `vw_biocide_journal` |
| Veterinarinių medicininių atliekų žurnalas | `vw_medical_waste` |
| Antimikrobinių vaistų skyrimo ir sunaudojimo ataskaita | `vw_antimicrobial_usage` |

Print layouts follow the farm's templates once supplied (§2.8 "pagal pateiktus ir suderintus šablonus"); the views carry
the data, the layout is app-side.

## DelPro integration

```
 farm PC (Windows)                               Supabase                        GVET PRO app
 ┌──────────────┐  read-only SQL  ┌──────────┐  HTTPS (out only)  ┌──────────────────────┐
 │ DelPro + SQL │ ◀────────────── │  worker  │ ─────────────────▶ │ upsert_animals_…     │ ─▶ Gyvūnai
 │ Server       │ ◀── write+read ─│          │ ◀── claim job ──── │ delpro_sync_jobs     │ ◀─ admin approves
 └──────────────┘      back       └──────────┘ ─── report ──────▶ │ (verified / failed)  │
```

- Outbound mode (Veterinarija → DelPro → Nustatymai): `approval` (default — admin approves each treatment), `auto`
  (sent after a settle delay), `off` (Sutartis §11.4 — pause if something looks wrong).
- Mappings GVET liga/vaistas → DelPro record live on the same screen (§4.3).
- Worker install/run: `delpro-worker/README.md`.

## Getting started

```bash
npm install
cp .env.local.example .env.local      # Supabase URL + keys
npx supabase link --project-ref <ref>
npx supabase db push                  # migrations 0001-0023
npm run dev
```

First admin: create the user in Supabase Auth, then run `supabase/seed_admin_user.sql` with its id/email.

## Checks

```bash
npm run typecheck && npm run lint
npm run test:db       # all migrations + end-to-end SQL scenario (PGlite, no Docker)
npm run test:worker   # DelPro worker ↔ RPC contract
npm run build
```

## Open items before acceptance (Sutartis §4, §5.2)

- DelPro discovery on the farm PC: version, SQL Server access, animal/group/treatment tables, whether DelPro has an
  import function → fill `delpro-worker/queries/*.sql`.
- Farm's templates for the 6 journals. (Nurašymo aktų templates received 2026-10 and implemented: 0012.)
- **How an animal is assigned to Melžiamos karvės / Penimi gyvuliai / Karvės / Veršeliai.** DelPro group? Lytis? Agree
  with the farm, then enter it as rules under Apskaita → Nurašymo grupės. Until then acts are split by hand.
- Per product: act unit/package size (e.g. 100 ml = 1 vnt), Nom. Nr. for materials, default group for animal-less usage.
- Signatory spelling: the Excel has both „Karolina Vaickutė“ and „Karolina Vaičiulė“ (seeded: Vaickutė).
- Farm logo (brand mark is a placeholder icon), user list, opening stock balances, sample supplier PDFs.
- Agree which DelPro record a treatment maps to (§4.3) — the default code or per-product mappings.
