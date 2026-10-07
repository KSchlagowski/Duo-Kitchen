import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { readInviteCookie } from "@/lib/invite-cookie";

export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const email = form.get("email") as string;
  const password = form.get("password") as string;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent("Supabase is not configured")}`);
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent(error.message)}`);
  }

  // A pending invite means this sign-in is part of a join, so finish it rather than dropping the
  // user on the home page. This is what carries the code across the email-confirmation round-trip.
  if (readInviteCookie(context.cookies) !== null) {
    return context.redirect("/join");
  }

  return context.redirect("/");
};
