import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { createInvite, inviteErrorMessage } from "@/lib/services/invites";

export const POST: APIRoute = async (context) => {
  // /api/* is not in middleware.ts's PROTECTED_ROUTES, so this route is reachable anonymously.
  if (!context.locals.user) {
    return context.redirect("/auth/signin");
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/dashboard?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  try {
    await createInvite(supabase);
  } catch (error) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("createInvite failed", error);
    return context.redirect(`/dashboard?error=${encodeURIComponent(inviteErrorMessage(error))}`);
  }

  return context.redirect("/dashboard");
};
