// A test alert from the Destinations screen (docs: Actions and delivery, "Testing a Destination"). It goes
// through the senders real alerts use, now and once, so it isn't queued, held or retried.
import { type Db, destination, eq, type Tx, workspace } from "@watchdog/db";
import { alertContent, type WebhookMessage } from "./content.ts";
import { type DeliverDeps, type Destination, failureReason, recordSentMessage } from "./deliver.ts";
import { emailCapEnd, takeEmailCapTurn } from "./email-cap.ts";

export interface TestAlertDeps {
  senders: DeliverDeps["senders"];
  appUrl: string;
  /** Hosted counts alert mail against its daily cap, and a test is one. */
  emailCapped: boolean;
}

export type TestAlertResult = { status: "sent" } | { status: "failed"; reason: string } | { status: "capped" };

const why = "Send a test was pressed on the Destinations screen";
const example = {
  id: "00000000-0000-0000-0000-000000000000",
  title: "Test alert from Watchdog",
  summary: "Real alerts look like this, with the Item's title, Source, Rating and summary, and why the Action fired.",
  severity: 3,
  importance: 3,
};

/** The example Item as an alert, linking to Watchdog itself, because the Item doesn't exist. */
function exampleAlert(appUrl: string) {
  return { ...alertContent(example, "Watchdog", why, appUrl), link: new URL("/", appUrl).href };
}

/** A new Item id each time, so a receiver that drops repeated ids still takes every test. */
function exampleWebhook(): WebhookMessage {
  return {
    action: "Send a test",
    item: {
      id: crypto.randomUUID(),
      sourceId: example.id,
      externalId: "test-alert",
      url: null,
      title: example.title,
      author: null,
      body: example.summary,
      publishedAt: null,
      capturedAt: new Date(),
      language: "en",
      isBackfill: false,
      summary: example.summary,
    },
    rating: { severity: example.severity, importance: example.importance },
    categories: [],
    fields: {},
    firedBecause: why,
  };
}

async function attempt(
  target: Destination,
  deps: TestAlertDeps,
  recording: (write: (tx: Tx) => Promise<void>) => Promise<void>,
): Promise<TestAlertResult> {
  try {
    await (target.type === "webhook"
      ? deps.senders.webhook.send(target, exampleWebhook())
      : deps.senders[target.type].send(target, exampleAlert(deps.appUrl)));
  } catch (error) {
    const reason = failureReason(error);
    await recording(async (tx) => {
      await tx.update(destination).set({ lastError: reason, lastErrorAt: new Date() }).where(eq(destination.id, target.id));
    });
    return { status: "failed", reason };
  }
  await recording(async (tx) => {
    await recordSentMessage(tx, target, new Date());
    await tx.update(destination).set({ lastError: null, lastErrorAt: null }).where(eq(destination.id, target.id));
  });
  return { status: "sent" };
}

/**
 * Sends the example alert to a Destination and records the outcome on its `last_error`. It counts against
 * the rate limit and the hosted email cap like an alert, and a mail the cap would hold isn't sent. A
 * capped mail holds the Workspace's mail turn through the send, as a Delivery does, so two can't both
 * take the 50th place. Anything else holds no connection through the send.
 */
export async function sendTestAlert(db: Db, target: Destination, deps: TestAlertDeps): Promise<TestAlertResult> {
  if (target.type !== "email" || !deps.emailCapped) {
    return attempt(target, deps, (write) => db.transaction(write));
  }
  return db.transaction(async (tx) => {
    await takeEmailCapTurn(tx, target.workspaceId);
    const [settings] = await tx.select().from(workspace).where(eq(workspace.id, target.workspaceId));
    if (settings !== undefined && (await emailCapEnd(tx, settings, new Date())) !== undefined) return { status: "capped" };
    return attempt(target, deps, (write) => write(tx));
  });
}
