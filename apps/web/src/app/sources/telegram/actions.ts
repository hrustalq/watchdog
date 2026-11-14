"use server";

import { redirect } from "next/navigation";
import { requireWorkspace, server } from "@/lib/server";
import {
  answerTelegramLogin,
  cancelTelegramLogin,
  deleteTelegramSession,
  revokeTelegramSession,
  type SessionAccess,
  startTelegramLogin,
  watchTelegramChat,
} from "@/lib/telegram-session";

// Each action waits a few seconds for the worker's answer, then redirects to the page, which reads
// the login from the database. Without JavaScript that's a 303 the browser follows.
const page = "/sources/telegram";

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

async function access(): Promise<{ workspaceId: string; access: SessionAccess }> {
  const { workspace } = await requireWorkspace();
  const { db, encryptionKey, boss, telegramSessionAvailable } = server();
  return { workspaceId: workspace.id, access: { db, available: telegramSessionAvailable, encryptionKey, boss } };
}

/** Starts a login with the phone number. A problem comes back as a code; the number stays out of the URL. */
export async function startTelegramLoginAction(formData: FormData) {
  const { workspaceId, access: session } = await access();
  const result = await startTelegramLogin(session, workspaceId, text(formData, "phone"));
  if (result === "unavailable") redirect("/sources");
  redirect(result === "started" ? page : `${page}?problem=${result}`);
}

/** The code or the 2FA password, whichever step the form was for. */
export async function answerTelegramLoginAction(formData: FormData) {
  const { workspaceId, access: session } = await access();
  const step = text(formData, "step") === "password" ? "password" : "code";
  const result = await answerTelegramLogin(session, workspaceId, step, text(formData, step));
  if (result === "unavailable") redirect("/sources");
  redirect(result === "answered" ? page : `${page}?problem=${result}`);
}

export async function cancelTelegramLoginAction() {
  const { workspaceId, access: session } = await access();
  await cancelTelegramLogin(session, workspaceId);
  redirect(page);
}

export async function revokeTelegramSessionAction() {
  const { workspaceId, access: session } = await access();
  await revokeTelegramSession(session, workspaceId);
  redirect(page);
}

/** Deletes a session Watchdog can no longer decrypt, which it can't log out on Telegram either. */
export async function deleteTelegramSessionAction() {
  const { workspaceId, access: session } = await access();
  await deleteTelegramSession(session, workspaceId);
  redirect(page);
}

/** Watches a chat from the session's list. The page's list then shows the Source it became. */
export async function watchTelegramChatAction(formData: FormData) {
  const { workspaceId, access: session } = await access();
  const result = await watchTelegramChat(session, workspaceId, text(formData, "chat"));
  if (result === "unavailable") redirect("/sources");
  redirect(`${page}?${result === "watching" ? "done" : "problem"}=${result}`);
}
