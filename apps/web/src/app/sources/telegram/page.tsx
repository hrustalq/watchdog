import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loginState, sessionOf } from "@watchdog/core";
import { Confirming } from "@/components/confirming";
import { dataBox, field, label, textLink } from "@/components/field-classes";
import { Timestamp } from "@/components/timestamp";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "../../sign-in/notice";
import { SubmitButton } from "../../sign-in/submit-button";
import {
  answerTelegramLoginAction,
  cancelTelegramLoginAction,
  revokeTelegramSessionAction,
  startTelegramLoginAction,
} from "./actions";

export const metadata: Metadata = { title: "Telegram (your account) · Watchdog" };

// Read without Suspense, so every step is in the first HTML and the login works without JavaScript.
export const instant = false;

const crumb =
  "rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30";

const problems: Record<string, string> = {
  "invalid-phone": "That isn't a phone number. Enter it in international format, starting with the country code.",
  "signed-in": "This Workspace already has a Telegram session. Revoke it before signing in another account.",
  empty: "The field was empty, so nothing was sent.",
  "not-asked": "The login had already moved on, so nothing was sent. Here is where it stands.",
};

export default async function TelegramSessionPage({ searchParams }: PageProps<"/sources/telegram">) {
  const [{ workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const { db, telegramSessionAvailable } = server();
  // Hosted, or no API variables: the screen isn't offered (ADR 0014).
  if (!telegramSessionAvailable) notFound();
  const [session, login] = await Promise.all([sessionOf(db, workspace.id), loginState(db, workspace.id)]);
  const problem = typeof params.problem === "string" ? problems[params.problem] : undefined;

  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link href="/" className={crumb}>
          Workspace
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <Link href="/sources" className={crumb}>
          Sources
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page">Telegram (your account)</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 break-words">
        <div className="flex flex-col gap-2">
          <h1 className="text-headline">Telegram (your account)</h1>
          <p className="text-sm text-muted-foreground">
            For chats you can&apos;t add a bot to, Watchdog can sign in as you with a session of its own and use it only to
            read. It never sends, joins, leaves or marks anything as read. Whenever you can add a bot to the chat, use the
            bot instead: add a Telegram chat on the{" "}
            <Link href="/sources" className={textLink}>
              Sources
            </Link>{" "}
            screen.
          </p>
        </div>

        {problem === undefined ? null : (
          <Notice key={problem} role="alert" className="rounded-lg bg-muted px-3 py-2 text-sm">
            {problem}
          </Notice>
        )}

        {session !== undefined ? (
          <SessionPanel account={session.account} since={session.createdAt} revoking={session.revokedAt !== null} />
        ) : (
          <LoginPanel login={login} />
        )}
      </main>
    </div>
  );
}

function SessionPanel({ account, since, revoking }: { account: string; since: Date; revoking: boolean }) {
  if (revoking) {
    return (
      <section aria-labelledby="session" className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <h2 id="session" className="text-title">
          Revoking {account}
        </h2>
        <Notice role="status" className="text-sm">
          Watchdog is logging the session out on Telegram, then deletes it.{" "}
          <Link href="/sources/telegram" prefetch={false} className={textLink}>
            Reload this page
          </Link>{" "}
          in a moment.
        </Notice>
      </section>
    );
  }
  return (
    <section aria-labelledby="session" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 id="session" className="text-title">
          Signed in as {account}
        </h2>
        <p className="text-sm text-muted-foreground">
          Since <Timestamp at={since} />. The session is stored encrypted, and only Watchdog&apos;s worker can read it.
        </p>
      </div>
      <Confirming
        label="Revoke"
        name={account}
        warning="Watchdog logs the session out on Telegram and deletes it. The Sources that read through it stop."
        action={revokeTelegramSessionAction}
        button="Revoke the session"
        pendingLabel="Revoking…"
      />
    </section>
  );
}

function LoginPanel({ login }: { login: Awaited<ReturnType<typeof loginState>> }) {
  if (login === undefined || login.step === "failed") {
    return (
      <section aria-labelledby="sign-in" className="flex flex-col gap-4 rounded-lg border p-4">
        <h2 id="sign-in" className="text-title">
          Sign in
        </h2>
        {login === undefined ? null : (
          <Notice role="alert" className="text-sm text-alarm">
            {login.refusal}
          </Notice>
        )}
        <form action={startTelegramLoginAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="phone" className={label}>
              Phone number
            </label>
            <input id="phone" name="phone" type="tel" autoComplete="tel" className={`${field} ${dataBox}`} />
            <p className="text-xs text-muted-foreground">
              With the country code, such as +44 20 7946 0958. Telegram sends a code to your Telegram app.
            </p>
          </div>
          <SubmitButton pendingLabel="Asking Telegram for a code…" className="sm:w-auto sm:self-start">
            Send a code
          </SubmitButton>
        </form>
      </section>
    );
  }

  return (
    <section aria-labelledby="sign-in" className="flex flex-col gap-4 rounded-lg border p-4">
      <h2 id="sign-in" className="text-title">
        Signing in <span className="font-mono text-[0.8125rem] font-normal">{login.phone}</span>
      </h2>
      {login.step === "starting" ? (
        <Notice role="status" className="text-sm">
          Asking Telegram to send a code.{" "}
          <Link href="/sources/telegram" prefetch={false} className={textLink}>
            Reload this page
          </Link>{" "}
          in a moment.
        </Notice>
      ) : (
        <StepForm step={login.step} refusal={login.refusal} />
      )}
      <p className="text-xs text-muted-foreground">The login ends 5 minutes after it starts.</p>
      <form action={cancelTelegramLoginAction}>
        <SubmitButton variant="outline" pendingLabel="Cancelling…" className="sm:w-auto">
          Cancel and use another number
        </SubmitButton>
      </form>
    </section>
  );
}

function StepForm({ step, refusal }: { step: "code" | "password"; refusal: string | null }) {
  const code = step === "code";
  return (
    <form action={answerTelegramLoginAction} className="flex flex-col gap-4">
      <input type="hidden" name="step" value={step} />
      {/* Keyed by the refusal, so a second wrong code is announced too. */}
      {refusal === null ? null : (
        <Notice key={refusal} role="alert" className="text-sm text-alarm">
          {refusal}
        </Notice>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor={step} className={label}>
          {code ? "Code" : "Two-step verification password"}
        </label>
        <input
          id={step}
          name={step}
          type={code ? "text" : "password"}
          inputMode={code ? "numeric" : undefined}
          autoComplete={code ? "one-time-code" : "current-password"}
          spellCheck={false}
          aria-invalid={refusal === null ? undefined : true}
          className={code ? `${field} ${dataBox}` : field}
        />
        <p className="text-xs text-muted-foreground">
          {code
            ? "Telegram sent it to your Telegram app, in a chat from Telegram itself."
            : "Your account has two-step verification, so Telegram asks for its password too."}
        </p>
      </div>
      <SubmitButton pendingLabel="Checking with Telegram…" className="sm:w-auto sm:self-start">
        Sign in
      </SubmitButton>
    </form>
  );
}
