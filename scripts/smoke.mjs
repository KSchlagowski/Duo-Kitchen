// Smoke test: proves the built app, the Cloudflare adapter and the Supabase auth flow still work
// together, that two accounts can be linked into one household (S-01, FR-002/FR-003), and that each
// person's daily macro targets are saved, validated and visible to the partner -- including targets
// set before the redemption, which must arrive in the shared household with their owner (S-02, FR-004).
// S-05: the recipe library renders as cards and a recipe's detail shows macros pinned from SQL.
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

  async function request(path, { method = "GET", form } = {}) {
    const response = await fetch(BASE_URL + path, {
      method,
      redirect: "manual",
      headers: {
        Cookie: cookieHeader(),
        Origin: BASE_URL,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    storeCookies(response);
    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
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

const steps = [
  ["home renders", () => a.request("/"), { status: 200 }],
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
  const ok =
    actual.status === expected.status && locationOk && (expected.body === undefined || expected.body.test(actual.body));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> ${actual.status} ${actual.location}`);
  if (!ok) {
    failed++;
    console.log(`      expected ${expected.status} ${expected.location ?? ""}`);
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
    }
  }
}

console.log(failed ? `\n${failed} step(s) failed` : "\nAll smoke steps passed");
process.exit(failed ? 1 : 0);
