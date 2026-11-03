import { confirmPage, verifyForm, type createAuth } from "./auth.ts";

/**
 * What a person's browser does with an emailed magic link: open the confirm page, then press its
 * button, which GETs Better Auth's verify endpoint. Returns Better Auth's response.
 */
export function pressSignIn(auth: Pick<ReturnType<typeof createAuth>, "handler">, link: string) {
  const emailed = new URL(link);
  if (emailed.pathname !== confirmPage) throw new Error(`Not a link to the confirm page: ${link}`);
  const verify = new URL(verifyForm.action, emailed.origin);
  verify.search = new URLSearchParams({ token: emailed.searchParams.get("token") ?? "", ...verifyForm.fields }).toString();
  return auth.handler(new Request(verify));
}
