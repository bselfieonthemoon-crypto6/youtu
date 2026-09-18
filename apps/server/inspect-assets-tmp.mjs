import { createRequire } from "node:module";
const require = createRequire(new URL("./package.json", import.meta.url));
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, statement_timeout: 20000, connectionTimeoutMillis: 15000 });
await c.connect();

const cols = await c.query("select column_name from information_schema.columns where table_name='design_resources' order by ordinal_position");
console.log("columns:", cols.rows.map(r => r.column_name).join(","));

const total = await c.query("select count(*)::int n from public.design_resources");
console.log("total rows:", total.rows[0].n);

const live = await c.query("select scope, status, kind, count(*)::int n from public.design_resources where deleted_at is null group by 1,2,3 order by 4 desc");
console.log("live (deleted_at is null):", JSON.stringify(live.rows));

const deleted = await c.query("select count(*)::int n from public.design_resources where deleted_at is not null");
console.log("soft-deleted:", deleted.rows[0].n);

await c.end();
