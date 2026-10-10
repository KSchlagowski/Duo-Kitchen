// Deploy gate (F-03): fails when a migration in supabase/migrations/ is not recorded on the linked
// hosted Supabase project, so a forgotten `npx supabase db push` stops the deploy instead of shipping
// app code against an older schema. CI has no database password, so it cannot push migrations
// itself; `supabase db query --linked` goes through the Management API, like `npm run test:rls`.
// Read-only. Run from the repo root: node scripts/check-migrations.mjs [--dry-run] (prints the SQL only)
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("supabase/migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();
const malformed = files.filter((name) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(name));
if (malformed.length > 0) {
  console.error(`Migration file names must be YYYYMMDDHHmmss_short_description.sql: ${malformed.join(", ")}`);
  process.exit(1);
}

// Only 14-digit strings reach the SQL, so interpolating them is safe.
const versions = files.map((name) => name.slice(0, 14));
const sql = `do $$
declare
  missing text;
begin
  select string_agg(v, ', ' order by v) into missing
  from unnest(array[${versions.map((v) => `'${v}'`).join(", ")}]::text[]) as v
  where v not in (select version from supabase_migrations.schema_migrations);
  if missing is not null then
    raise exception 'Migrations not applied to the hosted project: %. Run npx supabase db push, then re-run the deploy.', missing;
  end if;
end $$;`;

if (process.argv.includes("--dry-run")) {
  console.log(sql);
  process.exit(0);
}

try {
  execFileSync("npx", ["supabase", "db", "query", "--linked", sql], { stdio: "inherit" });
} catch (error) {
  process.exit(error.status || 1);
}
console.log(`All ${versions.length} migrations are applied to the hosted project.`);
