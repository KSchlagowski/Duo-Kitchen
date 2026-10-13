import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { isIsoDate } from "@/lib/services/meal-plans";
import { setShoppingItemChecked, shoppingErrorMessage } from "@/lib/services/shopping";
import { SHOPPING_ERRORS } from "@/lib/services/shopping-list";

const INVALID_CHECK = SHOPPING_ERRORS.KD018;

// Explicit enum and no coercion: `checked` is the TARGET state, and a blank or junk value is rejected
// rather than silently mapped to false.
const checkSchema = z.object({
  product_id: z.guid(),
  checked: z.enum(["0", "1"]),
});
const startDateSchema = z.string().refine(isIsoDate);

function shoppingUrl(startDate: string | null, productId: string | null, message?: string): string {
  const params = [startDate ? `start=${startDate}` : null, message ? `error=${encodeURIComponent(message)}` : null]
    .filter((param) => param !== null)
    .join("&");
  return `/plan/shopping${params ? `?${params}` : ""}${productId ? `#item-${productId}` : ""}`;
}

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
    return context.redirect(shoppingUrl(null, null, INVALID_CHECK));
  }

  const start = startDateSchema.safeParse(form.get("start_date"));
  if (!start.success) {
    return context.redirect(shoppingUrl(null, null, INVALID_CHECK));
  }
  const startDate = start.data;

  const parsed = checkSchema.safeParse({
    product_id: form.get("product_id") ?? undefined,
    checked: form.get("checked") ?? undefined,
  });
  if (!parsed.success) {
    return context.redirect(shoppingUrl(startDate, null, INVALID_CHECK));
  }
  const { product_id: productId, checked } = parsed.data;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(shoppingUrl(startDate, productId, "Supabase is not configured"));
  }

  try {
    await setShoppingItemChecked(supabase, startDate, productId, checked === "1");
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("set_shopping_item_checked failed on /api/plan/shopping", error);
    return context.redirect(shoppingUrl(startDate, productId, shoppingErrorMessage(error)));
  }

  return context.redirect(shoppingUrl(startDate, productId));
};
