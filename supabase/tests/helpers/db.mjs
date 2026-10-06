// In-process Postgres (PGlite, Postgres compiled to WASM) with a minimal
// stand-in for Supabase's `auth` schema and roles, running every migration
// in supabase/migrations in order. Used by the SQL scenario test and the
// DelPro worker integration test — no Docker / Supabase CLI needed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

const PRELUDE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
`;

export async function createTestDb() {
  const db = new PGlite();
  await db.exec(PRELUDE);
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    // pgcrypto isn't bundled with PGlite; gen_random_uuid() is core since PG13.
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/create extension if not exists "pgcrypto";/, "");
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
  }
  // What Supabase grants on the public schema by default.
  await db.exec(`
    grant usage on schema public to anon, authenticated, service_role;
    grant all on all tables in schema public to authenticated, service_role;
    grant all on all sequences in schema public to authenticated, service_role;
  `);
  return db;
}

/** Splits a SQL script on top-level semicolons (outside $$ bodies), dropping comment lines. */
export function splitStatements(script) {
  const out = [];
  let cur = "";
  let inDollar = false;
  for (const line of script.split("\n")) {
    if (!inDollar && line.trim().startsWith("--")) continue;
    cur += line + "\n";
    if (((line.match(/\$\$/g) || []).length) % 2 === 1) inDollar = !inDollar;
    if (!inDollar && line.trimEnd().endsWith(";")) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
