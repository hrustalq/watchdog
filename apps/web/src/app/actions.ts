"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { server } from "@/lib/server";

export async function signOut() {
  const requestHeaders = await headers();
  await server().auth.api.signOut({ headers: requestHeaders });
  redirect("/sign-in");
}
