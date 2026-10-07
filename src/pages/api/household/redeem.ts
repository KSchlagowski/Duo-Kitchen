import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { inviteErrorMessage, redeemInvite } from "@/lib/services/invites";
import { clearInviteCookie } from "@/lib/invite-cookie";

// First zod schema in the codebase, and so the convention: parse with safeParse and redirect with
// the established ?error= treatment on failure rather than returning a 400 — there is no
// JSON-response convention here to introduce one into.
const redeemSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{16}$/),
});

export const POST: APIRoute = async (context) => {
  // /api/* is not in middleware.ts's PROTECTED_ROUTES, so this route is reachable anonymously.
  if (!context.locals.user) {
    return context.redirect("/auth/signin");
  }

  const form = await context.request.formData();
  const parsed = redeemSchema.safeParse({ code: form.get("code") });
  if (!parsed.success) {
    return context.redirect(`/join?error=${encodeURIComponent("That invite code is not valid.")}`);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/join?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  try {
    await redeemInvite(supabase, parsed.data.code);
  } catch (error) {
    // The cookie still holds the code, so /join can re-render with the message.
    return context.redirect(`/join?error=${encodeURIComponent(inviteErrorMessage(error))}`);
  }

  clearInviteCookie(context.cookies);
  return context.redirect("/dashboard?joined=1");
};
