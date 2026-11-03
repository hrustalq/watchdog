import type { PollSourceDeps } from "@watchdog/core";
import { closeDb, createDb, type Db, eq, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { enqueueDuePolls, pollQueue, startScheduler } from "./scheduler.ts";

const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic</title>
<item><guid>one</guid><title>One</title><description>The first entry.</description></item>
</channel></rss>`;

// No live HTTP: every feed answers from here, after `gate` resolves for that URL if one is set.
const fetched: string[] = [];
const gates = new Map<string, Promise<void>>();
const deps: PollSourceDeps = {
  fetch: async (input) => {
    const url = String(input);
    fetched.push(url);
    await gates.get(url);
    return new Response(feed);
  },
};

const minute = 60 * 1000;

describe("scheduler", () => {
  let postgres: TestPostgres;
  let db: Db;
  let boss: PgBoss;
  let workspaceId: string;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Workspace", ownerUserId: "owner" })
      .returning();
    if (ws === undefined) throw new Error("No workspace");
    workspaceId = ws.id;
    boss = new PgBoss(postgres.url);
    await boss.start();
    await startScheduler(db, boss, "hosted", deps);
    return async () => {
      await boss.stop();
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A new RSS Source at its own URL, due at `nextPollAt` (now by default). */
  async function newSource(nextPollAt?: Date) {
    const url = `https://feeds.test/${crypto.randomUUID()}.rss`;
    const [created] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Feed",
        config: { url },
        schedule: "*/15 * * * *",
        nextPollAt,
      })
      .returning();
    if (created === undefined) throw new Error("No source");
    return { ...created, url };
  }

  const reload = async (id: string) => {
    const found = await db.query.source.findFirst({ where: eq(source.id, id) });
    if (found === undefined) throw new Error("Source is gone");
    return found;
  };

  const pollJobs = async (sourceId: string) =>
    (
      await db.$client.query<{ state: string }>(
        "select state from pgboss.job where name = $1 and singleton_key = $2",
        [pollQueue, sourceId],
      )
    ).rows;

  it("polls a due Source once and moves its next poll to its schedule's next firing", async () => {
    const src = await newSource();
    const before = new Date();
    await enqueueDuePolls(db, boss);

    await vi.waitFor(async () => { expect((await reload(src.id)).lastPolledAt).not.toBeNull(); }, {
      timeout: 15_000,
    });
    const after = await vi.waitFor(async () => {
      const found = await reload(src.id);
      expect(found.nextPollAt.getTime()).toBeGreaterThan(before.getTime());
      return found;
    });
    // The next quarter hour after the poll, plus at most 60 s of jitter.
    const quarter = 15 * minute;
    const nextQuarter = Math.floor(Number(after.lastPolledAt) / quarter + 1) * quarter;
    expect(after.nextPollAt.getTime()).toBeGreaterThanOrEqual(nextQuarter);
    expect(after.nextPollAt.getTime()).toBeLessThanOrEqual(nextQuarter + minute);
    expect(fetched.filter((url) => url === src.url)).toHaveLength(1);
  });

  it("doesn't poll a Source that isn't due yet", async () => {
    const later = await newSource(new Date(Date.now() + 60 * minute));
    const due = await newSource();
    await enqueueDuePolls(db, boss);

    await vi.waitFor(async () => { expect((await reload(due.id)).lastPolledAt).not.toBeNull(); }, {
      timeout: 15_000,
    });
    expect(await pollJobs(later.id)).toEqual([]);
    expect(fetched).not.toContain(later.url);
    expect((await reload(later.id)).lastPolledAt).toBeNull();
  });

  it("queues no second poll of a Source while its poll is running", async () => {
    const src = await newSource();
    const gate = Promise.withResolvers<undefined>();
    gates.set(src.url, gate.promise);

    await enqueueDuePolls(db, boss);
    await vi.waitFor(() => { expect(fetched).toContain(src.url); }, { timeout: 15_000 });
    // The poll is running, and the Source is due again (as it is when two workers' ticks race):
    // two more ticks.
    await db.update(source).set({ nextPollAt: new Date(0) }).where(eq(source.id, src.id));
    await enqueueDuePolls(db, boss);
    await enqueueDuePolls(db, boss);
    expect(await pollJobs(src.id)).toEqual([{ state: "active" }]);

    gate.resolve(undefined);
    await vi.waitFor(async () => { expect(await pollJobs(src.id)).toEqual([{ state: "completed" }]); }, {
      timeout: 15_000,
    });
    expect(fetched.filter((url) => url === src.url)).toHaveLength(1);
  });
});
