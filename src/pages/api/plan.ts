import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { getCurrentHousehold } from "@/lib/services/household";
import {
  MEAL_TYPES,
  PLAN_DAYS,
  PLAN_SAVE_FAILED,
  SHARE_INVALID_SLOT,
  addDays,
  formatUnsharedNotice,
  isIsoDate,
  mealPlanErrorMessage,
  saveMealPlan,
  weekdayLabel,
} from "@/lib/services/meal-plans";
import { MEAL_TYPE_LABELS } from "@/lib/recipe-labels";
import type { MealType, PlanDayIndex, PlanEater, PlanMealInput } from "@/types";

const INVALID_PLAN = "That plan could not be read. Please check the start date and try again.";
const PARTNER_NOT_LINKED = "You can mark meals for your partner once you're linked.";

const eater = z.enum(["both", "me", "partner"]);

// Field names: start_date, day{n}_eater, d{n}_{meal_type}_recipe, d{n}_{meal_type}_eater and
// d{n}_{meal_type}_batch (S-08: "" for a fresh batch, or "<day>_<meal_type>" of the slot it shares
// one with). An absent slot eater defaults to "both"; an empty recipe means an empty slot (FR-015).
// Explicit enums and no coercion, so a blank or junk value is rejected rather than silently mapped.
const slotRef = z.string().regex(new RegExp(`^[${PLAN_DAYS.join("")}]_(${MEAL_TYPES.join("|")})$`));
const slotFields: Record<string, z.ZodType> = {};
for (const day of PLAN_DAYS) {
  slotFields[`day${day}_eater`] = z.enum(["", "both", "me", "partner"]).default("");
  for (const mealType of MEAL_TYPES) {
    slotFields[`d${day}_${mealType}_recipe`] = z.union([z.literal(""), z.uuid()]).default("");
    slotFields[`d${day}_${mealType}_eater`] = eater.default("both");
    slotFields[`d${day}_${mealType}_batch`] = z.union([z.literal(""), slotRef]).default("");
  }
}
const slotsSchema = z.object(slotFields);
const startDateSchema = z.string().refine(isIsoDate);

function planUrl(startDate: string | null, param: string): string {
  return startDate ? `/plan?start=${startDate}&${param}` : `/plan?${param}`;
}

function errorUrl(startDate: string | null, message: string): string {
  return planUrl(startDate, `error=${encodeURIComponent(message)}`);
}

export const POST: APIRoute = async (context) => {
  // /api/* is not in middleware.ts's PROTECTED_ROUTES, so this route is reachable anonymously.
  const user = context.locals.user;
  if (!user) {
    return context.redirect("/auth/signin");
  }

  // See redeem.ts: a same-origin non-form body makes formData() reject.
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return context.redirect(errorUrl(null, INVALID_PLAN));
  }

  const start = startDateSchema.safeParse(form.get("start_date"));
  const startDate = start.success ? start.data : null;

  // form.get() returns null for an absent field; zod's .default() applies to undefined only.
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(slotFields)) {
    raw[key] = form.get(key) ?? undefined;
  }
  const slots = slotsSchema.safeParse(raw);
  if (!startDate || !slots.success) {
    return context.redirect(errorUrl(startDate, INVALID_PLAN));
  }
  const fields = slots.data as Record<string, string>;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(errorUrl(startDate, "Supabase is not configured"));
  }

  // A failed read must never pass for "unlinked": that would silently drop partner meals.
  let partnerId: string | null;
  try {
    const household = await getCurrentHousehold(supabase);
    if (!household) {
      throw new Error("no household for the signed-in user");
    }
    partnerId = household.members.find((member) => member.userId !== user.id)?.userId ?? null;
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("getCurrentHousehold failed on /api/plan", error);
    return context.redirect(errorUrl(startDate, PLAN_SAVE_FAILED));
  }

  const meals: PlanMealInput[] = [];
  const unshared: string[] = [];
  for (const day of PLAN_DAYS) {
    // The "whole day for" shortcut overrides every filled meal of that day; it is not stored.
    const dayEater = fields[`day${day}_eater`];
    for (const mealType of MEAL_TYPES) {
      const recipeId = fields[`d${day}_${mealType}_recipe`];
      if (!recipeId) {
        continue;
      }
      const choice = (dayEater || fields[`d${day}_${mealType}_eater`]) as PlanEater;
      let eaterUserId: string | null = null;
      if (choice === "me") {
        eaterUserId = user.id;
      } else if (choice === "partner") {
        if (!partnerId) {
          return context.redirect(errorUrl(startDate, PARTNER_NOT_LINKED));
        }
        eaterUserId = partnerId;
      }
      const batch = fields[`d${day}_${mealType}_batch`];
      let shareWith: PlanMealInput["shareWith"] = null;
      // UX checks ahead of save_meal_plan's KD015-KD017, which remain the guarantee.
      if (batch) {
        const [targetDay, targetType] = [Number(batch.slice(0, 1)) as PlanDayIndex, batch.slice(2) as MealType];
        if (targetDay === day && targetType === mealType) {
          return context.redirect(errorUrl(startDate, SHARE_INVALID_SLOT));
        }
        // A saved batch renders in star form, so changing or clearing its lead slot leaves every other
        // member naming a slot that no longer matches. That is an ordinary edit: cook a fresh batch.
        const targetRecipe = fields[`d${targetDay}_${targetType}_recipe`];
        if (targetRecipe === recipeId) {
          shareWith = { dayIndex: targetDay, mealType: targetType };
        } else {
          unshared.push(`${weekdayLabel(addDays(startDate, day))} ${MEAL_TYPE_LABELS[mealType]}`);
        }
      }
      meals.push({ dayIndex: day, mealType, recipeId, eaterUserId, shareWith });
    }
  }

  try {
    await saveMealPlan(supabase, startDate, meals);
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("saveMealPlan failed", error);
    return context.redirect(errorUrl(startDate, mealPlanErrorMessage(error)));
  }

  const notice = unshared.length > 0 ? `&notice=${encodeURIComponent(formatUnsharedNotice(unshared))}` : "";
  return context.redirect(planUrl(startDate, `saved=1${notice}`));
};
