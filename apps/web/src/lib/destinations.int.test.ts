import { randomBytes } from "node:crypto";
import {
  action,
  actionDestination,
  closeDb,
  createDb,
  type Db,
  delivery,
  destination,
  destinationConfirmation,
  eq,
  item,
  itemLog,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { decryptSecret, egressPolicy } from "@watchdog/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  actionNames,
  actionsOnlyOn,
  addEmailDestination,
  addWebhookDestination,
  confirmDestination,
  type DestinationDeps,
  listDestinations,
  removeDestination,
  replaceWebhookSecret,
  revealWebhookSecret,
  sendConfirmationAgain,
} from "./destinations.ts";

const sent: { to: string; subject: string; text: string; from?: string | undefined }[] = [];
const deps: DestinationDeps = {
  mailer: {
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  },
  alertFrom: "alerts@example.com",
  baseURL: "http://localhost:3000",
  encryptionKey: randomBytes(32),
  egressAllows: egressPolicy({ mode: "hosted", egressAllowlist: [] }),
};
const owner = { email: "us@example.com", emailVerified: true };

/** The token in the link of the last mail, as the person who opens it gets it. */
const lastToken = () => {
  const link = /http\S+/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "";
  const url = new URL(link);
  expect(url.pathname).toBe("/destinations/confirm");
  return url.searchParams.get("token") ?? "";
};

describe("Destinations", () => {
  let db: Db;
  let ours = "";
  let theirs = "";
  let named = 0;
  const newName = () => {
    named += 1;
    return `Destination ${String(named)}`;
  };
  const stateOf = async (id: string) =>
    (await listDestinations(db, ours, { telegramAvailable: true })).find((row) => row.id === id)?.state;
  const addEmail = async (address = "team@example.com") => {
    const result = await addEmailDestination(db, deps, ours, owner, { name: newName(), address });
    if (result.destination === undefined) throw new Error(`Not added: ${result.problem}`);
    return result;
  };

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values([
      { id: "us", name: "Us", email: "us@example.com" },
      { id: "them", name: "Them", email: "them@example.com" },
    ]);
    const [a, b] = await db
      .insert(workspace)
      .values([
        { name: "Ours", ownerUserId: "us" },
        { name: "Theirs", ownerUserId: "them" },
      ])
      .returning();
    ours = a?.id ?? "";
    theirs = b?.id ?? "";
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  describe("an email Destination", () => {
    it("waits for confirmation until its link is used, and then is confirmed", async () => {
      const added = await addEmail();
      expect(added.mail).toBe("sent");
      expect(await stateOf(added.destination.id)).toBe("waiting-confirmation");
      expect(sent.at(-1)).toMatchObject({ to: "team@example.com", from: "alerts@example.com" });

      expect(await confirmDestination(db, lastToken())).toBe(true);
      expect(await stateOf(added.destination.id)).toBe("confirmed");
    });

    it("stores only a hash of the token", async () => {
      const added = await addEmail();
      const [stored] = await db
        .select()
        .from(destinationConfirmation)
        .where(eq(destinationConfirmation.destinationId, added.destination.id));
      expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.tokenHash).not.toBe(lastToken());
    });

    it("confirms once: a used link does nothing", async () => {
      await addEmail();
      const token = lastToken();
      expect(await confirmDestination(db, token)).toBe(true);
      expect(await confirmDestination(db, token)).toBe(false);
    });

    it("refuses an expired link and stays waiting", async () => {
      const added = await addEmail();
      const token = lastToken();
      await db
        .update(destinationConfirmation)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(destinationConfirmation.destinationId, added.destination.id));

      expect(await confirmDestination(db, token)).toBe(false);
      expect(await stateOf(added.destination.id)).toBe("waiting-confirmation");
    });

    it("refuses a token nobody issued", async () => {
      expect(await confirmDestination(db, "not-a-token")).toBe(false);
    });

    it("confirms the account's own verified address at once, without a mail", async () => {
      const before = sent.length;
      const added = await addEmail("US@example.com");
      expect(added.mail).toBe("not-needed");
      expect(sent).toHaveLength(before);
      expect(await stateOf(added.destination.id)).toBe("confirmed");
    });

    it("asks an account whose own address isn't verified to confirm it", async () => {
      const before = sent.length;
      const result = await addEmailDestination(
        db,
        deps,
        ours,
        { email: "us@example.com", emailVerified: false },
        { name: newName(), address: "us@example.com" },
      );
      expect(result).toMatchObject({ mail: "sent" });
      expect(sent).toHaveLength(before + 1);
    });

    it.each(["not-an-address", "a@example.com, b@example.com", ""])("refuses the address %j", async (address) => {
      const result = await addEmailDestination(db, deps, ours, owner, { name: newName(), address });
      expect(result).toEqual({ problem: "invalid-address" });
    });

    it("refuses a blank name and a name the Workspace already uses", async () => {
      expect(await addEmailDestination(db, deps, ours, owner, { name: "  ", address: "a@example.com" })).toEqual({
        problem: "blank-name",
      });
      const name = newName();
      await addEmailDestination(db, deps, ours, owner, { name, address: "a@example.com" });
      expect(await addEmailDestination(db, deps, ours, owner, { name, address: "b@example.com" })).toEqual({
        problem: "duplicate-name",
      });
    });

    it("keeps the Destination when the mail fails, and the link can be sent again at once", async () => {
      const failing: DestinationDeps = {
        ...deps,
        mailer: { send: () => Promise.reject(new Error("the server said no")) },
      };
      const result = await addEmailDestination(db, failing, ours, owner, { name: newName(), address: "a@example.com" });
      if (!("destination" in result)) throw new Error("Not added");
      expect(result.mail).toBe("failed");
      expect(await stateOf(result.destination.id)).toBe("waiting-confirmation");

      expect(await sendConfirmationAgain(db, deps, ours, result.destination.id)).toBe("sent");
    });

    it("sends the link again with a new token, which replaces the old one", async () => {
      const added = await addEmail();
      const first = lastToken();
      await db
        .update(destinationConfirmation)
        .set({ expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000) })
        .where(eq(destinationConfirmation.destinationId, added.destination.id));

      expect(await sendConfirmationAgain(db, deps, ours, added.destination.id)).toBe("sent");
      expect(await confirmDestination(db, first)).toBe(false);
      expect(await confirmDestination(db, lastToken())).toBe(true);
    });

    it("sends at most one link a minute to a Destination", async () => {
      const added = await addEmail();
      const before = sent.length;
      expect(await sendConfirmationAgain(db, deps, ours, added.destination.id)).toBe("too-soon");
      expect(sent).toHaveLength(before);
    });

    it("sends nothing for a confirmed Destination or another Workspace's", async () => {
      const added = await addEmail();
      expect(await sendConfirmationAgain(db, deps, theirs, added.destination.id)).toBe("not-found");
      await confirmDestination(db, lastToken());
      expect(await sendConfirmationAgain(db, deps, ours, added.destination.id)).toBe("not-found");
    });

    it("shows a Telegram Destination's state from whether the bot is set up", async () => {
      const [row] = await db
        .insert(destination)
        .values({ workspaceId: ours, type: "telegram", name: newName() })
        .returning({ id: destination.id });
      const id = row?.id ?? "";
      expect(await stateOf(id)).toBe("waiting-bot");
      const without = await listDestinations(db, ours, { telegramAvailable: false });
      expect(without.find((listed) => listed.id === id)?.state).toBe("unavailable");
    });
  });

  describe("a webhook Destination", () => {
    const addWebhook = async (url = "https://hooks.example.com/watchdog") => {
      const result = await addWebhookDestination(db, deps, ours, { name: newName(), url });
      if (!("destination" in result)) throw new Error(`Not added: ${result.problem}`);
      return result.destination.id;
    };

    it("shows its secret exactly once, and stores only ciphertext", async () => {
      const id = await addWebhook();
      const secret = await revealWebhookSecret(db, deps.encryptionKey, ours, id);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(await revealWebhookSecret(db, deps.encryptionKey, ours, id)).toBeUndefined();

      const [stored] = await db.select().from(destination).where(eq(destination.id, id));
      expect(stored?.secretCiphertext).not.toContain(secret);
      expect(decryptSecret(stored?.secretCiphertext ?? "", deps.encryptionKey)).toBe(secret);
    });

    it("is ready at once, and shows no secret in its list row", async () => {
      const id = await addWebhook();
      const row = (await listDestinations(db, ours, { telegramAvailable: true })).find((listed) => listed.id === id);
      expect(row).toMatchObject({ state: "ready", pointsAt: "https://hooks.example.com/watchdog" });
      expect(JSON.stringify(row)).not.toContain("secret");
    });

    it("shows a replaced secret once, and the old one no longer works", async () => {
      const id = await addWebhook();
      const first = await revealWebhookSecret(db, deps.encryptionKey, ours, id);
      expect(await replaceWebhookSecret(db, deps.encryptionKey, ours, id)).toBe(true);
      const second = await revealWebhookSecret(db, deps.encryptionKey, ours, id);
      expect(second).toMatch(/^[0-9a-f]{64}$/);
      expect(second).not.toBe(first);
      expect(await revealWebhookSecret(db, deps.encryptionKey, ours, id)).toBeUndefined();
    });

    it.each([
      ["http://127.0.0.1/hook", "blocked"],
      ["http://[::1]/hook", "blocked"],
      ["http://2130706433/hook", "blocked"],
      ["http://169.254.169.254/latest", "blocked"],
      ["ftp://example.com/hook", "invalid-url"],
      ["javascript:alert(1)", "invalid-url"],
      ["https://user:pass@example.com/hook", "invalid-url"],
      ["not a url", "invalid-url"],
    ])("refuses %s", async (url, problem) => {
      expect(await addWebhookDestination(db, deps, ours, { name: newName(), url })).toEqual({ problem });
    });

    it("takes a private address the self-hosted allowlist lets through", async () => {
      const allowing: DestinationDeps = {
        ...deps,
        egressAllows: egressPolicy({
          mode: "self-hosted",
          egressAllowlist: [{ type: "subnet", address: "10.0.0.0", prefix: 8, family: "ipv4" }],
        }),
      };
      const result = await addWebhookDestination(db, allowing, ours, { name: newName(), url: "http://10.0.0.5/hook" });
      expect(result).toHaveProperty("destination");
    });

    it("refuses a duplicate name", async () => {
      const name = newName();
      await addWebhookDestination(db, deps, ours, { name, url: "https://a.example.com" });
      expect(await addWebhookDestination(db, deps, ours, { name, url: "https://b.example.com" })).toEqual({
        problem: "duplicate-name",
      });
    });

    it("keeps its secret from another Workspace", async () => {
      const id = await addWebhook();
      expect(await revealWebhookSecret(db, deps.encryptionKey, theirs, id)).toBeUndefined();
      expect(await replaceWebhookSecret(db, deps.encryptionKey, theirs, id)).toBe(false);
      expect(await revealWebhookSecret(db, deps.encryptionKey, ours, id)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("treats a malformed id as a missing Destination", async () => {
      expect(await revealWebhookSecret(db, deps.encryptionKey, ours, "not-a-uuid")).toBeUndefined();
      expect(await replaceWebhookSecret(db, deps.encryptionKey, ours, "not-a-uuid")).toBe(false);
    });
  });

  describe("removing a Destination", () => {
    const addWebhook = async () => {
      const result = await addWebhookDestination(db, deps, ours, { name: newName(), url: "https://a.example.com" });
      if (!("destination" in result)) throw new Error("Not added");
      return { id: result.destination.id };
    };
    /** An Action pointing at these Destinations, saved long enough ago for an Item captured now. */
    const addAction = async (name: string, destinations: string[], enabled = true) => {
      const [saved] = await db
        .insert(action)
        .values({
          workspaceId: ours,
          name,
          kind: "alert",
          enabled,
          definition: { action: name, when: { field: "title", op: "contains", value: "x" }, kind: "alert", destinations },
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: action.id });
      const id = saved?.id ?? "";
      await db.insert(actionDestination).values(destinations.map((destinationId) => ({ actionId: id, destinationId })));
      return id;
    };
    const anItem = async () => {
      const [feed] = await db
        .insert(source)
        .values({ workspaceId: ours, type: "rss", name: newName(), config: { url: `https://a.example.com/${newName()}` }, schedule: "0 * * * *" })
        .returning({ id: source.id });
      const [captured] = await db
        .insert(item)
        .values({ workspaceId: ours, sourceId: feed?.id ?? "", externalId: "one", title: "An Item", body: "A body", raw: {} })
        .returning({ id: item.id });
      return captured?.id ?? "";
    };
    const definitionOf = async (id: string) => {
      const [row] = await db.select().from(action).where(eq(action.id, id));
      return row;
    };

    it("is refused, naming the Action, while an enabled Action points only at it", async () => {
      const { id } = await addWebhook();
      await addAction("Only here", [id]);
      expect(await removeDestination(db, ours, id)).toEqual({ refused: ["Only here"] });
      expect(await actionsOnlyOn(db, ours, id)).toEqual(["Only here"]);
      expect(await db.select().from(destination).where(eq(destination.id, id))).toHaveLength(1);
    });

    it("leaves an Action that has another Destination, and says which changed", async () => {
      const [{ id }, other] = [await addWebhook(), await addWebhook()];
      const actionId = await addAction("Two places", [id, other.id]);

      expect(await removeDestination(db, ours, id)).toEqual({ changed: [actionId] });
      expect(await actionNames(db, ours, [actionId])).toEqual(["Two places"]);
      expect((await definitionOf(actionId))?.definition).toMatchObject({ destinations: [other.id] });
      expect(await db.select().from(actionDestination).where(eq(actionDestination.actionId, actionId))).toEqual([
        { actionId, destinationId: other.id },
      ]);
    });

    it("doesn't count as saving the Action, so Items captured before it still fire", async () => {
      const [{ id }, other] = [await addWebhook(), await addWebhook()];
      const actionId = await addAction("Keeps its time", [id, other.id]);
      const before = (await definitionOf(actionId))?.updatedAt;

      await removeDestination(db, ours, id);
      expect((await definitionOf(actionId))?.updatedAt).toEqual(before);
    });

    it("leaves a disabled Action with no Destination, and doesn't enable it", async () => {
      const { id } = await addWebhook();
      const actionId = await addAction("Switched off", [id], false);

      expect(await removeDestination(db, ours, id)).toEqual({ changed: [actionId] });
      expect(await definitionOf(actionId)).toMatchObject({ enabled: false, definition: { destinations: [] } });
    });

    it("removes a Destination with Deliveries, and the Log says what was never sent", async () => {
      const [{ id }, other] = [await addWebhook(), await addWebhook()];
      const actionId = await addAction("Fired", [id, other.id]);
      const [sentItem, heldItem] = [await anItem(), await anItem()];
      await db.insert(delivery).values([
        { actionId, itemId: sentItem, destinationId: id, status: "sent" },
        { actionId, itemId: heldItem, destinationId: id, status: "held" },
      ]);

      expect(await removeDestination(db, ours, id)).toEqual({ changed: [actionId] });
      expect(await db.select().from(delivery).where(eq(delivery.destinationId, id))).toEqual([]);
      expect(await db.select().from(itemLog).where(eq(itemLog.itemId, sentItem))).toEqual([]);
      const [logged] = await db.select().from(itemLog).where(eq(itemLog.itemId, heldItem));
      expect(logged).toMatchObject({ stage: "act", data: { actionId, destinationId: id } });
      expect(logged?.message).toContain("Not sent");
    });

    it("returns nothing for another Workspace's Destination, and leaves it alone", async () => {
      const { id } = await addWebhook();
      expect(await removeDestination(db, theirs, id)).toBeUndefined();
      expect(await removeDestination(db, ours, "not-a-uuid")).toBeUndefined();
      expect(await db.select().from(destination).where(eq(destination.id, id))).toHaveLength(1);
    });

    it("names only the Workspace's own Actions", async () => {
      const { id } = await addWebhook();
      const actionId = await addAction("Ours alone", [id]);
      expect(await actionNames(db, theirs, [actionId])).toEqual([]);
      expect(await actionNames(db, ours, ["not-a-uuid"])).toEqual([]);
    });

    it("refuses one of two removes racing for an Action's last two Destinations", async () => {
      const [first, second] = [await addWebhook(), await addWebhook()];
      await addAction("Racing", [first.id, second.id]);
      const results = await Promise.all([removeDestination(db, ours, first.id), removeDestination(db, ours, second.id)]);
      expect(results.filter((result) => result !== undefined && "refused" in result)).toHaveLength(1);
    });
  });
});
