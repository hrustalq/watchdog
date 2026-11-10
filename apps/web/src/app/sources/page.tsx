import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { releasesFeedUrl, sessionOf, signInToken } from "@watchdog/core";
import { buttonVariants } from "@/components/ui/button";
import { dataBox, textBox, textLink } from "@/components/field-classes";
import { HealthChip } from "@/components/health";
import { Timestamp } from "@/components/timestamp";
import { requireWorkspace, server } from "@/lib/server";
import {
  addProblems,
  addValues,
  checkGapMinutes,
  listSources,
  problemField,
  problemMessage,
  schedules,
  sourceLinkCookie,
  sourceLinkInCookie,
  watchedSourceName,
} from "@/lib/sources";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { checkSourceNowAction, newSourceLinkAction, removeSourceAction } from "./actions";
import { AddSourceForm } from "./add-source-form";
import { DueRefresher } from "./due-refresher";

export const metadata: Metadata = { title: "Sources · Watchdog" };

export default function SourcesPage({ searchParams }: PageProps<"/sources">) {
  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link
          href="/"
          className="rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          Workspace
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page">Sources</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
        <h1 className="text-headline">Sources</h1>
        <section aria-labelledby="add-source" className="flex flex-col gap-4 rounded-lg border p-4">
          <h2 id="add-source" className="text-title">
            Add a Source
          </h2>
          {/* The form is in the static shell, so it submits without JavaScript. What the last submit
              said, read from the URL, streams in over it, which takes JavaScript to show. */}
          <Suspense fallback={<AddSourceForm />}>
            <AddSourceFormWithOutcome searchParams={searchParams} />
          </Suspense>
        </section>
        <Suspense fallback={<div aria-busy="true" className="h-32 rounded-lg bg-muted" />}>
          <SourceList />
        </Suspense>
      </main>
    </div>
  );
}

async function AddSourceFormWithOutcome({ searchParams }: Pick<PageProps<"/sources">, "searchParams">) {
  const params = await searchParams;
  const param = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  const values = addValues(param);
  const { db, mode, renderers, telegramAvailable } = server();
  const { workspace } = await requireWorkspace();
  // The token field says whether it's needed, which depends on a GitHub sign-in.
  const githubSignIn = (await signInToken(db, workspace.id)) !== undefined;
  if (param("added") !== "") {
    return (
      <AddSourceForm
        added
        githubSignIn={githubSignIn}
        mode={mode}
        renderers={renderers}
        telegramAvailable={telegramAvailable}
        values={{ ...addValues(() => ""), type: values.type }}
      />
    );
  }
  // The code comes from the URL, so only a known one counts.
  const problem = addProblems.find((known) => known === param("error"));
  if (problem === undefined) {
    return <AddSourceForm githubSignIn={githubSignIn} mode={mode} renderers={renderers} telegramAvailable={telegramAvailable} />;
  }
  // Only the code travels in the URL, so the Source it's already watched as is looked up.
  const watching = problem === "duplicate" ? await watchedSourceName(db, workspace.id, values) : undefined;
  const shown = { ...values, status: param("status"), mode, source: watching };
  return (
    <AddSourceForm
      values={values}
      githubSignIn={githubSignIn}
      mode={mode}
      renderers={renderers}
      telegramAvailable={telegramAvailable}
      tokenDropped={param("pasted") !== ""}
      error={{ field: problemField(problem, values.type, values), message: problemMessage(problem, shown) }}
    />
  );
}

async function SourceList() {
  const { workspace } = await requireWorkspace();
  const { db, mode, telegramAvailable, telegramBotName, telegramSessionAvailable } = server();
  const [sources, session] = await Promise.all([
    listSources(db, workspace.id, checkGapMinutes(mode)),
    telegramSessionAvailable ? sessionOf(db, workspace.id) : undefined,
  ]);
  const link = telegramAvailable
    ? await sourceLinkInCookie(db, sources, (await cookies()).get(sourceLinkCookie)?.value)
    : undefined;
  const bot = link?.status === "pending" ? await telegramBotName() : undefined;
  const scheduleLabel = (cron: string | null) => schedules.find((preset) => preset.cron === cron)?.label;
  // RSS and website Sources watch a URL, a GitHub Source a repo's releases or issues, or a search. An
  // inbox and a Telegram chat have none.
  const urlOf = ({ config }: (typeof sources)[number]) => {
    if ("url" in config) return config.url;
    if (!("kind" in config)) return null;
    if (config.kind === "mentions") {
      // The same search on github.com, which the user can open to check it.
      const q = `(${config.term}) (is:issue OR is:pr)${config.within === undefined ? "" : ` ${config.within}`}`;
      return `https://github.com/search?${new URLSearchParams({ q, type: "issues" }).toString()}`;
    }
    return `https://github.com/${config.repo}/${config.kind}`;
  };
  // The URL is on the line above, so the error needn't repeat the URL it fetched.
  const withoutUrl = ({ type, config }: (typeof sources)[number], error: string) => {
    // Only the URL itself, not a longer one it starts, such as a site's robots.txt.
    if ("url" in config && error.startsWith(`${config.url} `)) {
      return `${type === "website" ? "the page" : "the feed"}${error.slice(config.url.length)}`;
    }
    if ("url" in config) return error;
    return "kind" in config && config.kind === "releases" ? error.replace(releasesFeedUrl(config.repo), "the releases feed") : error;
  };

  return (
    <>
    {telegramSessionAvailable ? <TelegramAccount session={session} /> : null}
    {link?.status === "pending" ? <TelegramLinkPanel link={link} bot={bot} /> : null}
    {link?.status === "linked" ? (
      <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
        The bot is in the chat. {link.name} captures each message posted there from now on.
      </Notice>
    ) : null}
    <section aria-labelledby="watched" className="flex flex-col gap-3">
        <h2 id="watched" className="text-title">
          Watching <span className="tabular-nums">{sources.length}</span>{" "}
          {sources.length === 1 ? "Source" : "Sources"}
        </h2>
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet. Add a feed, a page, a GitHub repo, a GitHub search, a webhook inbox or a Telegram chat above, and every
            Item it captures shows up in the Feed.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {sources.map((row) => (
              <li key={row.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-title min-w-0 break-words">{row.name}</h3>
                    {/* A bot Source with no chat watches nothing yet, so it has no Health to read. */}
                    {row.type === "telegram" && !("chatId" in row.config) ? null : <HealthChip health={row.health} />}
                  </div>
                  {row.type === "telegram" ? (
                    <p className="text-sm text-muted-foreground">
                      Telegram · <TelegramState config={row.config} available={telegramAvailable} />
                    </p>
                  ) : null}
                  {row.type === "webhook" ? (
                    <p className="text-sm text-muted-foreground">
                      Webhook inbox ·{" "}
                      <Link href={`/sources/${row.id}/inbox`} className={textLink}>
                        URL and mapping
                        <span className="sr-only"> for {row.name}</span>
                      </Link>
                    </p>
                  ) : null}
                  {urlOf(row) === null ? null : (
                    <p className="font-mono text-[0.8125rem] break-all text-muted-foreground">{urlOf(row)}</p>
                  )}
                  {"region" in row.config ? (
                    <p className="text-sm break-all text-muted-foreground">
                      Region <span className="font-mono text-[0.8125rem]">{row.config.region}</span>
                    </p>
                  ) : null}
                  {row.schedule === null ? null : <p className="text-sm text-muted-foreground">
                    {scheduleLabel(row.schedule) ?? <span className="font-mono">{row.schedule}</span>}
                    {" · "}
                    {lastSuccess(row) ?? `${row.lastError === null ? "Not polled" : "No successful poll"} yet`}
                  </p>}
                  {row.schedule !== null || row.lastSuccessAt === null ? null : (
                    <p className="text-sm text-muted-foreground">{lastSuccess(row)}</p>
                  )}
                  {row.lastError === null ? null : (
                    // The chip has the lamp. One failed poll isn't an alarm, so the error is red only once the Source is failing.
                    <p className={`text-sm break-words ${errorTone[row.health]}`}>
                      {row.type === "telegram" ? "Lost access" : "Last poll failed"}
                      {row.lastErrorAt === null ? null : (
                        <>
                          {" "}
                          at <Timestamp at={row.lastErrorAt} className="whitespace-nowrap" />
                        </>
                      )}
                      : {withoutUrl(row, row.lastError)}
                    </p>
                  )}
                  {row.due ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      A poll is due, and the worker usually runs it within a minute.{" "}
                      <Link href="/sources" prefetch={false} className={textLink}>
                        Reload this page
                        <span className="sr-only"> to see {row.name}&apos;s poll</span>
                      </Link>{" "}
                      to see how it went.
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-start gap-2">
                  {/* On hosted, not until the shortest schedule has passed since the last poll. */}
                  {row.schedule === null || !row.checkable ? null : (
                    <form action={checkSourceNowAction.bind(null, row.id)}>
                      <SubmitButton variant="outline" pendingLabel="Asking…">
                        Check now<span className="sr-only"> for {row.name}</span>
                      </SubmitButton>
                    </form>
                  )}
                  {telegramAvailable &&
                  row.type === "telegram" &&
                  !isSession(row.config) &&
                  link?.id !== row.id &&
                  (!("chatId" in row.config) || row.health === "failing") ? (
                    <form action={newSourceLinkAction.bind(null, row.id)}>
                      <SubmitButton variant="outline" pendingLabel="Getting a link…">
                        Get a new link<span className="sr-only"> for {row.name}</span>
                      </SubmitButton>
                    </form>
                  ) : null}
                  <RemoveSource id={row.id} name={row.name} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <DueRefresher due={sources.some((row) => row.due)} />
      </section>
    </>
  );
}

const lastSuccess = ({ lastSuccessAt }: { lastSuccessAt: Date | null }) =>
  lastSuccessAt === null ? null : (
    <>
      Last success <Timestamp at={lastSuccessAt} className="whitespace-nowrap" />
    </>
  );

const errorTone = { ok: "text-foreground", degraded: "text-caution", failing: "text-alarm" };

/** A Source that reads through the Telegram user session rather than the bot. */
const isSession = (config: object) => "via" in config && config.via === "session";

/** A Telegram Source's chat, or why it has none, with a caution lamp as on the Destinations screen. */
function TelegramState({ config, available }: { config: object; available: boolean }) {
  const title = "title" in config && typeof config.title === "string" ? config.title : undefined;
  // A session Source reads without the bot, so it has its chat whether or not the install has one.
  if (title !== undefined && isSession(config)) return `${title} · through your account`;
  if (available && title !== undefined) return title;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-caution" />
      {available ? "Waiting for the bot" : "Unavailable: this install has no TELEGRAM_BOT_TOKEN"}
    </span>
  );
}

/** Where a self-hosted install signs in a Telegram user session (ADR 0014). Only offered there. */
function TelegramAccount({ session }: { session: { account: string; revokedAt: Date | null } | undefined }) {
  let state = "For chats you can't add the bot to. Watchdog signs in with a session of its own and uses it only to read.";
  if (session !== undefined) {
    state =
      session.revokedAt === null
        ? `Signed in as ${session.account}. Watchdog uses the session only to read.`
        : `Revoking ${session.account}.`;
  }
  return (
    <section
      aria-labelledby="telegram-account"
      className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="telegram-account" className="text-title">
          Telegram (your account)
        </h2>
        <p className="text-sm text-muted-foreground">{state}</p>
      </div>
      <Link href="/sources/telegram" className={`${buttonVariants({ variant: "outline" })} shrink-0`}>
        {session === undefined ? "Sign in" : "Manage"}
        <span className="sr-only"> Telegram (your account)</span>
      </Link>
    </section>
  );
}

/** How to bring the bot into a chat. It works without JavaScript, and the text box copies from a keyboard. */
function TelegramLinkPanel({
  link: { name, code, expiresAt },
  bot,
}: {
  link: { name: string; code: string; expiresAt: Date };
  bot: string | undefined;
}) {
  return (
    <section aria-labelledby="telegram-link" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 id="telegram-link" className="text-title">
        Bring the bot into a chat for {name}
      </h2>
      {bot === undefined ? (
        <Notice role="alert" className="text-sm text-alarm">
          Watchdog couldn&apos;t reach Telegram to get the bot&apos;s name, so the link isn&apos;t ready. Reload this page
          in a moment.
        </Notice>
      ) : (
        <>
          {/* Keyed by the code, so a new link is announced even though the rest of the page stays. */}
          <Notice key={code} role="status" className="text-sm">
            The code in this link and command works once and expires at <Timestamp at={expiresAt} className="whitespace-nowrap" />.
          </Notice>
          <p className="text-sm">
            For a group,{" "}
            <a href={`https://t.me/${bot}?startgroup=${code}`} target="_blank" rel="noreferrer" className={textLink}>
              choose it in Telegram
            </a>
            . The bot joins it and starts watching.
          </p>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="telegram-command">For a channel, make @{bot} an admin and post this there:</label>
            {/* @bot in the command, because a bot in a group is only sure to get commands addressed to it. */}
            <textarea
              id="telegram-command"
              readOnly
              rows={2}
              value={`/start@${bot} ${code}`}
              className={`${textBox} ${dataBox} resize-none py-1.5 field-sizing-content`}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href="/sources" prefetch={false} className={textLink}>
              Reload this page
            </Link>{" "}
            after the bot replies. No reply within a minute? Get a new link, which replaces this one, and try again.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Remove, then a confirmation in the page that says what goes with it. A disclosure works without
 * JavaScript, unlike a confirm() dialog.
 */
function RemoveSource({ id, name }: { id: string; name: string }) {
  return (
    <details className="group shrink-0 sm:max-w-64">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg px-3 text-sm font-medium outline-none select-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 group-open:bg-muted dark:hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Remove</span>
        <span className="hidden group-open:inline">Keep it</span>
      </summary>
      <div className="mt-2 flex flex-col gap-3 rounded-lg bg-muted p-3">
        <p className="text-sm">
          Removing {name} also deletes every Item it captured, and their Logs, from the Feed. This
          can&apos;t be undone.
        </p>
        <form action={removeSourceAction.bind(null, id)}>
          <SubmitButton variant="destructive" pendingLabel="Removing…">
            Remove Source and its Items
          </SubmitButton>
        </form>
      </div>
    </details>
  );
}
