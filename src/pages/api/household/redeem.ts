import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { inviteErrorMessage, redeemInvite } from "@/lib/services/invites";
import { clearInviteCookie, INVITE_CODE_PATTERN } from "@/lib/invite-cookie";

// First zod schema in the codebase, and so the convention: parse with safeParse and redirect with
// the established ?error= treatment on failure rather than returning a 400 — there is no
// JSON-response convention here to introduce one into.
const redeemSchema = z.object({
  code: z.string().trim().toLowerCase().regex(INVITE_CODE_PATTERN),
});

const INVALID_CODE = "That invite code is not valid.";

export const POST: APIRoute = async (context) => {
  // /api/* is not in middleware.ts's PROTECTED_ROUTES, so this route is reachable anonymously.
  if (!context.locals.user) {
    return context.redirect("/auth/signin");
  }

  // Astro's origin check only rejects CROSS-origin form-like POSTs, so a same-origin request with a
  // non-form body reaches here and formData() rejects. Catch it, or that is an unhandled 500 instead
  // of this route's own ?error= redirect.
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return context.redirect(`/join?error=${encodeURIComponent(INVALID_CODE)}`);
  }

  const parsed = redeemSchema.safeParse({ code: form.get("code") });
  if (!parsed.success) {
    return context.redirect(`/join?error=${encodeURIComponent(INVALID_CODE)}`);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/join?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  try {
    await redeemInvite(supabase, parsed.data.code);
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("redeemInvite failed", error);
    // The cookie still holds the code, so /join can re-render with the message.
    return context.redirect(`/join?error=${encodeURIComponent(inviteErrorMessage(error))}`);
  }

  clearInviteCookie(context.cookies);
  return context.redirect("/dashboard?joined=1");
};
