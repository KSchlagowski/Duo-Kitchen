export interface HouseholdMember {
  userId: string;
  joinedAt: string;
}

export interface Household {
  id: string;
  createdAt: string;
  members: HouseholdMember[];
}

// The inviter's own live invite code (S-01). The redeemed/provenance columns are never surfaced to
// the UI in this slice, so they are deliberately absent.
export interface HouseholdInvite {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

// Language-neutral keys matching the Postgres enums (labels are mapped in the UI).
export type StoreAisle = "produce" | "dairy" | "meat_fish" | "bakery" | "dry_goods" | "spices" | "frozen" | "other";
export type MealType = "breakfast" | "second_breakfast" | "lunch" | "afternoon_snack" | "dinner";
export type DivisionMode = "per_component" | "whole_dish";
export type StepTiming = "make_ahead" | "fresh";

export interface RecipeLibrarySummary {
  recipeCount: number;
  productCount: number;
}
