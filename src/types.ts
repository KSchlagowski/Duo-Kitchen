export interface HouseholdMember {
  userId: string;
  joinedAt: string;
}

export interface Household {
  id: string;
  createdAt: string;
  members: HouseholdMember[];
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
