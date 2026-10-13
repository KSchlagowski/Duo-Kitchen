import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { errorCode, isIsoDate } from "@/lib/services/meal-plans";
import { setShoppingItemChecked, shoppingErrorMessage } from "@/lib/services/shopping";
import { SHOPPING_ERRORS, SHOPPING_SAVE_FAILED } from "@/lib/services/shopping-list";

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

// The check-off island (ShoppingList.tsx) asks for JSON so it can toggle in place; a plain form post
// (no JavaScript) keeps the redirect contract. Both report the same SHOPPING_ERRORS messages.
function wantsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

function json(status: number, body: { ok: true; checked: boolean } | { ok: false; message: string }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const POST: APIRoute = async (context) => {
  const asJson = wantsJson(context.request);

  // /api/* is not in middleware.ts's PROTECTED_ROUTES, so this route is reachable anonymously.
  if (!context.locals.user) {
    return asJson ? json(401, { ok: false, message: SHOPPING_ERRORS.KD007 }) : context.redirect("/auth/signin");
  }

  // See redeem.ts: a same-origin non-form body makes formData() reject.
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return asJson
      ? json(400, { ok: false, message: INVALID_CHECK })
      : context.redirect(shoppingUrl(null, null, INVALID_CHECK));
  }

  const start = startDateSchema.safeParse(form.get("start_date"));
  if (!start.success) {
    return asJson
      ? json(400, { ok: false, message: INVALID_CHECK })
      : context.redirect(shoppingUrl(null, null, INVALID_CHECK));
  }
  const startDate = start.data;

  const parsed = checkSchema.safeParse({
    product_id: form.get("product_id") ?? undefined,
    checked: form.get("checked") ?? undefined,
  });
  if (!parsed.success) {
    return asJson
      ? json(400, { ok: false, message: INVALID_CHECK })
      : context.redirect(shoppingUrl(startDate, null, INVALID_CHECK));
  }
  const { product_id: productId, checked } = parsed.data;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return asJson
      ? json(500, { ok: false, message: SHOPPING_SAVE_FAILED })
      : context.redirect(shoppingUrl(startDate, productId, "Supabase is not configured"));
  }

  try {
    await setShoppingItemChecked(supabase, startDate, productId, checked === "1");
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("set_shopping_item_checked failed on /api/plan/shopping", error);
    const message = shoppingErrorMessage(error);
    if (asJson) {
      // A KD rejection is the caller's request; anything else is ours.
      const code = errorCode(error);
      return json(code !== null && code in SHOPPING_ERRORS ? 400 : 500, { ok: false, message });
    }
    return context.redirect(shoppingUrl(startDate, productId, message));
  }

  return asJson
    ? json(200, { ok: true, checked: checked === "1" })
    : context.redirect(shoppingUrl(startDate, productId));
};
