import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { starterRulesFor, signInToken } from "@watchdog/core";
import { Notice } from "@/components/notice";
import { PageBar } from "@/components/page-bar";
import { Page, PageHeader } from "@/components/page";
import { PanelList, PanelRow } from "@/components/panel-list";
import { ReplaceHref } from "@/components/replace-href";
import { Section } from "@/components/section";
import { SubmitButton } from "@/components/submit-button";
import { Timestamp } from "@/components/timestamp";
import { buttonVariants } from "@/components/ui/button";
import { textLink } from "@/components/field-classes";
import {
  addProblems as destinationProblems,
  type DestinationState,
  listDestinations,
  problemField as destinationProblemField,
  problemMessage as destinationProblemMessage,
  revealWebhookSecret,
  telegramLinkCookie,
  telegramLinkInCookie,
} from "@/lib/destinations";
import { sourceItemsPage } from "@/lib/feed";
import { declaredFields, ruleNames } from "@/lib/rules";
import { readSentBack } from "@/lib/sent-back";
import { requireWorkspace, server } from "@/lib/server";
import {
  addProblems as sourceProblems,
  addValues,
  guidedSource,
  problemField as sourceProblemField,
  problemMessage as sourceProblemMessage,
  sourceLinkCookie,
  sourceLinkInCookie,
  watchedSourceName,
} from "@/lib/sources";
import {
  doneIn,
  type SkippedStep,
  skippedIn,
  stepFrom,
  stepState,
  type WizardStage,
  type WizardStep,
  withSkipped,
  wizardHref,
} from "@/lib/wizard";
import { EmailDestinationForm, TelegramDestinationForm, WebhookDestinationForm } from "../../destinations/add-forms";
import { SecretPanel } from "../../destinations/secret-panel";
import { AddSourceForm } from "../add-source-form";
import { TelegramLinkPanel } from "../telegram-link-panel";
import {
  addEmailInWizardAction,
  addTelegramInWizardAction,
  addWebhookInWizardAction,
  checkSourceInWizardAction,
  newSourceLinkInWizardAction,
  saveStarterRuleAction,
  saveWizardAlertAction,
} from "./actions";

export const metadata: Metadata = { title: "Set up a watch · Watchdog" };

// Every step's form and outcome are in the first HTML, so the guide works without JavaScript.
export const instant = false;

type Search = Awaited<PageProps<"/sources/new">["searchParams"]>;
type Source = NonNullable<Awaited<ReturnType<typeof guidedSource>>>;

const text = (params: Search, name: string) => {
  const value = params[name];
  return typeof value === "string" ? value : "";
};

const steps: readonly { step: WizardStep; label: string }[] = [
  { step: 1, label: "Source" },
  { step: 2, label: "Items" },
  { step: 3, label: "Rules" },
  { step: 4, label: "Destination" },
];

export default async function GuidedSetupPage({ searchParams }: PageProps<"/sources/new">) {
  const [{ workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const raw = text(params, "step");
  const done = doneIn(raw);
  const step = stepFrom(raw);
  const sourceId = text(params, "source");
  const { db } = server();
  const source = sourceId === "" ? undefined : await guidedSource(db, workspace.id, sourceId);

  // No page-level redirect here: under this app's cacheComponents a page that awaits searchParams
  // and then redirects streams a shell, and a browser without JavaScript would get a blank 200.
  // The earliest step that can run is rendered instead, and a hydrated browser replaces the address.
  const { finished, shown, needsAddress } = stepState({ done, step, hasSource: source !== undefined, raw });
  const skipped = skippedIn(text(params, "skipped"));
  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Workspace" }, { href: "/sources", label: "Sources" }, { label: "Set up a watch" }]} />
      <Page className="break-words">
        {needsAddress ? <ReplaceHref href={wizardHref(finished ? "done" : shown, source?.id, {}, skipped)} /> : null}
        <PageHeader
          title={finished ? "You're set up" : "Set up a watch"}
          description={
            finished
              ? "One Source, and whatever you chose to put behind it. Everything here can be changed later."
              : "Four steps from a Source to an alert. Each step is its own save, so leaving keeps what you did."
          }
        />
        <Progress current={finished ? "done" : shown} sourceId={source?.id} skipped={skipped} />
        <Step params={params} done={finished} shown={shown} source={source} skipped={skipped} />
      </Page>
    </div>
  );
}

/** The one panel the URL names, after the page has checked that the step can run. */
function Step({
  params,
  done,
  shown,
  source,
  skipped,
}: {
  params: Search;
  done: boolean;
  shown: WizardStep;
  source: Source | undefined;
  skipped: readonly SkippedStep[];
}) {
  if (done && source !== undefined) return <FinishStep params={params} source={source} skipped={skipped} />;
  if (source === undefined || shown === 1) return <SourceStep params={params} />;
  if (shown === 2) return <ItemsStep params={params} source={source} skipped={skipped} />;
  if (shown === 3) return <RulesStep params={params} source={source} skipped={skipped} />;
  return <DestinationStep params={params} source={source} skipped={skipped} />;
}

/** The four steps as links: addressable, and only the ones a Source can reach are links. */
function Progress({
  current,
  sourceId,
  skipped,
}: {
  current: WizardStage;
  sourceId: string | undefined;
  skipped: readonly SkippedStep[];
}) {
  const tab =
    "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm font-medium outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60";
  return (
    <nav aria-label="Setup steps" className="overflow-x-auto">
      <ol className="flex w-max gap-1">
        {steps.map(({ step, label }) => {
          const reachable = step === 1 || sourceId !== undefined;
          const open = current === step;
          return (
            <li key={step}>
              {reachable ? (
                <Link
                  href={wizardHref(step, sourceId, {}, skipped)}
                  aria-current={open ? "step" : undefined}
                  className={`${tab} ${open ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                >
                  <span className="tabular-nums">{step}.</span> {label}
                </Link>
              ) : (
                <span aria-disabled="true" className={`${tab} text-muted-foreground/60`}>
                  <span className="tabular-nums">{step}.</span> {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** What moves on from one step to the next, without marking the step skipped. */
function NextLink({ href, children = "Continue" }: { href: string; children?: React.ReactNode }) {
  return (
    <Link href={href} className={buttonVariants({ variant: "outline" })}>
      {children}
    </Link>
  );
}

function StepActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

/** Step 1: the Sources screen's own form, marked so a save moves to step 2. */
async function SourceStep({ params }: { params: Search }) {
  const blank = addValues((name) => (name === "type" ? text(params, "type") : ""));
  const { workspace } = await requireWorkspace();
  const { db, mode, renderers, telegramAvailable } = server();
  const githubSignIn = (await signInToken(db, workspace.id)) !== undefined;
  const problem = sourceProblems.find((known) => known === text(params, "error"));
  // Only a form that was refused reads the draft cookie, as on the Sources screen.
  const sentBack = problem === undefined ? undefined : await readSentBack();
  const values = sentBack === undefined ? blank : addValues((name) => sentBack[name] ?? "");
  const lost = text(params, "too-long") === "" ? "" : " What you entered was too long to bring back, so enter it again.";
  // Only the code travels in the URL, so the Source it's already watched as is looked up.
  const watching = problem === "duplicate" ? await watchedSourceName(db, workspace.id, values) : undefined;
  const shown = { ...values, status: text(params, "status"), mode, source: watching };
  return (
    <Section
      id="step-source"
      title="Add a Source"
      description="Pick what to watch. Saving it creates the Source exactly as the Sources screen does, then moves on."
    >
      <p className="text-sm text-muted-foreground">
        Know what you want?{" "}
        <Link href="/sources#add-source" className={textLink}>
          Add without the guide
        </Link>
        .
      </p>
      <AddSourceForm
        next="wizard"
        values={values}
        githubSignIn={githubSignIn}
        mode={mode}
        renderers={renderers}
        telegramAvailable={telegramAvailable}
        tokenDropped={text(params, "pasted") !== ""}
        error={
          problem === undefined
            ? undefined
            : { field: sourceProblemField(problem, values.type, values), message: sourceProblemMessage(problem, shown) + lost }
        }
      />
    </Section>
  );
}

/** Step 2: the first Items a polled Source captured, or the one-time setup a push Source needs. */
function ItemsStep({ params, source, skipped }: { params: Search; source: Source; skipped: readonly SkippedStep[] }) {
  const next = wizardHref(3, source.id, {}, skipped);
  if (source.type === "webhook") {
    const query = new URLSearchParams({ wizard: "1" });
    if (skipped.length > 0) query.set("skipped", skipped.join(","));
    return (
      <Section
        id="step-items"
        title="The inbox URL"
        description="A webhook inbox has no Backfill: each POST of JSON becomes one Item as it arrives."
      >
        <p className="text-sm">
          Its URL holds the only proof a request is meant for it, so it is shown once, on its own screen. Open it, copy the
          URL to whatever sends to Watchdog, then carry on here.
        </p>
        <StepActions>
          <Link href={`/sources/${source.id}/inbox?${query.toString()}`} className={buttonVariants({ variant: "outline" })}>
            Open the inbox URL
          </Link>
          <NextLink href={next}>Continue</NextLink>
          <Link href={wizardHref(3, source.id, {}, withSkipped(skipped, "items"))} className={textLink}>
            Skip for now
          </Link>
        </StepActions>
      </Section>
    );
  }
  if (source.type === "telegram") {
    return <TelegramItemsStep source={source} skipped={skipped} />;
  }
  return <PolledItemsStep params={params} source={source} skipped={skipped} />;
}

async function TelegramItemsStep({ source, skipped }: { source: Source; skipped: readonly SkippedStep[] }) {
  const { db, telegramAvailable } = server();
  const session = "via" in source.config && source.config.via === "session";
  const link =
    !session && telegramAvailable
      ? await sourceLinkInCookie(db, [source], (await cookies()).get(sourceLinkCookie)?.value)
      : undefined;
  const pending = link?.status === "pending" ? link : undefined;
  const bot = pending === undefined ? undefined : await server().telegramBotName();
  const linked = "chatId" in source.config && source.health !== "failing";
  const title = "title" in source.config && typeof source.config.title === "string" ? source.config.title : undefined;
  return (
    <Section
      id="step-items"
      title={session ? "The chat" : "Link the chat"}
      description={
        session
          ? "A Telegram Source has no Backfill. Watchdog reads this chat through your account and captures each message posted after it signed in."
          : "A Telegram Source has no Backfill: the bot captures each message posted after it joins."
      }
    >
      {session ? (
        <SessionNotice failing={source.health === "failing"} title={title} />
      ) : (
        <TelegramSetup
          linked={linked}
          title={title}
          available={telegramAvailable}
          pending={pending}
          bot={bot}
          sourceId={source.id}
          skipped={skipped}
        />
      )}
      <StepActions>
        <NextLink href={wizardHref(3, source.id, {}, skipped)}>Continue</NextLink>
        <Link href={wizardHref(3, source.id, {}, withSkipped(skipped, "items"))} className={textLink}>
          Skip for now
        </Link>
      </StepActions>
    </Section>
  );
}

/** A Source that reads through the user's Telegram account rather than the bot. */
function SessionNotice({ failing, title }: { failing: boolean; title: string | undefined }) {
  if (failing) {
    return (
      <Notice role="alert" tone="failed">
        Watchdog lost access to {title ?? "this chat"} through your Telegram account.{" "}
        <Link href="/sources/telegram" className={textLink}>
          Sign in again
        </Link>{" "}
        and its polls resume.
      </Notice>
    );
  }
  return (
    <Notice role="status">
      This chat is watched through your Telegram account{title === undefined ? "" : ` (${title})`}. Watchdog reads it
      without the bot.
    </Notice>
  );
}

/** What the Telegram step shows: linked, a link to use, a way to get one, or no bot at all. */
function TelegramSetup({
  linked,
  title,
  available,
  pending,
  bot,
  sourceId,
  skipped,
}: {
  linked: boolean;
  title: string | undefined;
  available: boolean;
  pending: { name: string; code: string; expiresAt: Date } | undefined;
  bot: string | undefined;
  sourceId: string;
  skipped: readonly SkippedStep[];
}) {
  if (linked) {
    return <Notice role="status">The bot is in {title ?? "the chat"}. Each message posted there shows up in the Feed.</Notice>;
  }
  if (!available) {
    return (
      <Notice role="alert" tone="alarm">
        Telegram isn&apos;t set up on this install, so this Source can&apos;t be linked. Whoever runs this Watchdog can set{" "}
        <code className="text-data">TELEGRAM_BOT_TOKEN</code>.
      </Notice>
    );
  }
  if (pending === undefined) {
    return (
      <>
        <p className="text-sm">No link is showing for this Source here. Get one, then use it to bring the bot into a chat.</p>
        <form action={newSourceLinkInWizardAction.bind(null, sourceId)}>
          <input type="hidden" name="skipped" value={skipped.join(",")} />
          <SubmitButton variant="outline" pendingLabel="Getting a link…">
            Get a link
          </SubmitButton>
        </form>
      </>
    );
  }
  return (
    <TelegramLinkPanel
      link={pending}
      bot={bot}
      reloadHref={wizardHref(2, sourceId, { refreshed: "1" }, skipped)}
      continueHref={wizardHref(3, sourceId, {}, skipped)}
    />
  );
}

async function PolledItemsStep({ params, source, skipped }: { params: Search; source: Source; skipped: readonly SkippedStep[] }) {
  const { workspace } = await requireWorkspace();
  const { db } = server();
  const items = await sourceItemsPage(db, workspace.id, source.id);
  const next = wizardHref(3, source.id, {}, skipped);
  return (
    <Section
      id="step-items"
      title="Its first Items"
      description="The first poll runs within a minute. Its recent entries arrive together as the Backfill."
    >
      {text(params, "checked") === "" ? null : (
        <Notice role="status">
          The poll is due. The worker usually runs it within a minute, then Refresh this step to see what it captured.
        </Notice>
      )}
      {text(params, "check-later") === "" ? null : (
        <Notice role="status">
          Watchdog didn&apos;t ask for a poll: its last one may be too recent, or GitHub&apos;s rate limit holds it. Refresh in a
          minute.
        </Notice>
      )}
      {source.type === "website" ? (
        <p className="text-sm text-muted-foreground">
          A website has no Backfill. The first poll keeps the page as its Baseline, and an Item appears when the page
          changes.
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Items yet. {source.lastError === null ? "The first poll runs within a minute." : `The last poll failed: ${source.lastError}`}
        </p>
      ) : (
        <PanelList>
          {items.map((row) => (
            <PanelRow key={row.id}>
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="text-title min-w-0 break-words">
                  <Link href={`/items/${row.id}`} className={textLink}>
                    {row.title ?? "Untitled Item"}
                  </Link>
                </h3>
                <p className="text-sm text-muted-foreground">
                  {row.publishedAt === null ? (
                    <>
                      Captured <Timestamp at={row.capturedAt} />
                    </>
                  ) : (
                    <Timestamp at={row.publishedAt} />
                  )}
                  {row.isBackfill ? " · Backfill" : null}
                </p>
              </div>
            </PanelRow>
          ))}
        </PanelList>
      )}
      <StepActions>
        {source.schedule === null ? null : (
          <form action={checkSourceInWizardAction.bind(null, source.id)}>
            <input type="hidden" name="skipped" value={skipped.join(",")} />
            <SubmitButton variant="outline" pendingLabel="Asking…">
              Check now
            </SubmitButton>
          </form>
        )}
        <Link href={wizardHref(2, source.id, { refreshed: "1" }, skipped)} prefetch={false} className={textLink}>
          Refresh
        </Link>
        <NextLink href={next}>Continue</NextLink>
        <Link href={wizardHref(3, source.id, {}, withSkipped(skipped, "items"))} className={textLink}>
          Skip for now
        </Link>
      </StepActions>
    </Section>
  );
}

/** Step 3: a short list of starter rules, each one click from being a real rule. */
async function RulesStep({ params, source, skipped }: { params: Search; source: Source; skipped: readonly SkippedStep[] }) {
  const { workspace } = await requireWorkspace();
  const { db } = server();
  const [declared, names] = await Promise.all([declaredFields(db, workspace.id), ruleNames(db, workspace.id)]);
  const starters = starterRulesFor(source, {
    declaredFields: declared.map(({ name }) => name),
    existingNames: names,
  });
  const saved = text(params, "saved") !== "";
  const refused = text(params, "refused") === "" ? undefined : await readSentBack();
  const next = wizardHref(4, source.id, {}, skipped);
  return (
    <Section
      id="step-rules"
      title="Starter rules"
      description="Each is an ordinary rule on this Source, ready to edit on the Rules screen afterwards. Nothing runs until you add it."
    >
      {saved ? <Notice role="status">Rule saved. It applies to Items captured from now on.</Notice> : null}
      {refused?.error === undefined ? null : (
        <Notice role="alert" tone="failed">
          {refused.error}
        </Notice>
      )}
      {starters.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Every starter rule for this kind of Source is already in this Workspace. Open the rule editor to add another.
        </p>
      ) : (
        <PanelList>
          {starters.map((rule) => (
            <PanelRow key={rule.key}>
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="text-title break-words">{rule.name}</h3>
                <p className="text-sm text-muted-foreground">{rule.description}</p>
              </div>
              <form action={saveStarterRuleAction.bind(null, source.id, rule.key)}>
                <input type="hidden" name="skipped" value={skipped.join(",")} />
                <SubmitButton variant="outline" pendingLabel="Adding…">
                  Add rule<span className="sr-only"> {rule.name}</span>
                </SubmitButton>
              </form>
            </PanelRow>
          ))}
        </PanelList>
      )}
      <StepActions>
        <NextLink href={next}>Continue</NextLink>
        <Link href="/rules/new" className={buttonVariants({ variant: "outline" })}>
          Open the rule editor
        </Link>
        <Link href={wizardHref(4, source.id, {}, withSkipped(skipped, "rules"))} className={textLink}>
          Skip for now
        </Link>
      </StepActions>
    </Section>
  );
}

/** Step 4: the Destinations screen's forms, then the one Action the guide offers. */
async function DestinationStep({ params, source, skipped }: { params: Search; source: Source; skipped: readonly SkippedStep[] }) {
  const { workspace } = await requireWorkspace();
  const { db, telegramAvailable, telegramBotName, mailGoesToLog } = server();
  const destinations = await listDestinations(db, workspace.id, { telegramAvailable });
  const form = text(params, "form");
  const addedMail = text(params, "added");
  const problem = destinationProblems.find((known) => known === text(params, "error"));
  const error =
    problem === undefined
      ? undefined
      : { field: destinationProblemField(problem), message: destinationProblemMessage(problem, server().mode) };
  const telegram = await telegramLinkInCookie(db, destinations, (await cookies()).get(telegramLinkCookie)?.value);
  const added = destinations.find(({ id }) => id === text(params, "destination"));
  const refused = text(params, "refused") === "" ? undefined : await readSentBack();
  const finish = wizardHref("done", source.id, added === undefined ? {} : { destination: added.id }, skipped);
  // Last, because a read that fails after this would lose a secret nobody saw.
  const secret =
    added === undefined || text(params, "secret") !== added.id
      ? undefined
      : await revealWebhookSecret(db, server().encryptionKey, workspace.id, added.id);
  const bot = telegram?.status === "pending" ? await telegramBotName() : undefined;
  const telegramPending = added?.type === "telegram" && telegram?.id === added.id && telegram.status === "pending";
  const hidden = <input type="hidden" name="skipped" value={skipped.join(",")} />;

  return (
    <>
      {secret === undefined ? null : <SecretPanel secret={secret} name={added?.name} />}
      {added === undefined ? null : (
        <Notice role="status">
          Destination added.
          {added.state === "waiting-confirmation"
            ? " Check its address for the link that confirms it; it receives nothing until then."
            : null}
          {added.state === "waiting-bot" && telegramPending ? " Open the link below to bring the bot into a chat." : null}
          {added.state === "waiting-bot" && !telegramPending
            ? " Its row on Destinations has Get a new link, to bring the bot into a chat."
            : null}
          {added.state === "ready" || added.state === "confirmed" ? " It can receive now." : null}
          {addedMail === "sent" && mailGoesToLog
            ? " This install has no mail server, so the confirmation link is in the web container's log."
            : null}
          {addedMail === "sent" && !mailGoesToLog ? " A confirmation link is on its way." : null}
          {addedMail === "too-soon"
            ? " A confirmation mail went out less than a minute ago; send it again from Destinations in a minute."
            : null}
        </Notice>
      )}
      {added !== undefined && addedMail === "failed" ? (
        <Notice role="alert" tone="failed">
          The confirmation mail for {added.name} couldn&apos;t be sent.{" "}
          <Link href="/destinations" className={textLink}>
            Send it again from Destinations
          </Link>
          .
        </Notice>
      ) : null}
      {added !== undefined && added.type === "webhook" && text(params, "secret") !== "" && secret === undefined ? (
        <Notice role="status">
          The secret for {added.name} was already shown.{" "}
          <Link href="/destinations" className={textLink}>
            Replace it on Destinations
          </Link>{" "}
          if you didn&apos;t keep a copy.
        </Notice>
      ) : null}
      {refused?.error === undefined ? null : (
        <Notice role="alert" tone="failed">
          {refused.error}
        </Notice>
      )}
      {added !== undefined && telegramPending ? (
        <TelegramLinkPanel
          link={telegram}
          bot={bot}
          reloadHref={wizardHref(4, source.id, { destination: added.id }, skipped)}
        />
      ) : null}
      {added === undefined ? (
        <Section
          id="step-destination"
          title="Add a Destination"
          description="Where an alert goes. Email confirmation and Telegram linking finish outside this guide, so skipping this step is fine."
        >
          <PanelList as="div">
            <EmailDestinationForm
              action={addEmailInWizardAction.bind(null, source.id)}
              open={form === "email" || form === ""}
              values={{ name: form === "email" ? text(params, "name") : "", address: form === "email" ? text(params, "address") : "" }}
              error={form === "email" ? error : undefined}
              hidden={hidden}
            />
            <WebhookDestinationForm
              action={addWebhookInWizardAction.bind(null, source.id)}
              open={form === "webhook"}
              values={{ name: form === "webhook" ? text(params, "name") : "" }}
              error={form === "webhook" ? error : undefined}
              hidden={hidden}
            />
            <TelegramDestinationForm
              action={addTelegramInWizardAction.bind(null, source.id)}
              open={form === "telegram"}
              values={{ name: form === "telegram" ? text(params, "name") : "" }}
              error={form === "telegram" ? error : undefined}
              hidden={hidden}
              available={telegramAvailable}
            />
          </PanelList>
          <StepActions>
            <NextLink href={wizardHref("done", source.id, {}, withSkipped(skipped, "destination"))}>Skip for now</NextLink>
          </StepActions>
        </Section>
      ) : (
        <Section
          id="step-alert"
          title="Alert me when Importance ≥ 4"
          description="The one Action this guide creates. It is saved enabled and uses this Destination; you can edit it on Rules afterwards."
        >
          {added.type === "webhook" ? (
            <p className="text-sm text-muted-foreground">
              A webhook Destination takes a webhook Action, which this guide doesn&apos;t create. Send it a test from
              Destinations, or write a webhook Action on Rules.
            </p>
          ) : (
            <form action={saveWizardAlertAction.bind(null, source.id, added.id)}>
              <input type="hidden" name="skipped" value={skipped.join(",")} />
              <SubmitButton pendingLabel="Saving…">Create the alert</SubmitButton>
            </form>
          )}
          <StepActions>
            <NextLink href={finish}>{added.type === "webhook" ? "Finish" : "Finish without an alert"}</NextLink>
          </StepActions>
        </Section>
      )}
    </>
  );
}

/** The finish screen: what now exists, what still needs a person, and where to go next. */
async function FinishStep({
  params,
  source,
  skipped,
}: {
  params: Search;
  source: Source;
  skipped: readonly SkippedStep[];
}) {
  const { workspace } = await requireWorkspace();
  const { db, telegramAvailable } = server();
  const destinations = await listDestinations(db, workspace.id, { telegramAvailable });
  const destination = destinations.find(({ id }) => id === text(params, "destination"));
  const alerted = text(params, "alerted") !== "";
  return (
    <>
      <Section id="step-done" title={`${source.name} is watching`} tone="raised">
        <PanelList>
          <PanelRow>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-title break-words">
                <Link href={`/sources#source-${source.id}`} className={textLink}>
                  Open {source.name} in Sources
                </Link>
              </h3>
              <p className="text-sm text-muted-foreground">Its row has Check now, its Health and its last poll.</p>
            </div>
          </PanelRow>
          <PanelRow>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-title">
                <Link href="/" className={textLink}>
                  Open the Feed
                </Link>
              </h3>
              <p className="text-sm text-muted-foreground">Every Item it captures shows up here, with its Categories as rules run.</p>
            </div>
          </PanelRow>
          <PanelRow>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-title">
                <Link href="/rules" className={textLink}>
                  Open Rules
                </Link>
              </h3>
              <p className="text-sm text-muted-foreground">Everything the guide saved is an ordinary rule you can edit there.</p>
            </div>
          </PanelRow>
        </PanelList>
      </Section>
      <Section id="step-left" title="What's left">
        {skipped.includes("items") ? <p className="text-sm">You skipped the Items step. Its Items still arrive in the Feed on their own.</p> : null}
        {skipped.includes("rules") ? (
          <p className="text-sm">You skipped the Rules step, so Items stay unclassified until you add a rule.</p>
        ) : null}
        {skipped.includes("destination") ? (
          <p className="text-sm">You skipped the Destination step, so an alert has nowhere to go yet.</p>
        ) : null}
        {destination === undefined ? null : <p className="text-sm">{destinationLeft(destination)}</p>}
        {alerted ? <p className="text-sm">An Action alerts you when Importance is at least 4.</p> : null}
        {!alerted && destination !== undefined && destination.type !== "webhook" ? (
          <p className="text-sm">No alert was created. Add one on Rules whenever you like.</p>
        ) : null}
        {skipped.length === 0 && destination?.state !== "waiting-confirmation" && destination?.state !== "waiting-bot" && alerted ? (
          <p className="text-sm text-muted-foreground">Nothing else is needed.</p>
        ) : null}
      </Section>
    </>
  );
}

/** What the added Destination still needs, in the words of the screen that owns that step. */
function destinationLeft({ name, type, state }: { name: string; type: string; state: DestinationState }) {
  if (state === "waiting-confirmation")
    return (
      <>
        Confirm the email Destination {name}: open the link in its mail, or{" "}
        <Link href="/destinations" className={textLink}>
          send it again from Destinations
        </Link>
        .
      </>
    );
  if (state === "waiting-bot") return <>Link the Telegram chat {name}: the code from the last step is still there.</>;
  if (type === "webhook") return <>Send a test to {name} from Destinations, so its receiver is known to work.</>;
  return <>{name} can receive now.</>;
}
