import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { saveMyMacroTargets } from "@/lib/services/macro-targets";

// Digits only BEFORE any number conversion: `Number("")` is 0 and `z.coerce.number()` accepts "",
// so a blank fat or carbs field would otherwise silently save a valid 0. Bounds match the CHECK
// constraints in 20261008120000_macro_targets.sql.
function wholeNumber(min: number, max: number) {
  return z
    .string()
    .trim()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

const targetsSchema = z.object({
  kcal: wholeNumber(1, 9999),
  protein_g: wholeNumber(0, 999),
  fat_g: wholeNumber(0, 999),
  carbs_g: wholeNumber(0, 999),
});

const INVALID_TARGETS = "Enter whole numbers: calories 1–9999, protein, fat and carbs 0–999.";
const SAVE_FAILED = "Your targets could not be saved. Please try again.";

export const POST: APIRoute = async (context) => {
  // /api/* is not in middleware.ts's PROTECTED_ROUTES, so this route is reachable anonymously.
  if (!context.locals.user) {
    return context.redirect("/auth/signin");
  }

  // See redeem.ts: a same-origin non-form body makes formData() reject.
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return context.redirect(`/targets?error=${encodeURIComponent(INVALID_TARGETS)}`);
  }

  const parsed = targetsSchema.safeParse({
    kcal: form.get("kcal"),
    protein_g: form.get("protein_g"),
    fat_g: form.get("fat_g"),
    carbs_g: form.get("carbs_g"),
  });
  if (!parsed.success) {
    return context.redirect(`/targets?error=${encodeURIComponent(INVALID_TARGETS)}`);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/targets?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  try {
    await saveMyMacroTargets(supabase, context.locals.user.id, {
      kcal: parsed.data.kcal,
      proteinG: parsed.data.protein_g,
      fatG: parsed.data.fat_g,
      carbsG: parsed.data.carbs_g,
    });
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("saveMyMacroTargets failed", error);
    return context.redirect(`/targets?error=${encodeURIComponent(SAVE_FAILED)}`);
  }

  return context.redirect("/targets?saved=1");
};
