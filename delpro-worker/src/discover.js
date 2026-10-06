import { config } from "./config.js";
import { query } from "./delpro.js";

// On-site discovery helper: lists DelPro database tables/columns whose names
// look relevant (animals, groups, treatments/health), so the queries/*.sql
// files can be written against the real schema. Read-only.
//
//   npm run discover            -> candidate tables + columns
//   npm run discover -- Animal  -> first 5 rows of table "Animal"

const PATTERN = /(animal|cow|group|pen|treat|health|drug|medic|diagnos|disease|withdraw|event|lact)/i;

async function main() {
  const table = process.argv[2];
  if (table) {
    const rows = await query(`SELECT TOP 5 * FROM [${table.replace(/]/g, "")}]`);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const cols = await query(`
    SELECT t.TABLE_SCHEMA, t.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE
    FROM INFORMATION_SCHEMA.TABLES t
    JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
    WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
    ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION`);

  const byTable = new Map();
  for (const c of cols) {
    const key = `${c.TABLE_SCHEMA}.${c.TABLE_NAME}`;
    if (!byTable.has(key)) byTable.set(key, []);
    byTable.get(key).push(`${c.COLUMN_NAME}:${c.DATA_TYPE}`);
  }
  console.log(`Duomenų bazė ${config.sql.database}: ${byTable.size} lentelių/rodinių.\n`);
  for (const [name, columns] of byTable) {
    if (PATTERN.test(name) || columns.some((c) => PATTERN.test(c))) {
      console.log(`${name}\n  ${columns.join(", ")}\n`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
