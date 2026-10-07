import type { AstroCookies } from "astro";

// Carries an invite code across the sign-up -> confirm-email -> sign-in detour, so /join, the redeem
// route and the signin route cannot disagree about the cookie's name or options.
export const INVITE_COOKIE = "dk_invite";

// Matches the invite TTL in create_household_invite() (7 days). sameSite "lax" is required, not
// incidental: the invite link is followed from an email client, i.e. a cross-site top-level GET,
// which "strict" would strip the cookie from.
const INVITE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
} as const;

export function setInviteCookie(cookies: AstroCookies, code: string): void {
  cookies.set(INVITE_COOKIE, code, INVITE_COOKIE_OPTIONS);
}

export function readInviteCookie(cookies: AstroCookies): string | null {
  return cookies.get(INVITE_COOKIE)?.value ?? null;
}

export function clearInviteCookie(cookies: AstroCookies): void {
  cookies.delete(INVITE_COOKIE, { path: INVITE_COOKIE_OPTIONS.path });
}
