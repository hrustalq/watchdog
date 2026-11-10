import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loginState, sessionChats, sessionOf } from "@watchdog/core";
import { Confirming } from "@/components/confirming";
import { dataBox, field, fieldError, label, textLink } from "@/components/field-classes";
import { Timestamp } from "@/components/timestamp";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "../../sign-in/notice";
import { SubmitButton } from "../../sign-in/submit-button";
import {
  answerTelegramLoginAction,
  cancelTelegramLoginAction,
  revokeTelegramSessionAction,
  startTelegramLoginAction,
  watchTelegramChatAction,
} from "./actions";

export const metadata: Metadata = { title: "Telegram (your account) · Watchdog" };

// Read without Suspense, so every step is in the first HTML and the login works without JavaScript.
export const instant = false;

const crumb =
  "rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30";

// Shown over the page. A wrong phone number or an empty field is shown at its field instead.
const problems: Record<string, string> = {
  "signed-in": "This Workspace already has a Telegram session. Revoke it before signing in another account.",
  "not-asked": "The login had already moved on, so nothing was sent. Here is where it stands.",
  "not-listed": "That chat isn't in your account's list any more, so nothing was saved. Here is the current list.",
  watched: "This Workspace already watches that chat, so nothing was saved.",
};
const done: Record<string, string> = {
  watching: "Watching the chat. Its messages from the last 7 days come in within a minute, then every new one.",
};
const phoneInvalid = "That isn't a phone number. Enter it with the country code, such as +44 20 7946 0958.";

export default async function TelegramSessionPage({ searchParams }: PageProps<"/sources/telegram">) {
  const [{ workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const { db, telegramSessionAvailable } = server();
  // Hosted, or no API variables: the screen isn't offered (ADR 0014).
  if (!telegramSessionAvailable) notFound();
  const [session, login, chats] = await Promise.all([
    sessionOf(db, workspace.id),
    loginState(db, workspace.id),
    sessionChats(db, workspace.id),
  ]);
  const code = typeof params.problem === "string" ? params.problem : "";
  const problem = problems[code];
  const status = typeof params.done === "string" ? done[params.done] : undefined;

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

        {status === undefined ? null : (
          <Notice key={status} role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
            {status}
          </Notice>
        )}

        {session !== undefined ? (
          <>
            <SessionPanel
              account={session.account}
              since={session.createdAt}
              revoking={session.revokedAt !== null}
              stuck={session.revokeStuck}
            />
            {session.revokedAt === null ? <ChatsPanel chats={chats} /> : null}
          </>
        ) : (
          <LoginPanel login={login} invalid={code === "invalid-phone"} empty={code === "empty"} />
        )}
      </main>
    </div>
  );
}

function SessionPanel({
  account,
  since,
  revoking,
  stuck,
}: {
  account: string;
  since: Date;
  revoking: boolean;
  /** The revoke couldn't reach Telegram for a quarter of an hour and stopped trying. */
  stuck: boolean;
}) {
  if (revoking && stuck) {
    return (
      <section aria-labelledby="session" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 id="session" className="text-title">
          Revoking {account} didn&apos;t finish
        </h2>
        <Notice role="alert" className="text-sm text-alarm">
          Watchdog couldn&apos;t reach Telegram to log the session out, so the session is still there.
        </Notice>
        <form action={revokeTelegramSessionAction}>
          <SubmitButton variant="destructive" pendingLabel="Revoking…" className="sm:w-auto">
            Try again
          </SubmitButton>
        </form>
      </section>
    );
  }
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

const kinds = { group: "Group", supergroup: "Group", channel: "Channel" };

/** The account's groups and channels, each watched as a Source with one click. */
function ChatsPanel({ chats }: { chats: Awaited<ReturnType<typeof sessionChats>> }) {
  return (
    <section aria-labelledby="chats" className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <h2 id="chats" className="text-title">
          Chats to watch
        </h2>
        <p className="text-sm text-muted-foreground">
          Each chat you watch becomes a Source. It starts with the chat&apos;s messages from the last 7 days, at most 50,
          then takes every new one. Watchdog reads this list from Telegram once an hour.
        </p>
      </div>
      <ChatList chats={chats} />
    </section>
  );
}

function ChatList({ chats }: { chats: Awaited<ReturnType<typeof sessionChats>> }) {
  if (chats === undefined) {
    return (
      <Notice role="status" className="text-sm">
        Watchdog is reading your chats from Telegram.{" "}
        <Link href="/sources/telegram" prefetch={false} className={textLink}>
          Reload this page
        </Link>{" "}
        in a minute.
      </Notice>
    );
  }
  if (chats.length === 0) return <p className="text-sm text-muted-foreground">The account isn&apos;t in any groups or channels.</p>;
  return (
    <ul className="flex flex-col divide-y">
      {chats.map((chat) => (
        <li key={chat.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
          <div className="flex min-w-0 flex-col">
            <span className="break-words">{chat.title}</span>
            <span className="text-xs text-muted-foreground">{kinds[chat.type]}</span>
          </div>
          {chat.watchedAs === null ? (
            <form action={watchTelegramChatAction}>
              <input type="hidden" name="chat" value={chat.id} />
              <SubmitButton variant="outline" pendingLabel="Watching…" className="sm:w-auto">
                Watch<span className="sr-only"> {chat.title}</span>
              </SubmitButton>
            </form>
          ) : (
            <span className="text-sm text-muted-foreground">Watched as {chat.watchedAs}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function LoginPanel({
  login,
  invalid,
  empty,
}: {
  login: Awaited<ReturnType<typeof loginState>>;
  /** The last phone number posted wasn't one. */
  invalid: boolean;
  /** The last code or password posted was empty. */
  empty: boolean;
}) {
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
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? "phone-error phone-help" : "phone-help"}
              className={`${field} ${dataBox}`}
            />
            {invalid ? (
              <p id="phone-error" className={fieldError}>
                {phoneInvalid}
              </p>
            ) : null}
            <p id="phone-help" className="text-xs text-muted-foreground">
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
        <StepForm step={login.step} refusal={login.refusal} empty={empty} />
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

function StepForm({ step, refusal, empty }: { step: "code" | "password"; refusal: string | null; empty: boolean }) {
  const code = step === "code";
  const error = empty ? `Enter the ${code ? "code" : "password"} first.` : null;
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
          aria-invalid={refusal !== null || error !== null || undefined}
          aria-describedby={error === null ? `${step}-help` : `${step}-error ${step}-help`}
          className={code ? `${field} ${dataBox}` : field}
        />
        {error === null ? null : (
          <p id={`${step}-error`} className={fieldError}>
            {error}
          </p>
        )}
        <p id={`${step}-help`} className="text-xs text-muted-foreground">
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
