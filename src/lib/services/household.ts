import type { SupabaseClient } from "@supabase/supabase-js";
import type { Household } from "@/types";

// RLS scopes `households` to the caller's own household, so no explicit user filter is needed.
export async function getCurrentHousehold(supabase: SupabaseClient): Promise<Household | null> {
  const { data, error } = await supabase
    .from("households")
    .select("id, created_at, household_members(user_id, joined_at)")
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }

  return {
    id: data.id as string,
    createdAt: data.created_at as string,
    members: (data.household_members as { user_id: string; joined_at: string }[]).map((member) => ({
      userId: member.user_id,
      joinedAt: member.joined_at,
    })),
  };
}
