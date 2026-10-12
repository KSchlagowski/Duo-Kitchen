// Deploy gate (F-03): fails when a migration in supabase/migrations/ is not recorded on the linked
// hosted Supabase project, so a forgotten `npx supabase db push` stops the deploy instead of shipping
// app code against an older schema. CI has no database password, so it cannot push migrations
// itself; `supabase db query --linked` goes through the Management API, like `npm run test:rls`.
// Read-only. Run from the repo root: node scripts/check-migrations.mjs [--dry-run] (prints the SQL only)
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// Through a shell, so `npx` resolves to npx.cmd on Windows too (a shell-less spawn cannot run it and
// exits with no message). The SQL goes through a file, because a shell would split a multi-line
// argument; only the quoted temp path reaches the command line.
const dir = mkdtempSync(join(tmpdir(), "check-migrations-"));
const file = join(dir, "check.sql");
writeFileSync(file, sql);
try {
  execSync(`npx supabase db query --linked -f ${JSON.stringify(file)}`, { stdio: "inherit" });
} catch (error) {
  console.error(error.message);
  process.exit(error.status || 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`All ${versions.length} migrations are applied to the hosted project.`);
