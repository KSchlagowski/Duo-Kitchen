import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdInvite } from "@/types";

// RLS scopes `household_invites` to the caller's own household, so no explicit household filter is
// needed. Writes are revoked from `authenticated` entirely: both mutations go through the
// security-definer RPCs in 20261007120200_household_invites.sql.

// Rejection SQLSTATEs raised by the two RPCs, in the migration's own order. Mapped here rather than
// in either API route because both routes need the mapping.
const INVITE_ERRORS: Record<string, string> = {
  KD001: "That invite code is not valid.",
  KD002: "That invite code has expired.",
  KD003: "That invite code has already been used.",
  KD004: "You are already in that household.",
  KD005: "That household already has two members.",
  KD006: "Your kitchen has data that would be left behind. Contact support before joining.",
  KD007: "You need an account to join a household.",
};

const FALLBACK_ERROR = "Something went wrong with that invite. Please try again.";

// PostgREST surfaces the SQLSTATE as the error's `code` field, not inside `message`. The error
// arrives as `unknown`, so narrow it with a guard rather than casting to PostgrestError.
function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const { code } = error;
  return typeof code === "string" ? code : null;
}

export function inviteErrorMessage(error: unknown): string {
  const code = errorCode(error);
  return (code !== null ? INVITE_ERRORS[code] : undefined) ?? FALLBACK_ERROR;
}

export async function getActiveInvite(supabase: SupabaseClient): Promise<HouseholdInvite | null> {
  const { data, error } = await supabase
    .from("household_invites")
    .select("id, code, created_at, expires_at")
    .is("redeemed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }

  return {
    id: data.id as string,
    code: data.code as string,
    createdAt: data.created_at as string,
    expiresAt: data.expires_at as string,
  };
}

// There is no generated `Database` type in this project, so `rpc()` resolves to `any` and
// strictTypeChecked rejects destructuring it. Cast at the service boundary, as household.ts does.
interface RpcResult<T> {
  data: T | null;
  error: PostgrestError | null;
}

// Returns the new 16-hex code, replacing the household's previous unredeemed one.
export async function createInvite(supabase: SupabaseClient): Promise<string> {
  const { data, error } = (await supabase.rpc("create_household_invite")) as RpcResult<string>;

  if (error) {
    throw error;
  }
  if (data === null) {
    throw new Error("create_household_invite returned no code");
  }
  return data;
}

// Returns the id of the household the caller just joined.
export async function redeemInvite(supabase: SupabaseClient, code: string): Promise<string> {
  const { data, error } = (await supabase.rpc("redeem_household_invite", {
    p_code: code,
  })) as RpcResult<string>;

  if (error) {
    throw error;
  }
  if (data === null) {
    throw new Error("redeem_household_invite returned no household id");
  }
  return data;
}
