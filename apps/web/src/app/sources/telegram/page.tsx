import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loginState, sessionChats, sessionOf } from "@watchdog/core";
import { Confirming } from "@/components/confirming";
import { dataBox, textLink } from "@/components/field-classes";
import { TextField } from "@/components/form-field";
import { PageBar } from "@/components/page-bar";
import { Page, PageHeader } from "@/components/page";
import { Section } from "@/components/section";
import { Timestamp } from "@/components/timestamp";
import { Button } from "@/components/ui/button";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { matchingChats } from "./chat-filter";
import {
  answerTelegramLoginAction,
  cancelTelegramLoginAction,
  deleteTelegramSessionAction,
  revokeTelegramSessionAction,
  startTelegramLoginAction,
  watchTelegramChatAction,
} from "./actions";

export const metadata: Metadata = { title: "Telegram (your account) · Watchdog" };

// Read without Suspense, so every step is in the first HTML and the login works without JavaScript.
export const instant = false;

// Shown over the page. A wrong phone number or an empty field is shown at its field instead.
const problems: Record<string, string> = {
  "signed-in": "This Workspace already has a Telegram session. Revoke it before signing in another account.",
  "not-asked": "The login had already moved on, so nothing was sent. Here is where it stands.",
  "not-listed": "That chat isn't in your account's list any more, so nothing was saved. Here is the current list.",
  watched: "This Workspace already watches that chat, so nothing was saved.",
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
  // The chat filter. Read here, so the list is narrowed in the HTML and the field shows what filtered it.
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const status =
    params.done === "watching"
      ? "Watching the chat. Its messages from the last 7 days come in within a minute, then every new one."
      : undefined;

  return (
    <div className="flex flex-1 flex-col">
      <PageBar
        trail={[{ href: "/", label: "Workspace" }, { href: "/sources", label: "Sources" }, { label: "Telegram (your account)" }]}
      />
      <Page className="break-words">
        <PageHeader
          title="Telegram (your account)"
          description={
            <>
              For chats you can&apos;t add a bot to, Watchdog can sign in as you with a session of its own and use it only to
              read. It never sends, joins, leaves or marks anything as read. Whenever you can add a bot to the chat, use the
              bot instead: add a Telegram chat on the{" "}
              <Link href="/sources" className={textLink}>
                Sources
              </Link>{" "}
              screen.
            </>
          }
        />

        {problem === undefined ? null : (
          <Notice key={problem} role="alert">
            {problem}
          </Notice>
        )}

        {status === undefined ? null : (
          <Notice key={status} role="status">
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
              unreadable={session.unreadableAt !== null}
            />
            {session.revokedAt === null && session.unreadableAt === null ? (
              <ChatsPanel chats={chats} query={query} />
            ) : null}
          </>
        ) : (
          <LoginPanel login={login} invalid={code === "invalid-phone"} empty={code === "empty"} />
        )}
      </Page>
    </div>
  );
}

function SessionPanel({
  account,
  since,
  revoking,
  stuck,
  unreadable,
}: {
  account: string;
  since: Date;
  revoking: boolean;
  /** The revoke couldn't reach Telegram for a quarter of an hour and stopped trying. */
  stuck: boolean;
  /** The encryption key changed, so Watchdog can neither read the session nor log it out. */
  unreadable: boolean;
}) {
  if (unreadable) {
    return (
      <Section id="session" title={<>Watchdog can&apos;t read the session for {account}</>} tone="raised">
        <Notice role="alert" tone="alarm">
          Watchdog&apos;s encryption key changed after the session was stored, so Watchdog can&apos;t read it any more,
          and can&apos;t log it out on Telegram either. End it yourself in Telegram under Settings › Devices, then
          delete it here.
        </Notice>
        <Confirming
          label="Delete"
          name={account}
          warning="Watchdog deletes the session, and the Sources that read through it stop. Telegram keeps the session on the account until you end it in Settings › Devices."
          action={deleteTelegramSessionAction}
          button="Delete the session"
          pendingLabel="Deleting…"
        />
      </Section>
    );
  }
  if (revoking && stuck) {
    return (
      <Section id="session" title={<>Revoking {account} didn&apos;t finish</>} tone="raised">
        <Notice role="alert" tone="alarm">
          Watchdog couldn&apos;t reach Telegram to log the session out, so the session is still there.
        </Notice>
        <form action={revokeTelegramSessionAction}>
          <SubmitButton variant="destructive" pendingLabel="Revoking…" className="sm:w-auto">
            Try again
          </SubmitButton>
        </form>
      </Section>
    );
  }
  if (revoking) {
    return (
      <Section id="session" title={<>Revoking {account}</>} tone="raised" gap={2}>
        <Notice role="status" tone="plain">
          Watchdog is logging the session out on Telegram, then deletes it.{" "}
          <Link href="/sources/telegram" prefetch={false} className={textLink}>
            Reload this page
          </Link>{" "}
          in a moment.
        </Notice>
      </Section>
    );
  }
  return (
    <Section
      id="session"
      title={<>Signed in as {account}</>}
      tone="raised"
      description={<>Since <Timestamp at={since} />. The session is stored encrypted, and only Watchdog&apos;s worker can read it.</>}
    >
      <Confirming
        label="Revoke"
        name={account}
        warning="Watchdog logs the session out on Telegram and deletes it. The Sources that read through it stop."
        action={revokeTelegramSessionAction}
        button="Revoke the session"
        pendingLabel="Revoking…"
      />
    </Section>
  );
}

const kinds = { group: "Group", supergroup: "Group", channel: "Channel" };

/** The account's groups and channels, each watched as a Source with one click. */
function ChatsPanel({ chats, query }: { chats: Awaited<ReturnType<typeof sessionChats>>; query: string }) {
  return (
    <Section
      id="chats"
      title="Chats to watch"
      tone="panel"
      description="Each chat you watch becomes a Source. It starts with the chat's messages from the last 7 days, at most 50, then takes every new one. Watchdog reads this list from Telegram once an hour."
    >
      <ChatList chats={chats} query={query} />
    </Section>
  );
}

function ChatList({ chats, query }: { chats: Awaited<ReturnType<typeof sessionChats>>; query: string }) {
  if (chats === undefined) {
    return (
      <Notice role="status" tone="plain">
        Watchdog is reading your chats from Telegram.{" "}
        <Link href="/sources/telegram" prefetch={false} className={textLink}>
          Reload this page
        </Link>{" "}
        in a minute.
      </Notice>
    );
  }
  if (chats.length === 0) return <p className="text-sm text-muted-foreground">The account isn&apos;t in any groups or channels.</p>;
  const shown = matchingChats(chats, query);
  return (
    <div className="flex flex-col gap-3">
      <ChatFilter query={query} />
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No chat&apos;s title contains <span className="break-words">“{query}”</span>. An empty filter lists them all.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {shown.map((chat) => (
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
      )}
    </div>
  );
}

/** Narrows the list by part of a chat's title. A plain GET form, so the filter works without JavaScript. */
function ChatFilter({ query }: { query: string }) {
  return (
    <form
      method="get"
      action="/sources/telegram"
      role="search"
      aria-label="Filter chats"
      className="flex flex-wrap items-end gap-2"
    >
      <TextField
        id="q"
        name="q"
        label="Filter chats by title"
        type="search"
        defaultValue={query}
        autoComplete="off"
        className="min-w-0 flex-1"
      />
      <Button type="submit" variant="outline" className="sm:w-auto">
        Filter
      </Button>
    </form>
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
      <Section id="sign-in" title="Sign in" tone="panel" gap={4}>
        {login === undefined ? null : (
          <Notice role="alert" tone="alarm">
            {login.refusal}
          </Notice>
        )}
        <form action={startTelegramLoginAction} className="flex flex-col gap-4">
          <TextField
            id="phone"
            name="phone"
            label="Phone number"
            type="tel"
            autoComplete="tel"
            error={invalid ? phoneInvalid : undefined}
            help="With the country code, such as +44 20 7946 0958. Telegram sends a code to your Telegram app."
            controlClassName={dataBox}
          />
          <SubmitButton pendingLabel="Asking Telegram for a code…" className="sm:w-auto sm:self-start">
            Send a code
          </SubmitButton>
        </form>
      </Section>
    );
  }

  return (
    <Section id="sign-in" title={<>Signing in <span className="text-data font-normal">{login.phone}</span></>} tone="panel" gap={4}>
      {login.step === "starting" ? (
        <Notice role="status" tone="plain">
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
    </Section>
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
        <Notice key={refusal} role="alert">
          {refusal}
        </Notice>
      )}
      <TextField
        id={step}
        name={step}
        label={code ? "Code" : "Two-step verification password"}
        type={code ? "text" : "password"}
        inputMode={code ? "numeric" : undefined}
        autoComplete={code ? "one-time-code" : "current-password"}
        error={error ?? undefined}
        controlClassName={code ? dataBox : ""}
        help={
          code
            ? "Telegram sent it to your Telegram app, in a chat from Telegram itself."
            : "Your account has two-step verification, so Telegram asks for its password too."
        }
      />
      <SubmitButton pendingLabel="Checking with Telegram…" className="sm:w-auto sm:self-start">
        Sign in
      </SubmitButton>
    </form>
  );
}
