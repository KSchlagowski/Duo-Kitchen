// Smoke test: proves the built app, the Cloudflare adapter and the Supabase auth flow still work
// together, that two accounts can be linked into one household (S-01, FR-002/FR-003), and that each
// person's daily macro targets are saved, validated and visible to the partner -- including targets
// set before the redemption, which must arrive in the shared household with their owner (S-02, FR-004).
// S-05: the recipe library renders as cards and a recipe's detail shows macros pinned from SQL.
// S-08: one batch shared across two days solves both together, and editing one day stales both.
// S-09: a plan's aisle-grouped shopping list sums shared products, and either partner checks items off.
// F-03: the app is installable -- the manifest, its icons and the <head> links are served anonymously.
// Zero dependencies on purpose. Run against a live server: BASE_URL=http://localhost:4321 node scripts/smoke.mjs

// Trailing slash stripped deliberately: BASE_URL is sent verbatim as the Origin header, and Astro's
// origin check compares it to url.origin, so "http://localhost:4321/" would 403 every POST.
const BASE_URL = (process.env.BASE_URL ?? "http://localhost:4321").replace(/\/$/, "");
const stamp = Date.now();
// Both must still match README's `smoke-%@example.com` cleanup glob.
const emailA = `smoke-${stamp}@example.com`;
const emailB = `smoke-b-${stamp}@example.com`;
const password = "Smoke-Test-Passw0rd!";

// One client per account: each keeps its own cookie jar, so A and B hold independent sessions.
function makeClient() {
  const jar = new Map();

  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  function storeCookies(response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const [name, ...rest] = pair.split("=");
      // Two deletion spellings, both needed. Supabase's SSR client expires cookies with `max-age=0`;
      // Astro's own `cookies.delete()` instead sends `expires` in the past and deliberately unsets
      // `max-age` (astro/dist/core/cookies/cookies.js), which is how /api/household/redeem clears
      // dk_invite. Honouring only one of the two leaves a deleted cookie live in this jar.
      const expired = attrs.some((a) => {
        const attr = a.trim();
        if (/^max-age=0$/i.test(attr)) return true;
        const match = /^expires=(.+)$/i.exec(attr);
        return match ? Date.parse(match[1]) <= Date.now() : false;
      });
      if (expired) jar.delete(name.trim());
      else jar.set(name.trim(), rest.join("="));
    }
  }

  // `headers` is merged after the defaults, so a step can ask for JSON (S-09's check-off island mode).
  async function request(path, { method = "GET", form, headers = {} } = {}) {
    const response = await fetch(BASE_URL + path, {
      method,
      redirect: "manual",
      headers: {
        Cookie: cookieHeader(),
        Origin: BASE_URL,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    storeCookies(response);
    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
      contentType: response.headers.get("content-type") ?? "",
      body: await response.text(),
    };
  }

  return { request };
}

const a = makeClient();
const b = makeClient();

function testIdText(body, id) {
  const match = new RegExp(`<p[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</p>`).exec(body);
  return match ? match[1].trim() : `${id} line missing`;
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// S-02 fixtures. The display strings mirror formatMacroTargets() in src/lib/services/macro-targets.ts.
const targetsA = { kcal: "2200", protein_g: "160", fat_g: "70", carbs_g: "230" };
const targetsB = { kcal: "1800", protein_g: "120", fat_g: "60", carbs_g: "180" };
const targetsLabelA = "2200 kcal · P 160 g · F 70 g · C 230 g";
const targetsLabelB = "1800 kcal · P 120 g · F 60 g · C 180 g";

// S-05 fixtures. Seed recipe ids from supabase/migrations/20261007120100_seed_products_and_recipes.sql.
// The macro and cooked strings mirror formatMacroTotals() / formatCookedLine() in
// src/lib/services/recipe-macros.ts, but were NOT copied from the page: they are the output of this
// independent SQL oracle (npx supabase db query --linked), which a test of the page must agree with:
//   select round(sum(i.base_amount_g * p.kcal_per_100g    / 100)) as kcal,
//          round(sum(i.base_amount_g * p.protein_per_100g / 100)) as protein_g,
//          round(sum(i.base_amount_g * p.fat_per_100g     / 100)) as fat_g,
//          round(sum(i.base_amount_g * p.carbs_per_100g   / 100)) as carbs_g
//   from public.recipe_ingredients i
//   join public.recipe_components c on c.id = i.component_id
//   join public.products p on p.id = i.product_id
//   where c.recipe_id = '5eed0002-0000-4000-8000-000000000004';
//   select c.position, c.name, sum(i.base_amount_g) as raw_g,
//          round(sum(i.base_amount_g) * c.cooked_yield_ratio) as cooked_g, c.cooked_yield_ratio
//   from public.recipe_components c
//   join public.recipe_ingredients i on i.component_id = c.id
//   where c.recipe_id = '5eed0002-0000-4000-8000-000000000004' and c.cooked_yield_ratio is not null
//   group by c.id order by c.position;
const curryId = "5eed0002-0000-4000-8000-000000000004";
const leczoId = "5eed0002-0000-4000-8000-000000000006";
const zapiekankaId = "5eed0002-0000-4000-8000-000000000008";
const curryTotal = "1532 kcal · P 107 g · F 54 g · C 151 g";
// 161 g × 2.50 = 402.5: the exact .5 case, rounded half up on both sides.
const curryRiceCooked = "Raw 161 g → cooked ≈ 403 g (×2.50)";
const curryChickenCooked = "Raw 416 g → cooked ≈ 312 g (×0.75)";

function testIdBody(id, text) {
  return new RegExp(`data-testid="${id}"[^>]*>\\s*${escapeRe(text)}\\s*</p>`);
}

// S-03 fixtures: a household meal plan saved by A, then shared with and edited by B after linking.
// A fixed far-future start date, so no time zone can shift it. Seed recipe ids are stable (5eed0002-…).
const planStart = "2031-01-06";
const seedRecipe1 = "5eed0002-0000-4000-8000-000000000001";
const seedRecipe2 = "5eed0002-0000-4000-8000-000000000002";
const seedRecipe3 = "5eed0002-0000-4000-8000-000000000003";
const planSaved = new RegExp(`^${escapeRe(`/plan?start=${planStart}&saved=1`)}$`);
const S03_TEST_IDS = ["plan", "plan-summary"];

function planError(message) {
  return new RegExp(`^${escapeRe(`/plan?start=${planStart}&error=${encodeURIComponent(message)}`)}$`);
}

// S-04 fixtures: solving a planned day's macros. Unlike S-05, the numbers are NOT pinned from an SQL
// oracle: the solve is a minimax LP plus rounding repair, and there is no LP in SQL to agree with.
// The run asserts what an end-to-end test can prove instead -- the status strings (which mirror
// formatDaySolveSummary() / formatPlanDayStatus() in src/lib/services/day-solutions.ts), that
// solving twice gives identical numbers, and that the partner sees the same numbers from the other
// side. The exact quantities are covered by `npm test` (src/lib/services/macro-solver.test.ts).
// A start date of its own, so the S-03 plan at planStart is untouched. Fixture days mirror F1-F3.
const solveStart = "2031-01-13";
const seedRecipe4 = curryId;
const seedRecipe6 = leczoId;
const seedRecipe7 = "5eed0002-0000-4000-8000-000000000007";
const seedRecipe8 = zapiekankaId;
const S04_SLOTS = ["breakfast", "second_breakfast", "lunch", "afternoon_snack", "dinner"];
const S04_DAYS = [
  // F1 fits within ±10 %: Jajecznica, Owsianka, curry, Twarożek, Leczo.
  [seedRecipe1, seedRecipe2, seedRecipe4, seedRecipe7, seedRecipe6],
  // F2 no fit: Ciastka, Leczo, Zapiekanka, Ciastka, Leczo.
  [seedRecipe3, seedRecipe6, seedRecipe8, seedRecipe3, seedRecipe6],
  // F3 escalation: F2 without dinner, so 4 meals and no prompt.
  [seedRecipe3, seedRecipe6, seedRecipe8, seedRecipe3],
];
const S04_TEST_IDS = [
  "day-solve-summary",
  "day-solve-stale",
  "day-unsolvable",
  "day-not-found",
  "day-person",
  ...[0, 1, 2].flatMap((n) => [`day-status-${n}`, `day-prompt-${n}`]),
];

function solveForm(extra = {}) {
  const form = { start_date: solveStart };
  S04_DAYS.forEach((recipes, day) => {
    recipes.forEach((recipeId, slot) => {
      form[`d${day}_${S04_SLOTS[slot]}_recipe`] = recipeId;
    });
  });
  return { ...form, ...extra };
}

function solveDayPath(day) {
  return `/plan/day?start=${solveStart}&day=${day}`;
}

function solvedLocation(day) {
  return new RegExp(`^${escapeRe(`${solveDayPath(day)}&solved=1`)}$`);
}

// Every match, not only the first (testIdText); keyed by data-person so "You"/"Partner" can be swapped.
function personLines(body) {
  const lines = {};
  for (const match of body.matchAll(
    /<p[^>]*data-testid="day-person"[^>]*data-person="(you|partner)"[^>]*>([\s\S]*?)<\/p>/g,
  )) {
    lines[match[1]] = match[2].trim().replace(/^(You|Partner) · /, "");
  }
  return lines;
}

let s04LinesA = {};
let s04Tier = "";
let s04Fingerprint = "";

// POSTs a solve, then returns the day page it redirected to; a wrong redirect fails as a 302.
async function solveThenOpen(client, day, extra = {}) {
  const res = await client.request("/api/plan/solve", {
    method: "POST",
    form: { start_date: solveStart, day_index: String(day), ...extra },
  });
  return solvedLocation(day).test(res.location) ? client.request(res.location) : res;
}

// S-08 fixtures: one batch shared across two days. A start date of its own, so the S-03 and S-04 plans
// and their literal meal counts are untouched. Both days are the F1 mix (Phase 1's F5 unit fixture)
// with day 1's lunch eating from day 0's curry batch. 2031-01-20 is a Monday, so day 0 is Monday and
// day 1 Tuesday. The sentences mirror formatGroupSolvePrompt() / formatCookDayNote() /
// formatFromBatchNote() and formatUnsharedNotice() in src/lib/services/{day-solutions,meal-plans}.ts.
const shareStart = "2031-01-20";
const S08_GROUP_PROMPT = "Monday and Tuesday share a batch. Solve their macros together?";
const S08_COOK_NOTE = "Cook the whole batch today — set aside the portions for Tuesday.";
// As rendered: Astro escapes the apostrophe in text content.
const S08_FROM_NOTE = "From Monday&#39;s batch — nothing to cook today.";
const S08_UNSHARED_NOTICE =
  "Tuesday Lunch no longer shares a batch: the slot it shared with is empty or holds another recipe.";
const S08_TEST_IDS = [
  "batch-0_lunch",
  "batch-1_lunch",
  "day-group-0",
  "day-group-1",
  "day-batch-lunch",
  "day-group-note",
];
const shareSaved = new RegExp(`^${escapeRe(`/plan?start=${shareStart}&saved=1`)}$`);

function shareForm(extra = {}) {
  const form = { start_date: shareStart, d1_lunch_batch: "0_lunch" };
  for (const day of [0, 1]) {
    S04_DAYS[0].forEach((recipeId, slot) => {
      form[`d${day}_${S04_SLOTS[slot]}_recipe`] = recipeId;
    });
  }
  // A key set to undefined is dropped, so a step can empty a slot.
  return Object.fromEntries(Object.entries({ ...form, ...extra }).filter(([, value]) => value !== undefined));
}

function shareDayPath(day) {
  return `/plan/day?start=${shareStart}&day=${day}`;
}

// The day page's lunch <section>: from its batch note to the section's end (meal sections never nest).
function lunchSection(body) {
  const at = body.indexOf('data-testid="day-batch-lunch"');
  return at < 0 ? "" : body.slice(at, body.indexOf("</section>", at));
}

// Both days of a group must read the SAME status, byte for byte.
function groupStatusProblem(body, pattern) {
  const [day0, day1] = [testIdText(body, "day-status-0"), testIdText(body, "day-status-1")];
  if (day0 !== day1) return `day 0 reads "${day0}" but day 1 reads "${day1}"`;
  return pattern.test(day0) ? null : `status "${day0}" does not match ${pattern}`;
}

// S-09 fixtures: the shopping list of an unsolved plan of its own (2031-01-27, a Monday): Jajecznica
// at breakfast and Twarożek at second breakfast, which share Szczypiorek and Sól. The amounts and the
// item count were NOT copied from the page: they are the output of this independent SQL oracle
// (npx supabase db query --linked), one base batch per dish summed per product:
//   select p.id, p.name, p.aisle, p.grams_per_piece, sum(ri.base_amount_g) as total_g
//   from public.recipe_ingredients ri
//   join public.recipe_components rc on rc.id = ri.component_id
//   join public.products p on p.id = ri.product_id
//   where rc.recipe_id in ('5eed0002-0000-4000-8000-000000000001', '5eed0002-0000-4000-8000-000000000007')
//   group by p.id, p.name order by p.aisle, p.name;
// It returns 10 products in the produce, dairy, bakery and spices aisles, among them Szczypiorek
// 10 + 20 = 30 g and Jajko kurze 200 g at 50 g per piece. The display strings mirror
// formatShoppingSummary() / formatEstimateNote() / formatExactNote() / formatShoppingAmount() in
// src/lib/services/shopping-list.ts and formatPlanDayStatus() in src/lib/services/day-solutions.ts.
const shopStart = "2031-01-27";
const shopPath = `/plan/shopping?start=${shopStart}`;
const S09_ITEM_COUNT = 10;
const S09_AISLES = ["produce", "dairy", "bakery", "spices"];
const S09_STORE_AISLES = ["produce", "dairy", "meat_fish", "bakery", "dry_goods", "spices", "frozen", "other"];
const chivesId = "5eed0001-0000-4000-8000-000000000006";
const chivesLine = "Szczypiorek 30 g";
const eggId = "5eed0001-0000-4000-8000-000000000001";
const eggLine = "Jajko kurze (rozmiar M) 4 pcs (200 g)";
const saltId = "5eed0001-0000-4000-8000-000000000004";
// A seed product neither recipe uses (the same oracle with `not exists`), so checking it is KD019.
const oatsId = "5eed0001-0000-4000-8000-000000000007";
const S09_NOT_ON_LIST = "That product is not on this plan's shopping list.";
const S09_TEST_IDS = [
  "shopping-summary",
  "shopping-exact",
  "shopping-estimate",
  "shopping-no-plan",
  "shopping-not-found",
  "shopping-unavailable",
  "shopping-toggle-error",
];

function shopCheck(productId, checked) {
  return { start_date: shopStart, product_id: productId, checked: checked ? "1" : "0" };
}

// The visible text of a <li data-testid=…> (tags and React's <!-- --> markers stripped, whitespace
// collapsed): list items nest links and forms, which testIdText()/testIdBody() (<p> only) cannot match.
function testIdItem(body, id) {
  const match = new RegExp(`<li[^>]*data-testid="${escapeRe(id)}"[^>]*>([\\s\\S]*?)</li>`).exec(body);
  return match
    ? match[1]
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : `${id} item missing`;
}

function itemChecked(body, productId) {
  return new RegExp(`<li[^>]*data-testid="item-${productId}"[^>]*data-checked="(true|false)"`).exec(body)?.[1];
}

function itemCheckedProblem(body, productId, expected) {
  const actual = itemChecked(body, productId);
  return actual === String(expected) ? null : `item-${productId} data-checked is ${actual ?? "missing"}`;
}

// Every item testid of the page, in document order.
function itemIds(body) {
  return [...body.matchAll(/data-testid="item-([0-9a-f-]{36})"/g)].map((match) => match[1]);
}

// FR-021: aisles in the fixed enum order, exactly the expected (non-empty) ones.
function aisleOrderProblem(body, expected) {
  const present = S09_STORE_AISLES.filter((aisle) => body.includes(`data-testid="aisle-${aisle}"`));
  if (present.join(",") !== expected.join(",")) return `aisles present: ${present.join(", ")}`;
  const positions = present.map((aisle) => body.indexOf(`data-testid="aisle-${aisle}"`));
  return positions.every((at, i) => i === 0 || at > positions[i - 1]) ? null : "aisles out of enum order";
}

// A product counted twice would render two item rows with one id.
function duplicateItemProblem(body) {
  const ids = itemIds(body);
  if (ids.length === 0) return "no items on the list";
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  return dupes.length ? `listed more than once: ${[...new Set(dupes)].join(", ")}` : null;
}

function jsonCheckProblem(actual, expected) {
  let parsed;
  try {
    parsed = JSON.parse(actual.body);
  } catch {
    return `not JSON: ${actual.body.slice(0, 80)}`;
  }
  return parsed.ok === true && parsed.checked === expected ? null : `got ${actual.body}`;
}

const anon = makeClient();

function targetsPageBody(mine, partner) {
  return new RegExp(
    `${testIdBody("targets-mine", mine).source}[\\s\\S]*${testIdBody("targets-partner", partner).source}`,
  );
}

// Captured mid-run and read inside later steps' closures. The `steps` array literal is evaluated at
// module load, so anything depending on these must be read at call time, not at literal time --
// which is exactly what the thunk form of the third tuple element is for.
let inviteCode = "";
let householdLineA = "";
let libraryLineA = "";

// The linked household line is A's captured line with the member count bumped.
function linkedHouseholdBody() {
  const linked = escapeRe(householdLineA.replace("· 1 member", "· 2 members"));
  return new RegExp(
    `data-testid="household"[^>]*>\\s*${linked}\\s*</p>` +
      `[\\s\\S]*data-testid="library"[^>]*>\\s*${escapeRe(libraryLineA)}\\s*</p>`,
  );
}

// F-03 install criteria (Chromium): name, start_url, a standalone display and 192/512 "any" icons;
// plus the maskable icon Android needs to avoid a white-square launcher icon. Returns an error string
// or null, for the runner's `check` hook.
function manifestProblem(body) {
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    return "manifest is not JSON";
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const has = (sizes, purpose) =>
    icons.some((i) => i.sizes === sizes && (i.purpose ?? "any").split(" ").includes(purpose));
  if (manifest.name !== "Duo Kitchen") return `name is ${JSON.stringify(manifest.name)}`;
  if (manifest.start_url !== "/dashboard") return `start_url is ${JSON.stringify(manifest.start_url)}`;
  if (manifest.display !== "standalone") return `display is ${JSON.stringify(manifest.display)}`;
  if (!has("192x192", "any") || !has("512x512", "any")) return "missing a 192x192 or 512x512 any icon";
  if (!has("512x512", "maskable")) return "missing a 512x512 maskable icon";
  return null;
}

// Icon paths are pinned here rather than read from the manifest, so a manifest that drops one fails above.
const iconPaths = [
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

function pngCheck(actual) {
  return actual.contentType.startsWith("image/png") ? null : `content-type is ${actual.contentType}`;
}

const steps = [
  ["home renders", () => a.request("/"), { status: 200 }],
  // --- F-03: installability, all anonymous and served by the asset layer ---------------------
  [
    "home links the manifest and the touch icon",
    () => a.request("/"),
    {
      status: 200,
      body: /<link rel="manifest" href="\/manifest\.webmanifest"[\s\S]*<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/,
    },
  ],
  [
    "manifest meets the install criteria",
    () => a.request("/manifest.webmanifest"),
    { status: 200, check: (actual) => manifestProblem(actual.body) },
  ],
  ...iconPaths.map((path) => [
    `icon ${path} is served as PNG`,
    () => a.request(path),
    { status: 200, check: pngCheck },
  ]),
  ["dashboard redirects anonymous user", () => a.request("/dashboard"), { status: 302, location: "/auth/signin" }],
  ["targets page redirects anonymous user", () => b.request("/targets"), { status: 302, location: /^\/auth\/signin$/ }],
  [
    "targets API redirects anonymous user",
    () => b.request("/api/targets", { method: "POST", form: targetsB }),
    { status: 302, location: /^\/auth\/signin$/ },
  ],
  // --- S-05: the recipe library is for signed-in users only --------------------------------
  ["recipes page redirects anonymous user", () => b.request("/recipes"), { status: 302, location: /^\/auth\/signin$/ }],
  [
    "recipe detail redirects anonymous user",
    () => b.request(`/recipes/${curryId}`),
    { status: 302, location: /^\/auth\/signin$/ },
  ],

  [
    "signup creates account",
    () => a.request("/api/auth/signup", { method: "POST", form: { email: emailA, password } }),
    { status: 302, location: "/auth/confirm-email" },
  ],
  [
    "signin rejects wrong password",
    () => a.request("/api/auth/signin", { method: "POST", form: { email: emailA, password: "wrong" } }),
    { status: 302, location: "/auth/signin?error=" },
  ],
  [
    // Also the regression guard on signin's new /join branch: A never visits /join, so A's jar never
    // holds dk_invite and this must stay "/".
    "signin accepts correct password",
    () => a.request("/api/auth/signin", { method: "POST", form: { email: emailA, password } }),
    { status: 302, location: /^\/$/ },
  ],
  [
    "dashboard renders for signed-in user with seeded library",
    () => a.request("/dashboard"),
    { status: 200, body: /data-testid="library"[^>]*>\s*Library: [1-9]\d* recipes/ },
  ],

  // --- S-02: A sets targets; invalid input is rejected without touching the stored row ---------
  [
    "A dashboard shows targets not set",
    () => a.request("/dashboard"),
    { status: 200, body: testIdBody("targets", "Targets: not set") },
  ],
  [
    "A saves targets",
    () => a.request("/api/targets", { method: "POST", form: targetsA }),
    { status: 302, location: /^\/targets\?saved=1$/ },
  ],
  [
    "A targets page shows A's targets and no partner yet",
    () => a.request("/targets"),
    { status: 200, body: targetsPageBody(targetsLabelA, "Not linked yet") },
  ],
  [
    // The empty-string pitfall: Number("") is 0, a valid fat value, so only the digits-only regex
    // stands between a blank field and a silent save.
    "a blank fat field is rejected",
    () => a.request("/api/targets", { method: "POST", form: { ...targetsA, fat_g: "" } }),
    { status: 302, location: "/targets?error=" },
  ],
  [
    "zero calories are rejected",
    () => a.request("/api/targets", { method: "POST", form: { ...targetsA, kcal: "0" } }),
    { status: 302, location: "/targets?error=" },
  ],
  [
    "rejected saves left A's targets unchanged",
    () => a.request("/targets"),
    { status: 200, body: testIdBody("targets-mine", targetsLabelA) },
  ],
  [
    "A dashboard shows A's targets",
    () => a.request("/dashboard"),
    { status: 200, body: testIdBody("targets", `Targets: ${targetsLabelA}`) },
  ],

  // --- S-03: A plans; rejected saves map to their own messages --------------------------------
  ["plan page redirects anonymous user", () => b.request("/plan"), { status: 302, location: /^\/auth\/signin$/ }],
  [
    "plan API redirects anonymous user",
    () => b.request("/api/plan", { method: "POST", form: { start_date: planStart } }),
    { status: 302, location: /^\/auth\/signin$/ },
  ],
  [
    "A plan page lists seed recipes and no plan yet",
    () => a.request("/plan"),
    {
      status: 200,
      body: new RegExp(
        `^(?=[\\s\\S]*value="${seedRecipe1}")[\\s\\S]*${testIdBody("plan-summary", "Plan: none yet").source}`,
      ),
    },
  ],
  [
    "A saves a plan with 2 filled slots",
    () =>
      a.request("/api/plan", {
        method: "POST",
        form: { start_date: planStart, d0_breakfast_recipe: seedRecipe1, d1_lunch_recipe: seedRecipe2 },
      }),
    { status: 302, location: planSaved },
  ],
  [
    // RFC-valid, so zod passes it through and the RPC's KD011 is what rejects it.
    "an unknown recipe is rejected with its own message",
    () =>
      a.request("/api/plan", {
        method: "POST",
        form: { start_date: planStart, d0_breakfast_recipe: "00000000-0000-4000-8000-0000000000ff" },
      }),
    { status: 302, location: planError("One of the chosen recipes no longer exists.") },
  ],
  [
    "a meal for the partner is rejected while unlinked",
    () =>
      a.request("/api/plan", {
        method: "POST",
        form: { start_date: planStart, d0_breakfast_recipe: seedRecipe1, d0_breakfast_eater: "partner" },
      }),
    { status: 302, location: planError("You can mark meals for your partner once you're linked.") },
  ],
  [
    "A dashboard shows the plan with 2 meals",
    () => a.request("/dashboard"),
    { status: 200, body: testIdBody("plan", `Plan: from ${planStart} · 2 of 15 meals`) },
  ],

  // --- S-01: A invites, B redeems, both then read one household -----------------------------
  [
    "A dashboard captures the household and library lines",
    async () => {
      const res = await a.request("/dashboard");
      householdLineA = testIdText(res.body, "household");
      libraryLineA = testIdText(res.body, "library");
      return res;
    },
    { status: 200, body: /data-testid="household"[^>]*>\s*Household: [0-9a-f]{8} · 1 member\s*</ },
  ],
  [
    "A generates an invite code",
    () => a.request("/api/household/invite", { method: "POST" }),
    { status: 302, location: /^\/dashboard$/ },
  ],
  [
    "A dashboard shows a 16-hex invite code",
    async () => {
      const res = await a.request("/dashboard");
      const match = /Invite code: ([0-9a-f]{16})/.exec(testIdText(res.body, "invite"));
      inviteCode = match ? match[1] : "";
      return res;
    },
    { status: 200, body: /data-testid="invite"[^>]*>\s*Invite code: [0-9a-f]{16}\s*</ },
  ],
  [
    // B must visit /join BEFORE signing in, so the dk_invite cookie exists when sign-in runs and the
    // new redirect branch is genuinely exercised. The negative lookahead asserts no confirm form.
    "B opens the invite link while signed out: invited, with auth links and no confirm form",
    () => b.request(`/join?code=${inviteCode}`),
    {
      status: 200,
      body: /^(?![\s\S]*action="\/api\/household\/redeem")[\s\S]*data-testid="join"[^>]*>\s*You've been invited to share a household\.\s*<\/p>[\s\S]*href="\/auth\/signin"/,
    },
  ],
  [
    "B signs up",
    () => b.request("/api/auth/signup", { method: "POST", form: { email: emailB, password } }),
    { status: 302, location: "/auth/confirm-email" },
  ],
  [
    // The slice's one novel auth mechanism: the pending-invite cookie diverts sign-in to /join.
    "B signin with a pending invite lands on /join",
    () => b.request("/api/auth/signin", { method: "POST", form: { email: emailB, password } }),
    { status: 302, location: /^\/join$/ },
  ],
  [
    // No query string, so the confirm form proves both the cookie round-trip and the fallback read.
    "B /join renders the confirm form from the dk_invite cookie alone",
    () => b.request("/join"),
    () => ({ status: 200, body: new RegExp(`name="code" value="${inviteCode}"`) }),
  ],
  [
    // F-04: B is NOT linked with A yet and lives in its own household, yet reads the same library.
    "B dashboard shows the same public library before linking",
    () => b.request("/dashboard"),
    () => ({ status: 200, body: testIdBody("library", libraryLineA) }),
  ],
  [
    // Saved in B's own household BEFORE redeeming: the composite membership FK must carry the row along.
    "B saves targets before redeeming",
    () => b.request("/api/targets", { method: "POST", form: targetsB }),
    { status: 302, location: /^\/targets\?saved=1$/ },
  ],
  [
    "B redeems the invite",
    () => b.request("/api/household/redeem", { method: "POST", form: { code: inviteCode } }),
    { status: 302, location: /^\/dashboard\?joined=1$/ },
  ],
  [
    // The cookie is gone from B's jar, so /join has no code left to render.
    "B's dk_invite cookie was cleared by redeeming",
    () => b.request("/join"),
    { status: 200, body: /data-testid="join"[^>]*>\s*This invite link is incomplete\.\s*</ },
  ],
  [
    // FR-003: B now reads A's household and A's library.
    "B dashboard shows A's household with 2 members and A's library",
    () => b.request("/dashboard"),
    () => ({ status: 200, body: linkedHouseholdBody() }),
  ],
  [
    // The unchanged library line shows that redemption leaves the shared library untouched.
    "A dashboard shows 2 members and an unchanged library",
    () => a.request("/dashboard"),
    () => ({ status: 200, body: linkedHouseholdBody() }),
  ],
  [
    "A is linked, so no invite form is offered",
    () => a.request("/dashboard"),
    {
      status: 200,
      // The negative lookahead is the half that matches the step's name: the label alone would still
      // pass if the form were rendered anyway.
      body: /^(?![\s\S]*action="\/api\/household\/invite")[\s\S]*data-testid="invite"[^>]*>\s*Linked with your partner\.\s*</,
    },
  ],
  [
    "A targets page shows B's pre-redemption targets as the partner's",
    () => a.request("/targets"),
    { status: 200, body: targetsPageBody(targetsLabelA, targetsLabelB) },
  ],
  [
    "B targets page shows B's own targets and A's as the partner's",
    () => b.request("/targets"),
    { status: 200, body: targetsPageBody(targetsLabelB, targetsLabelA) },
  ],

  // --- S-03: the plan is shared; "partner" resolves from both sides ----------------------------
  [
    "B dashboard shows A's plan",
    () => b.request("/dashboard"),
    { status: 200, body: testIdBody("plan", `Plan: from ${planStart} · 2 of 15 meals`) },
  ],
  [
    "B plan page shows A's saved recipe selected",
    () => b.request("/plan"),
    { status: 200, body: new RegExp(`<option[^>]*value="${seedRecipe1}"[^>]*selected`) },
  ],
  [
    "B saves 3 slots, one for the partner",
    () =>
      b.request("/api/plan", {
        method: "POST",
        form: {
          start_date: planStart,
          d0_breakfast_recipe: seedRecipe1,
          d1_lunch_recipe: seedRecipe2,
          d2_dinner_recipe: seedRecipe3,
          d2_dinner_eater: "partner",
        },
      }),
    { status: 302, location: planSaved },
  ],
  [
    "A dashboard shows 3 meals",
    () => a.request("/dashboard"),
    { status: 200, body: testIdBody("plan", `Plan: from ${planStart} · 3 of 15 meals`) },
  ],
  [
    // B's "partner" is A, so A sees that meal as "me".
    "A plan page shows B's partner meal as A's own",
    () => a.request("/plan"),
    { status: 200, body: /name="d2_dinner_eater"[^>]*>(?:(?!<\/select>)[\s\S])*<option value="me" selected/ },
  ],
  [
    "the used code cannot be redeemed again",
    () => b.request("/api/household/redeem", { method: "POST", form: { code: inviteCode } }),
    { status: 302, location: `/join?error=${encodeURIComponent("That invite code has already been used.")}` },
  ],
  [
    "a non-hex code is rejected by validation, not by the database",
    () => b.request("/api/household/redeem", { method: "POST", form: { code: "zzzz" } }),
    { status: 302, location: `/join?error=${encodeURIComponent("That invite code is not valid.")}` },
  ],

  // --- S-05: A browses the library and opens recipe details --------------------------------
  [
    // At least the 8 seed recipes: >= rather than an exact count, so user-added rows (S-07) still pass.
    "A recipes page lists the library as cards",
    () => a.request("/recipes"),
    {
      status: 200,
      body: new RegExp(`^(?=(?:[\\s\\S]*?data-testid="recipe-card"){8})[\\s\\S]*href="/recipes/${curryId}"`),
    },
  ],
  [
    "A curry detail shows divisible components and its meal types",
    () => a.request(`/recipes/${curryId}`),
    {
      status: 200,
      body: new RegExp(
        `${testIdBody("recipe-name", "Kurczak curry z ryżem").source}[\\s\\S]*` +
          `${testIdBody("recipe-meal-types", "Lunch · Dinner").source}[\\s\\S]*` +
          testIdBody("recipe-division", "Divisible components").source,
      ),
    },
  ],
  [
    "A curry detail shows the whole-batch total and cooked weights from the SQL oracle",
    () => a.request(`/recipes/${curryId}`),
    {
      status: 200,
      body: new RegExp(
        `${testIdBody("recipe-total", curryTotal).source}[\\s\\S]*` +
          `${testIdBody("component-cooked", curryRiceCooked).source}[\\s\\S]*` +
          testIdBody("component-cooked", curryChickenCooked).source,
      ),
    },
  ],
  [
    // The split itself: a make-ahead step under its heading, and the fresh step only after the
    // fresh heading (the tempered prefix forbids it anywhere before).
    "A curry detail splits make-ahead and fresh steps",
    () => a.request(`/recipes/${curryId}`),
    {
      status: 200,
      body: /^(?:(?!Odważ porcje)[\s\S])*data-testid="steps-make-ahead"(?:(?!Odważ porcje)[\s\S])*Ugotuj ryż w osolonej wodzie(?:(?!Odważ porcje)[\s\S])*data-testid="steps-fresh"[\s\S]*Odważ porcje każdego składnika, odgrzej i podaj\./,
    },
  ],
  [
    "A leczo detail is a whole dish",
    () => a.request(`/recipes/${leczoId}`),
    { status: 200, body: testIdBody("recipe-division", "Whole dish only") },
  ],
  [
    "A zapiekanka detail has no suggested meal type",
    () => a.request(`/recipes/${zapiekankaId}`),
    { status: 200, body: testIdBody("recipe-meal-types", "No suggested meal type") },
  ],
  [
    "a malformed recipe id is 404, not a database error",
    () => a.request("/recipes/not-a-uuid"),
    { status: 404, body: testIdBody("recipe-not-found", "Recipe not found") },
  ],
  [
    "an absent recipe id is 404",
    () => a.request("/recipes/00000000-0000-4000-8000-000000000000"),
    { status: 404, body: testIdBody("recipe-not-found", "Recipe not found") },
  ],

  // --- S-04: solving a day's macros ----------------------------------------------------------
  [
    "solve API redirects anonymous user",
    () => anon.request("/api/plan/solve", { method: "POST", form: { start_date: solveStart, day_index: "0" } }),
    { status: 302, location: /^\/auth\/signin$/ },
  ],
  [
    "day page redirects anonymous user",
    () => anon.request(solveDayPath(0)),
    { status: 302, location: /^\/auth\/signin$/ },
  ],
  [
    "A saves a 3-day plan to solve",
    () => a.request("/api/plan", { method: "POST", form: solveForm() }),
    { status: 302, location: new RegExp(`^${escapeRe(`/plan?start=${solveStart}&saved=1`)}$`) },
  ],
  [
    // FR-018: only a full day prompts; the 4-meal day is just "Not solved".
    "A plan page prompts the two full days only",
    () => a.request(`/plan?start=${solveStart}`),
    {
      status: 200,
      body: new RegExp(
        `^(?![\\s\\S]*data-testid="day-prompt-2")(?=[\\s\\S]*data-testid="day-prompt-0")(?=[\\s\\S]*data-testid="day-prompt-1")` +
          `[\\s\\S]*${testIdBody("day-status-2", "Not solved").source}`,
      ),
    },
  ],
  [
    "A solves the fitting day within ±10%",
    async () => {
      const res = await solveThenOpen(a, 0);
      s04LinesA = personLines(res.body);
      return res;
    },
    { status: 200, body: testIdBody("day-solve-summary", "Solved within ±10%") },
  ],
  [
    "solving the same day again gives identical numbers",
    () => solveThenOpen(a, 0),
    () => ({
      status: 200,
      body: new RegExp(
        `data-person="you"[^>]*>\\s*You · ${escapeRe(s04LinesA.you ?? "missing")}\\s*</p>[\\s\\S]*` +
          `data-person="partner"[^>]*>\\s*Partner · ${escapeRe(s04LinesA.partner ?? "missing")}\\s*</p>`,
      ),
    }),
  ],
  [
    // B reads A's stored result: A's own line is B's partner line, and the other way round.
    "B sees the same numbers from the other side",
    () => b.request(solveDayPath(0)),
    () => ({
      status: 200,
      body: new RegExp(
        `data-person="you"[^>]*>\\s*You · ${escapeRe(s04LinesA.partner ?? "missing")}\\s*</p>[\\s\\S]*` +
          `data-person="partner"[^>]*>\\s*Partner · ${escapeRe(s04LinesA.you ?? "missing")}\\s*</p>`,
      ),
    }),
  ],
  [
    // A prefix: the reason in brackets is unit-tested.
    "A solves the all-whole-dish day: no fit, Leczo named",
    () => solveThenOpen(a, 1),
    {
      status: 200,
      body: /data-testid="day-solve-summary"[^>]*>\s*No fit within ±20% · Most obstructive recipe: Leczo z kiełbasą/,
    },
  ],
  [
    "A solves the 4-meal day: it needs a looser tier",
    async () => {
      const res = await solveThenOpen(a, 2);
      s04Tier =
        /Best fit needs ±(15|20)% — accept to use it/.exec(testIdText(res.body, "day-solve-summary"))?.[1] ?? "";
      s04Fingerprint = /name="fingerprint" value="([0-9a-f]{64})"/.exec(res.body)?.[1] ?? "";
      return res;
    },
    { status: 200, body: /data-testid="day-solve-summary"[^>]*>\s*Best fit needs ±(15|20)% — accept to use it\s*</ },
  ],
  [
    "A accepts that tier for the result it saw",
    () => solveThenOpen(a, 2, { accept_tolerance: s04Tier, fingerprint: s04Fingerprint }),
    () => ({ status: 200, body: testIdBody("day-solve-summary", `Solved within ±${s04Tier}%`) }),
  ],
  [
    "A plan page shows the accepted day as solved",
    () => a.request(`/plan?start=${solveStart}`),
    () => ({ status: 200, body: testIdBody("day-status-2", `Solved within ±${s04Tier}%`) }),
  ],
  [
    // An eater-only edit keeps the meal id; only the fingerprint can notice it.
    "B marks day 1's second breakfast for A only",
    () => b.request("/api/plan", { method: "POST", form: solveForm({ d0_second_breakfast_eater: "partner" }) }),
    { status: 302, location: new RegExp(`^${escapeRe(`/plan?start=${solveStart}&saved=1`)}$`) },
  ],
  [
    "A day page marks the edited day out of date",
    () => a.request(solveDayPath(0)),
    { status: 200, body: /data-testid="day-solve-stale"/ },
  ],
  [
    "A plan page shows the edited day out of date",
    () => a.request(`/plan?start=${solveStart}`),
    { status: 200, body: testIdBody("day-status-0", "Out of date") },
  ],
  [
    "an unknown day index is 404",
    () => a.request(`/plan/day?start=${solveStart}&day=7`),
    { status: 404, body: testIdBody("day-not-found", "Day not found") },
  ],

  // --- S-08: one batch shared across two days ----------------------------------------------------
  [
    // Also exercises the "whole day for" shortcut, which no other step does: day1_eater overrides
    // d1_breakfast_eater, so Tuesday's breakfast is stored for both.
    "A saves two days sharing one lunch batch",
    () =>
      a.request("/api/plan", {
        method: "POST",
        form: shareForm({ day1_eater: "both", d1_breakfast_eater: "me" }),
      }),
    { status: 302, location: shareSaved },
  ],
  [
    "A plan page renders the share in star form, with its batch notes and the day override applied",
    () => a.request(`/plan?start=${shareStart}`),
    {
      status: 200,
      body: new RegExp(
        `^(?=[\\s\\S]*name="d1_lunch_batch"[^>]*>(?:(?!</select>)[\\s\\S])*<option value="0_lunch" selected)` +
          `(?![\\s\\S]*name="d0_lunch_batch"[^>]*>(?:(?!</select>)[\\s\\S])*selected)` +
          `(?=[\\s\\S]*name="d1_breakfast_eater"[^>]*>(?:(?!</select>)[\\s\\S])*<option value="both" selected)` +
          `(?=[\\s\\S]*${testIdBody("batch-0_lunch", S08_COOK_NOTE).source})` +
          `[\\s\\S]*${testIdBody("batch-1_lunch", S08_FROM_NOTE).source}`,
      ),
    },
  ],
  [
    // FR-018 once per group: on its lowest day, as a group sentence.
    "A plan page prompts the group once, on its lowest day",
    () => a.request(`/plan?start=${shareStart}`),
    {
      status: 200,
      body: new RegExp(
        `^(?![\\s\\S]*data-testid="day-prompt-1")(?=[\\s\\S]*data-testid="day-group-1")` +
          `[\\s\\S]*${testIdBody("day-prompt-0", S08_GROUP_PROMPT).source}`,
      ),
    },
  ],
  [
    "A drops Monday's dinner: a mixed group",
    () => a.request("/api/plan", { method: "POST", form: shareForm({ d0_dinner_recipe: undefined }) }),
    { status: 302, location: shareSaved },
  ],
  [
    // The 4-meal lead day still prompts because Tuesday is full -- and the sentence must not claim
    // Monday "has all 5 meals", which the singleton formatSolvePrompt() would.
    "the mixed group still prompts on its lowest day, as a group",
    () => a.request(`/plan?start=${shareStart}`),
    {
      status: 200,
      body: new RegExp(
        `^(?![\\s\\S]*data-testid="day-prompt-1")(?![\\s\\S]*has all 5 meals)` +
          `[\\s\\S]*${testIdBody("day-prompt-0", S08_GROUP_PROMPT).source}`,
      ),
    },
  ],
  [
    "A restores Monday's dinner",
    () => a.request("/api/plan", { method: "POST", form: shareForm() }),
    { status: 302, location: shareSaved },
  ],
  [
    // The slice's claim: one coupled solve lands BOTH days in tolerance. The exact tier is a property
    // of the LP (F5's unit test pins it to 10 or 15), so a looser tier is accepted for the result seen.
    "A solves Monday: the group is solved, accepting a looser tier if needed",
    async () => {
      const res = await a.request("/api/plan/solve", {
        method: "POST",
        form: { start_date: shareStart, day_index: "0" },
      });
      const page = res.location ? await a.request(res.location) : res;
      const tier = /Best fit needs ±(15|20)% — accept to use it/.exec(testIdText(page.body, "day-solve-summary"));
      const fingerprint = /name="fingerprint" value="([0-9a-f]{64})"/.exec(page.body)?.[1];
      if (tier && fingerprint) {
        const accepted = await a.request("/api/plan/solve", {
          method: "POST",
          form: { start_date: shareStart, day_index: "0", accept_tolerance: tier[1], fingerprint },
        });
        return accepted.location ? a.request(accepted.location) : accepted;
      }
      return page;
    },
    { status: 200, body: /data-testid="day-solve-summary"[^>]*>\s*Solved within ±(10|15|20)%\s*</ },
  ],
  [
    "A plan page shows both days of the group with one identical status",
    () => a.request(`/plan?start=${shareStart}`),
    { status: 200, check: (actual) => groupStatusProblem(actual.body, /^Solved within ±(10|15|20)%$/) },
  ],
  [
    // S-09 depends on this exact state (the group solved and still shared), so keep this step here if
    // the S-08 sequence is edited. A shared batch carries the full batch on both days and must be
    // counted once. Structure only: the solved quantities are not pinned from SQL (npm test pins them).
    "A shopping list of the solved shared plan is exact for both days and lists each product once",
    () => a.request(`/plan/shopping?start=${shareStart}`),
    {
      status: 200,
      body: new RegExp(
        `^(?![\\s\\S]*data-testid="shopping-estimate")[\\s\\S]*` +
          testIdBody("shopping-exact", "Exact amounts from the day solve of Monday and Tuesday.").source,
      ),
      check: (actual) => duplicateItemProblem(actual.body),
    },
  ],
  [
    // One batch, not two: its ingredient amounts appear on the cook day only.
    "Monday's day page cooks the whole batch and lists its amounts",
    () => a.request(shareDayPath(0)),
    {
      status: 200,
      body: testIdBody("day-batch-lunch", S08_COOK_NOTE),
      check: (actual) => (/<li[\s>]/.test(lunchSection(actual.body)) ? null : "no batch ingredient list on Monday"),
    },
  ],
  [
    "Tuesday's day page eats from Monday's batch, with no batch amounts",
    () => a.request(shareDayPath(1)),
    {
      status: 200,
      body: testIdBody("day-batch-lunch", S08_FROM_NOTE),
      check: (actual) => {
        const lunch = lunchSection(actual.body);
        if (lunch === "") return "no lunch section on Tuesday";
        return /<li[\s>]/.test(lunch) ? "Tuesday repeats the batch ingredient list" : null;
      },
    },
  ],
  [
    // An eater-only edit on ONE day keeps every meal id; the group fingerprint must still notice it.
    "B marks Tuesday's lunch for A only",
    () => b.request("/api/plan", { method: "POST", form: shareForm({ d1_lunch_eater: "partner" }) }),
    { status: 302, location: shareSaved },
  ],
  [
    "both days of the group are out of date",
    () => a.request(`/plan?start=${shareStart}`),
    { status: 200, check: (actual) => groupStatusProblem(actual.body, /^Out of date$/) },
  ],
  [
    // S-09 depends on this exact state (the group stale, before the un-share), so keep this step here
    // if the S-08 sequence is edited. A stale group falls back to recipe base amounts.
    "A shopping list of the stale shared plan falls back to estimates for both days",
    () => a.request(`/plan/shopping?start=${shareStart}`),
    {
      status: 200,
      body: new RegExp(
        `^(?![\\s\\S]*data-testid="shopping-exact")[\\s\\S]*` +
          testIdBody(
            "shopping-estimate",
            "Monday and Tuesday: recipe base amounts (estimate) — solve to get exact amounts.",
          ).source,
      ),
      check: (actual) => duplicateItemProblem(actual.body),
    },
  ],
  [
    "A un-shares Tuesday's lunch",
    () => a.request("/api/plan", { method: "POST", form: shareForm({ d1_lunch_batch: "" }) }),
    { status: 302, location: shareSaved },
  ],
  [
    "the batch notes are gone and both days are out of date",
    () => a.request(`/plan?start=${shareStart}`),
    {
      status: 200,
      body: /^(?![\s\S]*data-testid="batch-[01]_lunch")(?![\s\S]*data-testid="day-group-)/,
      check: (actual) => groupStatusProblem(actual.body, /^Out of date$/),
    },
  ],
  [
    "A re-shares Tuesday's lunch",
    () => a.request("/api/plan", { method: "POST", form: shareForm() }),
    { status: 302, location: shareSaved },
  ],
  [
    // The grid posts Tuesday's star-form share unchanged, so swapping the batch's lead slot must save
    // with a fresh batch for Tuesday and a soft notice, not reject the whole grid. KD017 itself stays
    // pinned by npm run test:rls.
    "A swaps Monday's lunch, the batch's lead slot: Tuesday's share is dropped, not rejected",
    () => a.request("/api/plan", { method: "POST", form: shareForm({ d0_lunch_recipe: seedRecipe6 }) }),
    {
      status: 302,
      location: new RegExp(
        `^${escapeRe(`/plan?start=${shareStart}&saved=1&notice=${encodeURIComponent(S08_UNSHARED_NOTICE)}`)}$`,
      ),
    },
  ],
  [
    "the dropped share has no batch note",
    () => a.request(`/plan?start=${shareStart}`),
    { status: 200, body: /^(?![\s\S]*data-testid="batch-[01]_lunch")/ },
  ],

  // --- S-09: the shopping list of a plan, checked off by either partner -----------------------
  [
    "shopping page redirects anonymous user",
    () => anon.request(shopPath),
    { status: 302, location: /^\/auth\/signin$/ },
  ],
  [
    "shopping API redirects anonymous user",
    () => anon.request("/api/plan/shopping", { method: "POST", form: shopCheck(chivesId, true) }),
    { status: 302, location: /^\/auth\/signin$/ },
  ],
  [
    "A saves an unsolved plan of two recipes sharing products",
    () =>
      a.request("/api/plan", {
        method: "POST",
        form: { start_date: shopStart, d0_breakfast_recipe: seedRecipe1, d0_second_breakfast_recipe: seedRecipe7 },
      }),
    { status: 302, location: new RegExp(`^${escapeRe(`/plan?start=${shopStart}&saved=1`)}$`) },
  ],
  [
    "A shopping list shows the SQL-pinned item count, the estimate note and Monday not solved",
    () => a.request(shopPath),
    {
      status: 200,
      body: new RegExp(
        `^(?![\\s\\S]*data-testid="shopping-exact")` +
          `(?=[\\s\\S]*${testIdBody("shopping-summary", `Shopping list: ${S09_ITEM_COUNT} items · 0 checked`).source})` +
          `[\\s\\S]*${testIdBody("shopping-estimate", "Monday: recipe base amounts (estimate) — solve to get exact amounts.").source}`,
      ),
      check: (actual) => {
        const day = testIdItem(actual.body, "shopping-day-0");
        if (day !== "Monday · Not solved") return `shopping-day-0 reads "${day}"`;
        return actual.body.includes('data-testid="shopping-day-1"') ? "an empty day has a status line" : null;
      },
    },
  ],
  [
    "A shopping list sums the shared product and formats pieces, as the SQL oracle says",
    () => a.request(shopPath),
    {
      status: 200,
      check: (actual) => {
        for (const [id, line] of [
          [chivesId, chivesLine],
          [eggId, eggLine],
        ]) {
          const got = testIdItem(actual.body, `item-${id}`).replace(/^[☐☑] /, "");
          if (got !== line) return `item-${id} reads "${got}", expected "${line}"`;
        }
        return duplicateItemProblem(actual.body);
      },
    },
  ],
  [
    "A shopping list shows its aisles in the fixed order, none empty",
    () => a.request(shopPath),
    { status: 200, check: (actual) => aisleOrderProblem(actual.body, S09_AISLES) },
  ],
  [
    "A checks off the shared product and lands back on it",
    () => a.request("/api/plan/shopping", { method: "POST", form: shopCheck(chivesId, true) }),
    { status: 302, location: new RegExp(`^${escapeRe(`${shopPath}#item-${chivesId}`)}$`) },
  ],
  [
    "A sees it checked and counted",
    () => a.request(shopPath),
    {
      status: 200,
      body: testIdBody("shopping-summary", `Shopping list: ${S09_ITEM_COUNT} items · 1 checked`),
      check: (actual) => itemCheckedProblem(actual.body, chivesId, true),
    },
  ],
  [
    "B sees A's check",
    () => b.request(shopPath),
    { status: 200, check: (actual) => itemCheckedProblem(actual.body, chivesId, true) },
  ],
  [
    "B unchecks it",
    () => b.request("/api/plan/shopping", { method: "POST", form: shopCheck(chivesId, false) }),
    { status: 302, location: new RegExp(`^${escapeRe(`${shopPath}#item-${chivesId}`)}$`) },
  ],
  [
    "A sees B's uncheck",
    () => a.request(shopPath),
    {
      status: 200,
      body: testIdBody("shopping-summary", `Shopping list: ${S09_ITEM_COUNT} items · 0 checked`),
      check: (actual) => itemCheckedProblem(actual.body, chivesId, false),
    },
  ],
  [
    // KD019: without it any member could plant check rows for arbitrary products.
    "checking a product the plan does not use is rejected with its own message",
    () => a.request("/api/plan/shopping", { method: "POST", form: shopCheck(oatsId, true) }),
    {
      status: 302,
      location: new RegExp(`^${escapeRe(`${shopPath}&error=${encodeURIComponent(S09_NOT_ON_LIST)}#item-${oatsId}`)}$`),
    },
  ],
  [
    // The island's mode, on a second product so the pinned one keeps its final unchecked state.
    "A checks a second product in JSON mode",
    () =>
      a.request("/api/plan/shopping", {
        method: "POST",
        form: shopCheck(saltId, true),
        headers: { Accept: "application/json" },
      }),
    { status: 200, check: (actual) => jsonCheckProblem(actual, true) },
  ],
  [
    "A sees the JSON-mode check on reload",
    () => a.request(shopPath),
    { status: 200, check: (actual) => itemCheckedProblem(actual.body, saltId, true) },
  ],
  [
    "A unchecks it in JSON mode",
    () =>
      a.request("/api/plan/shopping", {
        method: "POST",
        form: shopCheck(saltId, false),
        headers: { Accept: "application/json" },
      }),
    { status: 200, check: (actual) => jsonCheckProblem(actual, false) },
  ],
  [
    "a malformed shopping date is 404",
    () => a.request("/plan/shopping?start=2031-13-40"),
    { status: 404, body: testIdBody("shopping-not-found", "Plan not found") },
  ],
  [
    "a date with no plan says so",
    () => a.request("/plan/shopping?start=2040-01-01"),
    { status: 200, body: testIdBody("shopping-no-plan", "No plan for that date.") },
  ],

  [
    "signout clears session",
    () => a.request("/api/auth/signout", { method: "POST" }),
    { status: 302, location: /^\/$/ },
  ],
  ["dashboard redirects after signout", () => a.request("/dashboard"), { status: 302, location: "/auth/signin" }],
];

let failed = 0;
for (const [name, run, rawExpected] of steps) {
  const actual = await run();
  // Resolved here, not in the array literal, so an expectation can embed a value captured earlier.
  const expected = typeof rawExpected === "function" ? rawExpected() : rawExpected;
  // `location` as a string is a prefix match, which is what the `?error=` assertions need. As a
  // RegExp it is an exact assertion, which the others need: a bare prefix of "/" matches EVERY
  // redirect, so `location: "/"` would have happily accepted "/join" and the no-pending-invite
  // guard would have been vacuous. Same for "/dashboard", which a "/dashboard?error=..." failure
  // redirect is a prefix of.
  const locationOk =
    expected.location === undefined ||
    (expected.location instanceof RegExp
      ? expected.location.test(actual.location)
      : actual.location.startsWith(expected.location));
  // `check` (F-03) covers what a status/location/body regex cannot: parsed JSON and response headers.
  const problem = expected.check ? expected.check(actual) : null;
  const ok =
    actual.status === expected.status &&
    locationOk &&
    (expected.body === undefined || expected.body.test(actual.body)) &&
    problem === null;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> ${actual.status} ${actual.location}`);
  if (!ok) {
    failed++;
    console.log(`      expected ${expected.status} ${expected.location ?? ""}`);
    if (problem !== null) console.log(`      check failed: ${problem}`);
    if (expected.body !== undefined) {
      console.log(`      expected body ${expected.body}`);
      for (const id of [
        "household",
        "library",
        "invite",
        "join",
        "targets",
        "targets-mine",
        "targets-partner",
        // S-05
        "recipe-count",
        "recipe-name",
        "recipe-division",
        "recipe-meal-types",
        "recipe-total",
        "component-cooked",
        "recipe-not-found",
        "recipe-unavailable",
      ]) {
        if (actual.body.includes(`data-testid="${id}"`)) {
          console.log(`      got ${id}: ${testIdText(actual.body, id)}`);
        }
      }
      // S-03: its own loop, so the shared id list above stays untouched for parallel slices.
      for (const id of S03_TEST_IDS) {
        if (actual.body.includes(`data-testid="${id}"`)) {
          console.log(`      got ${id}: ${testIdText(actual.body, id)}`);
        }
      }
      // S-04: likewise its own loop.
      for (const id of S04_TEST_IDS) {
        if (actual.body.includes(`data-testid="${id}"`)) {
          console.log(`      got ${id}: ${testIdText(actual.body, id)}`);
        }
      }
    }
    // S-08: likewise its own loop, and also for `check`-only steps (which carry no body regex, so the
    // S-04 ids they compare were not printed above).
    if (expected.body !== undefined || problem !== null) {
      const ids = expected.body === undefined ? [...S04_TEST_IDS, ...S08_TEST_IDS] : S08_TEST_IDS;
      for (const id of ids) {
        if (actual.body.includes(`data-testid="${id}"`)) {
          console.log(`      got ${id}: ${testIdText(actual.body, id)}`);
        }
      }
      // S-09: likewise its own loop; the day lines and items are <li>, so they print via testIdItem().
      for (const id of S09_TEST_IDS) {
        if (actual.body.includes(`data-testid="${id}"`)) {
          console.log(`      got ${id}: ${testIdText(actual.body, id)}`);
        }
      }
      for (const id of [0, 1, 2].map((n) => `shopping-day-${n}`)) {
        if (actual.body.includes(`data-testid="${id}"`)) {
          console.log(`      got ${id}: ${testIdItem(actual.body, id)}`);
        }
      }
      for (const productId of itemIds(actual.body)) {
        console.log(`      got item-${productId}: ${testIdItem(actual.body, `item-${productId}`)}`);
      }
    }
  }
}

console.log(failed ? `\n${failed} step(s) failed` : "\nAll smoke steps passed");
process.exit(failed ? 1 : 0);
