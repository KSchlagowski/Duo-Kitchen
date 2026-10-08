// Smoke test: proves the built app, the Cloudflare adapter and the Supabase auth flow still work
// together, that two accounts can be linked into one household (S-01, FR-002/FR-003), and that each
// person's daily macro targets are saved, validated and visible to the partner -- including targets
// set before the redemption, which must arrive in the shared household with their owner (S-02, FR-004).
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

function testIdBody(id, text) {
  return new RegExp(`data-testid="${id}"[^>]*>\\s*${escapeRe(text)}\\s*</p>`);
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
      for (const id of ["household", "library", "invite", "join", "targets", "targets-mine", "targets-partner"]) {
        if (actual.body.includes(`data-testid="${id}"`)) {
          console.log(`      got ${id}: ${testIdText(actual.body, id)}`);
        }
      }
    }
  }
}

console.log(failed ? `\n${failed} step(s) failed` : "\nAll smoke steps passed");
process.exit(failed ? 1 : 0);
