import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import {
  DAY_CHANGED_BEFORE_ACCEPT,
  DAY_SOLVE_ERRORS,
  DAY_SOLVE_FAILED,
  daySolveErrorMessage,
  getDayView,
  saveDaySolution,
  unsolvableMessage,
} from "@/lib/services/day-solutions";
import { solveDay, statusFor } from "@/lib/services/macro-solver";
import { isIsoDate } from "@/lib/services/meal-plans";
import type { DayView, PlanDayIndex, SolveTier } from "@/types";

const INVALID_SOLVE = "That solve request could not be read. Please try again.";

// Explicit enums and no coercion, so a blank or junk value is rejected rather than silently mapped.
// An accept above ±10 % is bound to the fingerprint of the result the user saw (P2).
const solveSchema = z
  .object({
    day_index: z.enum(["0", "1", "2"]),
    accept_tolerance: z.enum(["10", "15", "20"]).default("10"),
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((fields) => fields.accept_tolerance === "10" || fields.fingerprint !== undefined);
const startDateSchema = z.string().refine(isIsoDate);

function planErrorUrl(startDate: string | null, message: string): string {
  const error = `error=${encodeURIComponent(message)}`;
  return startDate ? `/plan?start=${startDate}&${error}` : `/plan?${error}`;
}

function dayUrl(startDate: string, dayIndex: string, param: string): string {
  return `/plan/day?start=${startDate}&day=${dayIndex}&${param}`;
}

function dayErrorUrl(startDate: string, dayIndex: string, message: string): string {
  return dayUrl(startDate, dayIndex, `error=${encodeURIComponent(message)}`);
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
    return context.redirect(planErrorUrl(null, INVALID_SOLVE));
  }

  const start = startDateSchema.safeParse(form.get("start_date"));
  if (!start.success) {
    return context.redirect(planErrorUrl(null, INVALID_SOLVE));
  }
  const startDate = start.data;

  // form.get() returns null for an absent field; zod's .default() applies to undefined only.
  const parsed = solveSchema.safeParse({
    day_index: form.get("day_index") ?? undefined,
    accept_tolerance: form.get("accept_tolerance") ?? undefined,
    fingerprint: form.get("fingerprint") ?? undefined,
  });
  if (!parsed.success) {
    const rawDay = form.get("day_index");
    return context.redirect(
      typeof rawDay === "string" && ["0", "1", "2"].includes(rawDay)
        ? dayErrorUrl(startDate, rawDay, INVALID_SOLVE)
        : planErrorUrl(startDate, INVALID_SOLVE),
    );
  }
  const { day_index: dayParam, fingerprint: postedFingerprint } = parsed.data;
  const dayIndex = Number(dayParam) as PlanDayIndex;
  const accept = Number(parsed.data.accept_tolerance) as SolveTier;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(dayErrorUrl(startDate, dayParam, "Supabase is not configured"));
  }

  let view: DayView | null;
  try {
    view = await getDayView(supabase, startDate, dayIndex);
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("getDayView failed on /api/plan/solve", error);
    return context.redirect(dayErrorUrl(startDate, dayParam, DAY_SOLVE_FAILED));
  }
  if (!view) {
    return context.redirect(planErrorUrl(startDate, DAY_SOLVE_ERRORS.KD014));
  }
  if (view.unsolvable) {
    return context.redirect(dayErrorUrl(startDate, dayParam, unsolvableMessage(view.unsolvable, user.id)));
  }
  // An accept is only valid for the exact inputs the user reviewed: store nothing and show the change.
  if (accept > 10 && postedFingerprint !== view.fingerprint) {
    return context.redirect(dayErrorUrl(startDate, dayParam, DAY_CHANGED_BEFORE_ACCEPT));
  }

  // A plain "Solve again" on unchanged inputs keeps an earlier acceptance.
  const tolerance: SolveTier =
    accept === 10 && view.stored !== null && view.stored.inputFingerprint === view.fingerprint
      ? view.stored.acceptedTolerancePct
      : accept;

  try {
    const result = solveDay(view.input);
    if (result.kind !== "solution") {
      // checkSolvable() above already ruled this out; solveDay runs the same check.
      throw new Error(`solveDay returned unsolvable (${result.reason}) after checkSolvable passed`);
    }
    await saveDaySolution(
      supabase,
      startDate,
      dayIndex,
      statusFor(result.solution, tolerance),
      tolerance,
      view.fingerprint,
      result.solution,
    );
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("solving or saving the day failed on /api/plan/solve", error);
    return context.redirect(dayErrorUrl(startDate, dayParam, daySolveErrorMessage(error)));
  }

  return context.redirect(dayUrl(startDate, dayParam, "solved=1"));
};
