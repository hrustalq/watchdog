"use server";

import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { server } from "@/lib/server";

export async function sendMagicLink(formData: FormData) {
  const field = formData.get("email");
  const email = typeof field === "string" ? field.trim() : "";
  const requestHeaders = await headers();
  try {
    await server().auth.api.signInMagicLink({
      body: { email, callbackURL: "/", errorCallbackURL: "/sign-in" },
      headers: requestHeaders,
    });
  } catch (error) {
    // Better Auth rejects an address it can't parse with a 400.
    if (isAPIError(error) && error.statusCode === 400) {
      redirect("/sign-in?error=invalid-email");
    }
    throw error;
  }
  redirect(`/sign-in/check-email?email=${encodeURIComponent(email)}`);
}
