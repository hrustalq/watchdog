import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { dataBox, field, label, textBox, textLink } from "@/components/field-classes";
import { Timestamp } from "@/components/timestamp";
import {
  actionNames,
  actionsOnlyOn,
  healthAlertsOnlyOn,
  addProblems,
  type DestinationState,
  listDestinations,
  problemField,
  problemMessage,
  revealWebhookSecret,
  telegramLinkCookie,
  telegramLinkInCookie,
} from "@/lib/destinations";
import { Confirming } from "@/components/confirming";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import {
  addEmailAction,
  addTelegramAction,
  addWebhookAction,
  newTelegramLinkAction,
  removeDestinationAction,
  replaceSecretAction,
  sendAgainAction,
  testDestinationAction,
} from "./actions";
import { FieldError } from "./field-error";

export const metadata: Metadata = { title: "Destinations · Watchdog" };

// The data is read without Suspense, so all of it is in the first HTML. A webhook secret has to reach
// someone without JavaScript too, and it's shown only this once.
export const instant = false;

const configurationPage = "https://knowledge.hrustalq.dev/documents/8e6aedb7-ccc1-4057-9f9f-2a881d612d47";

export default async function DestinationsPage({ searchParams }: PageProps<"/destinations">) {
  const [{ workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const param = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  const { db, destinationDeps, mode, mailGoesToLog, telegramAvailable, telegramBotName } = server();
  const destinations = await listDestinations(db, workspace.id, { telegramAvailable });
  const problem = addProblems.find((known) => known === param("error"));
  const error = problem === undefined ? undefined : {
    field: problemField(problem),
    message: problemMessage(problem, mode),
  };
  const telegram = await telegramLinkInCookie(db, destinations, (await cookies()).get(telegramLinkCookie)?.value);
  // A notice takes focus when it arrives, and a field with an error or a secret shown once comes first.
  const telegramNotice = error === undefined && param("secret") === "" ? telegram : undefined;
  const bot = telegramNotice?.status === "pending" ? await telegramBotName() : undefined;

  // Only ids and codes travel in the URL, so what it says comes from the Workspace or from fixed text.
  const secretFor = destinations.find(({ id }) => id === param("secret"));
  const refused = await actionsOnlyOn(db, workspace.id, param("refused"));
  const refusedName = destinations.find(({ id }) => id === param("refused"))?.name;
  const refusedBySetting = await healthAlertsOnlyOn(db, workspace.id, param("refused"));
  const left = await actionNames(db, workspace.id, param("left").split(","));
  const tested = destinations.find(({ id }) => id === param("test"));
  // Last, because a read that fails after this would lose a secret nobody saw.
  const secret = await revealWebhookSecret(db, destinationDeps.encryptionKey, workspace.id, param("secret"));

  const form = param("form");

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
        <span aria-current="page">Destinations</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 break-words">
        <div className="flex flex-col gap-1">
          <h1 className="text-headline">Destinations</h1>
          <p className="text-sm text-muted-foreground">Where Actions deliver alerts, webhook calls and Digests.</p>
        </div>

        {secret === undefined ? null : <SecretPanel secret={secret} name={secretFor?.name} />}
        {secret === undefined && secretFor?.type === "webhook" ? (
          <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
            The secret for {secretFor.name} was already shown. Replace it if you didn&apos;t keep a copy.
          </Notice>
        ) : null}
        {telegramNotice?.status === "pending" ? <TelegramLinkPanel link={telegramNotice} bot={bot} /> : null}
        {telegramNotice?.status === "linked" ? (
          <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
            {telegramNotice.name} is linked.
          </Notice>
        ) : null}
        <Outcome
          added={param("added")}
          resent={param("resent")}
          missing={param("missing") !== ""}
          removed={param("removed") !== ""}
          left={left}
          refused={refused}
          refusedName={refusedName}
          refusedBySetting={refusedBySetting}
          mailGoesToLog={mailGoesToLog}
        />
        {tested === undefined ? null : (
          <TestOutcome
            key={`${tested.id}:${tested.lastErrorAt?.toISOString() ?? "sent"}`}
            tested={tested}
            capped={param("capped") !== ""}
            timezone={workspace.timezone}
            mailGoesToLog={mailGoesToLog}
          />
        )}

        <section aria-labelledby="add-destination" className="flex flex-col gap-3">
          <h2 id="add-destination" className="text-title">
            Add a Destination
          </h2>
          <div className="divide-y rounded-lg border">
            <AddForm title="Email address" open={form === "email" || (form === "" && destinations.length === 0)}>
              <form action={addEmailAction} className="flex flex-col gap-4">
                <NameField
                  id="email-name"
                  value={form === "email" ? param("name") : ""}
                  error={form === "email" ? error : undefined}
                />
                <TextField
                  id="address"
                  label="Address"
                  type="email"
                  placeholder="you@example.com"
                  value={form === "email" ? param("address") : ""}
                  error={form === "email" && error?.field === "address" ? error.message : undefined}
                  help="Any address but your own gets a link to confirm it, and receives nothing until then."
                />
                <SubmitButton pendingLabel="Adding…" className="sm:w-auto sm:self-start">
                  Add email address
                </SubmitButton>
              </form>
            </AddForm>
            <AddForm title="Webhook URL" open={form === "webhook"}>
              <form action={addWebhookAction} className="flex flex-col gap-4">
                <NameField
                  id="webhook-name"
                  value={form === "webhook" ? param("name") : ""}
                  error={form === "webhook" ? error : undefined}
                />
                <TextField
                  id="webhook-url"
                  name="url"
                  label="URL"
                  type="url"
                  placeholder="https://example.com/watchdog"
                  value=""
                  error={form === "webhook" && error?.field === "url" ? error.message : undefined}
                  help="Watchdog generates a signing secret and shows it once. The URL should answer directly, because a redirect can drop the request's body and signature."
                />
                <SubmitButton pendingLabel="Adding…" className="sm:w-auto sm:self-start">
                  Add webhook
                </SubmitButton>
              </form>
            </AddForm>
            <AddForm title="Telegram chat" open={form === "telegram"}>
              {telegramAvailable ? (
                <form action={addTelegramAction} className="flex flex-col gap-4">
                  <NameField
                    id="telegram-name"
                    value={form === "telegram" ? param("name") : ""}
                    error={form === "telegram" ? error : undefined}
                    placeholder="Ops alerts"
                  />
                  <p className="text-sm text-muted-foreground">
                    Next, Watchdog gives you a link and a command to link a private chat or a group.
                  </p>
                  <SubmitButton pendingLabel="Adding…" className="sm:w-auto sm:self-start">
                    Add Telegram chat
                  </SubmitButton>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Telegram isn&apos;t set up on this install. Whoever runs this Watchdog can set{" "}
                  <code className="font-mono text-[0.8125rem]">TELEGRAM_BOT_TOKEN</code>, as the{" "}
                  <a href={configurationPage} className="underline underline-offset-4">
                    Configuration page
                  </a>{" "}
                  describes.
                </p>
              )}
            </AddForm>
          </div>
        </section>

        <section aria-labelledby="destinations" className="flex flex-col gap-3">
          <h2 id="destinations" className="text-title">
            <span className="tabular-nums">{destinations.length}</span>{" "}
            {destinations.length === 1 ? "Destination" : "Destinations"}
          </h2>
          {destinations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None yet. Add one above, so Actions have somewhere to deliver.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {destinations.map((row) => (
                <li key={row.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-title break-words">{row.name}</h3>
                    {row.pointsAt === null ? null : (
                      <p
                        className={
                          row.type === "telegram"
                            ? "text-sm text-muted-foreground"
                            : "font-mono text-[0.8125rem] break-all text-muted-foreground"
                        }
                      >
                        {row.pointsAt}
                      </p>
                    )}
                    <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                      <span>{typeNames[row.type]}</span>
                      <span aria-hidden="true">·</span>
                      <State state={row.state} failing={row.lastError !== null} />
                    </p>
                    {row.state === "waiting-bot" && telegram?.id !== row.id ? (
                      <p className="text-sm text-muted-foreground">
                        No link is showing for it here. Get a new one to link a chat.
                      </p>
                    ) : null}
                    {row.lastError === null ? null : (
                      <p className="flex items-start gap-2 text-sm text-alarm">
                        <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm" />
                        <span className="min-w-0 break-words">
                          Last send failed
                          {row.lastErrorAt === null ? null : (
                            <>
                              {" "}
                              at <Timestamp at={row.lastErrorAt} />
                            </>
                          )}
                          : {row.lastError}
                        </span>
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:max-w-64 sm:items-end">
                    {row.state === "confirmed" || row.state === "ready" ? (
                      <form action={testDestinationAction.bind(null, row.id)}>
                        <SubmitButton variant="outline" pendingLabel="Sending…" className="w-auto">
                          Send a test
                          <span className="sr-only"> to {row.name}</span>
                        </SubmitButton>
                      </form>
                    ) : null}
                    {row.state === "waiting-confirmation" ? (
                      <form action={sendAgainAction.bind(null, row.id)}>
                        <SubmitButton variant="outline" pendingLabel="Sending…" className="w-auto">
                          Send the link again
                          <span className="sr-only"> to {row.name}</span>
                        </SubmitButton>
                      </form>
                    ) : null}
                    {row.state === "waiting-bot" ? (
                      <form action={newTelegramLinkAction.bind(null, row.id)}>
                        <SubmitButton variant="outline" pendingLabel="Getting…" className="w-auto">
                          Get a new link
                          <span className="sr-only"> for {row.name}</span>
                        </SubmitButton>
                      </form>
                    ) : null}
                    {row.type === "webhook" ? (
                      <Confirming
                        label="Replace the secret"
                        name={row.name}
                        warning={`The current secret stops working now, so ${row.name}'s receiver has to be given the new one.`}
                        action={replaceSecretAction.bind(null, row.id)}
                        button="Replace it"
                        pendingLabel="Replacing…"
                      />
                    ) : null}
                    <Confirming
                      label="Remove"
                      name={row.name}
                      warning={`${row.name} leaves any Action that uses it, and alerts still waiting to go there won't be sent. Item Logs keep what was sent. This can't be undone.`}
                      action={removeDestinationAction.bind(null, row.id)}
                      button="Remove Destination"
                      pendingLabel="Removing…"
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

const typeNames = { email: "Email", webhook: "Webhook", telegram: "Telegram" };

const stateWords: Record<DestinationState, { word: string; lamp: string }> = {
  ready: { word: "Ready", lamp: "bg-ok" },
  confirmed: { word: "Confirmed", lamp: "bg-ok" },
  "waiting-confirmation": { word: "Waiting for confirmation", lamp: "bg-caution" },
  "waiting-bot": { word: "Waiting for the bot", lamp: "bg-caution" },
  unavailable: { word: "Unavailable until the bot is set up", lamp: "bg-caution" },
};

/** No green lamp above a failure, because a lamp is a reading of whether it works. */
function State({ state, failing }: { state: DestinationState; failing: boolean }) {
  const { word, lamp } = stateWords[state];
  return (
    <span className="inline-flex items-center gap-1.5">
      {failing && lamp === "bg-ok" ? null : (
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${lamp}`} />
      )}
      {word}
    </span>
  );
}

/** The one time a webhook secret is shown. A reload doesn't show it again. */
function SecretPanel({ secret, name }: { secret: string; name: string | undefined }) {
  return (
    <section aria-labelledby="secret" className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <h2 id="secret" className="text-title">
        The secret for {name ?? "this webhook"}
      </h2>
      <Notice role="status" className="text-sm">
        Copy it now. Watchdog won&apos;t show it again. Your receiver uses it to check the{" "}
        <code className="font-mono text-[0.8125rem]">X-Watchdog-Signature</code> header on every call.
      </Notice>
      {/* A text box, because Tab, select-all and copy work on it with no JavaScript and from a keyboard. */}
      <textarea
        readOnly
        rows={2}
        aria-labelledby="secret"
        value={secret}
        className={`${textBox} ${dataBox} resize-none py-1.5`}
      />
    </section>
  );
}

/** How to send the bot a code. It works without JavaScript, and the text box copies from a keyboard. */
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
        Link {name} to a Telegram chat
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
            The code in these links works once and expires at <Timestamp at={expiresAt} className="whitespace-nowrap" />.
          </Notice>
          <div className="flex flex-col gap-1 text-sm">
            <p>For a private chat, open this link and press Start:</p>
            <a
              href={`https://t.me/${bot}?start=${code}`}
              target="_blank"
              rel="noreferrer"
              className={`${textLink} self-start font-mono text-[0.8125rem] break-all`}
            >
              {`https://t.me/${bot}?start=${code}`}
            </a>
          </div>
          <p className="text-sm">
            For a group,{" "}
            <a href={`https://t.me/${bot}?startgroup=${code}`} target="_blank" rel="noreferrer" className={textLink}>
              choose it in Telegram
            </a>
            .
          </p>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="telegram-command">Or add @{bot} to the group yourself and send this there:</label>
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
            <Link href="/destinations" prefetch={false} className={textLink}>
              Reload this page
            </Link>{" "}
            after the bot replies. No reply within a minute? Get a new link, which replaces this one, and try again.
          </p>
        </>
      )}
    </section>
  );
}

/** What the last action did. The words are fixed here, and any names come from the Workspace. */
function Outcome({
  added,
  resent,
  missing,
  removed,
  left,
  refused,
  refusedName,
  refusedBySetting,
  mailGoesToLog,
}: {
  added: string;
  resent: string;
  missing: boolean;
  removed: boolean;
  left: string[];
  refused: string[];
  refusedName: string | undefined;
  refusedBySetting: boolean;
  mailGoesToLog: boolean;
}) {
  const quietly = "rounded-lg bg-muted px-3 py-2 text-sm";
  const failed = "rounded-lg bg-destructive/10 px-3 py-2 text-sm text-alarm";
  const where = mailGoesToLog
    ? "This install has no mail server, so the confirmation link is in the web container's log."
    : "A confirmation link is on its way, and it stays waiting until that link is opened. The link lasts 24 hours.";

  if (refusedBySetting) {
    return (
      <Notice role="alert" className={failed}>
        {refusedName ?? "That Destination"} can&apos;t be removed, because it&apos;s the only Destination Source Health
        alerts go to{refused.length > 0 ? `, and the only Destination of ${refused.join(", ")}` : ""}. Choose another
        for them, or untick this one, on <Link href="/settings" className={textLink}>
          Settings
        </Link>{" "}
        first.
        {refused.length > 0
          ? ` Give ${refused.length === 1 ? "that Action" : "those Actions"} another Destination, or disable ${refused.length === 1 ? "it" : "them"}, too.`
          : ""}
      </Notice>
    );
  }
  if (refused.length > 0) {
    return (
      <Notice role="alert" className={failed}>
        {refusedName ?? "That Destination"} can&apos;t be removed, because it&apos;s the only Destination of{" "}
        {refused.join(", ")}. Give {refused.length === 1 ? "that Action" : "those Actions"} another Destination, or
        disable {refused.length === 1 ? "it" : "them"}, first.
      </Notice>
    );
  }
  if (removed) {
    return (
      <Notice role="status" className={quietly}>
        Destination removed.
        {left.length > 0 ? ` ${left.join(", ")} no longer ${left.length === 1 ? "delivers" : "deliver"} there.` : ""}
      </Notice>
    );
  }
  if (missing || resent === "not-found") {
    return (
      <Notice role="alert" className={failed}>
        That Destination wasn&apos;t found in this Workspace.
      </Notice>
    );
  }
  if (added === "not-needed") {
    return (
      <Notice role="status" className={quietly}>
        Destination added. It&apos;s your own address, so it&apos;s confirmed already.
      </Notice>
    );
  }
  if (added === "sent" || resent === "sent") {
    return (
      <Notice role="status" className={quietly}>
        {added === "sent" ? "Destination added. " : ""}
        {where}
      </Notice>
    );
  }
  if (added === "failed" || resent === "failed") {
    return (
      <Notice role="alert" className={failed}>
        {added === "failed" ? "Destination added, but the" : "The"} confirmation mail couldn&apos;t be sent. Try
        &quot;Send the link again&quot; in a moment.
      </Notice>
    );
  }
  if (added === "too-soon" || resent === "too-soon") {
    return (
      <Notice role="status" className={quietly}>
        {added === "too-soon" ? "Destination added. " : ""}A confirmation mail went out from this Workspace less than
        a minute ago, and it sends one a minute. Press &quot;Send the link again&quot; in a minute.
      </Notice>
    );
  }
  return null;
}

/**
 * How the last test went, read from the row: its error is the sender's, written by the test. Keyed by
 * the outcome, so a test that ends differently from the last is announced again.
 */
function TestOutcome({
  tested: { name, type, lastError },
  capped,
  timezone,
  mailGoesToLog,
}: {
  tested: { name: string; type: string; lastError: string | null };
  capped: boolean;
  timezone: string;
  mailGoesToLog: boolean;
}) {
  if (capped) {
    return (
      <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
        The test to {name} wasn&apos;t sent: this Workspace has sent the hosted limit of 50 alert mails for today. Alert
        mail goes out again after midnight, {timezone} time.
      </Notice>
    );
  }
  if (lastError !== null) {
    return (
      <Notice role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-alarm">
        The test to {name} failed: {lastError}. Alerts to it fail the same way until that&apos;s fixed, so fix it and send
        another test.
      </Notice>
    );
  }
  return (
    <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
      Test sent to {name}.
      {type === "email" && mailGoesToLog ? " This install has no mail server, so the mail is in the web container's log." : ""}
    </Notice>
  );
}

function AddForm({ title, open, children }: { title: string; open: boolean; children: React.ReactNode }) {
  return (
    // Display stays the summary's own, because flex would take away the marker that says it opens.
    <details name="add-destination" open={open}>
      <summary className="cursor-pointer rounded-lg border border-transparent px-4 py-3 text-sm font-medium outline-hidden select-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset">
        {title}
      </summary>
      <div className="p-4 pt-2">{children}</div>
    </details>
  );
}

function NameField({
  id,
  value,
  error,
  placeholder = "Team inbox",
}: {
  id: string;
  value: string;
  error: { field: string; message: string } | undefined;
  placeholder?: string;
}) {
  return (
    <TextField
      id={id}
      name="name"
      label="Name"
      type="text"
      placeholder={placeholder}
      value={value}
      error={error?.field === "name" ? error.message : undefined}
      help="Actions refer to it by this name."
    />
  );
}

function TextField({
  id,
  name = id,
  label: title,
  type,
  placeholder,
  value,
  error,
  help,
}: {
  id: string;
  name?: string;
  label: string;
  type: "text" | "email" | "url";
  placeholder: string;
  value: string;
  error: string | undefined;
  help: string;
}) {
  const invalid = error !== undefined;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={label}>
        {title}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required
        maxLength={type === "text" ? 200 : 2048}
        // The name is the Destination's, and "name" alone would have a browser offer the person's own.
        autoComplete={type === "email" ? "email" : "off"}
        spellCheck={false}
        placeholder={placeholder}
        defaultValue={value}
        aria-invalid={invalid}
        aria-describedby={`${id}-${invalid ? "error" : "help"}`}
        // Focus lands here with the error, so the field and its message are read together.
        // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
        autoFocus={invalid}
        className={field}
      />
      {invalid ? (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      ) : (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}
