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
  telegramLinkCode,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { decryptSecret, egressPolicy, linkChat, type TestAlertDeps } from "@watchdog/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  actionNames,
  actionsOnlyOn,
  addEmailDestination,
  addTelegramDestination,
  addWebhookDestination,
  confirmationAddress,
  confirmDestination,
  type DestinationDeps,
  listDestinations,
  newTelegramLink,
  removeDestination,
  replaceWebhookSecret,
  revealWebhookSecret,
  sendConfirmationAgain,
  telegramLinkCookieValue,
  telegramLinkInCookie,
  testDestination,
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

  /** The Workspace's last confirmation mail is over a minute old. */
  const minutePasses = () => db.update(workspace).set({ confirmationMailAt: null }).where(eq(workspace.id, ours));
  beforeEach(async () => {
    await minutePasses();
  });

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

  describe("a Telegram Destination", () => {
    const addTelegram = async () => {
      const added = await addTelegramDestination(db, ours, { name: newName() });
      if ("problem" in added) throw new Error(`Not added: ${added.problem}`);
      return added;
    };
    const chat = { id: "42", title: "Private chat", type: "private" };
    const rowsOf = (workspaceId: string) => listDestinations(db, workspaceId, { telegramAvailable: true });
    const expire = (id: string) =>
      db
        .update(telegramLinkCode)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(telegramLinkCode.destinationId, id));

    it("waits for the bot, with a code to send it", async () => {
      const { destination: added, code } = await addTelegram();

      expect(await stateOf(added.id)).toBe("waiting-bot");
      const rows = await rowsOf(ours);
      const link = await telegramLinkInCookie(db, rows, telegramLinkCookieValue(added.id, code));
      expect(link).toMatchObject({ status: "pending", id: added.id, code });
      expect(link?.name).toBe(rows.find(({ id }) => id === added.id)?.name);
    });

    it("is confirmed and shows its chat's title once the bot has the code", async () => {
      const { destination: added, code } = await addTelegram();

      await linkChat(db, deps.encryptionKey, code, { id: "-100200", title: "Ops room", type: "supergroup" });

      expect((await rowsOf(ours)).find(({ id }) => id === added.id)).toMatchObject({
        state: "confirmed",
        pointsAt: "Ops room",
      });
      expect(await telegramLinkInCookie(db, await rowsOf(ours), telegramLinkCookieValue(added.id, code))).toMatchObject({
        status: "linked",
        id: added.id,
      });
    });

    it("stays waiting on an expired code, shows no link for it, and offers a new code that works", async () => {
      const { destination: added, code } = await addTelegram();
      await expire(added.id);

      expect(await linkChat(db, deps.encryptionKey, code, chat)).toMatch(/unknown or has expired/);
      expect(await stateOf(added.id)).toBe("waiting-bot");
      expect(await telegramLinkInCookie(db, await rowsOf(ours), telegramLinkCookieValue(added.id, code))).toBeUndefined();

      const fresh = await newTelegramLink(db, ours, added.id);
      await linkChat(db, deps.encryptionKey, fresh ?? "", chat);
      expect(await stateOf(added.id)).toBe("confirmed");
    });

    it("refuses a blank or duplicate name", async () => {
      const name = newName();
      await addTelegramDestination(db, ours, { name });

      expect(await addTelegramDestination(db, ours, { name })).toEqual({ problem: "duplicate-name" });
      expect(await addTelegramDestination(db, ours, { name: "  " })).toEqual({ problem: "blank-name" });
    });

    it("gives a new code only to the Workspace's own Telegram Destination that is still waiting", async () => {
      const { destination: added, code } = await addTelegram();
      const { destination: email } = await addEmail();

      expect(await newTelegramLink(db, theirs, added.id)).toBeUndefined();
      expect(await newTelegramLink(db, ours, email.id)).toBeUndefined();
      expect(await newTelegramLink(db, ours, "not-a-uuid")).toBeUndefined();

      await linkChat(db, deps.encryptionKey, code, chat);
      expect(await newTelegramLink(db, ours, added.id)).toBeUndefined();
    });

    it("shows a code only with the Destination it was made for, in this Workspace", async () => {
      const { destination: first, code } = await addTelegram();
      const { destination: second } = await addTelegram();

      expect(await telegramLinkInCookie(db, await rowsOf(ours), telegramLinkCookieValue(second.id, code))).toBeUndefined();
      expect(await telegramLinkInCookie(db, await rowsOf(theirs), telegramLinkCookieValue(first.id, code))).toBeUndefined();
      expect(await telegramLinkInCookie(db, await rowsOf(ours), undefined)).toBeUndefined();
      expect(await telegramLinkInCookie(db, await rowsOf(ours), "nonsense")).toBeUndefined();
    });
  });

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

    it("names the address a live link is for, without spending it", async () => {
      await addEmail("named@example.com");
      const token = lastToken();
      expect(await confirmationAddress(db, token)).toBe("named@example.com");
      expect(await confirmationAddress(db, token)).toBe("named@example.com");
      expect(await confirmDestination(db, token)).toBe(true);
      expect(await confirmationAddress(db, token)).toBeUndefined();
      expect(await confirmationAddress(db, "not-a-token")).toBeUndefined();
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
      await minutePasses();

      expect(await sendConfirmationAgain(db, deps, ours, added.destination.id)).toBe("sent");
      expect(await confirmDestination(db, first)).toBe(false);
      expect(await confirmDestination(db, lastToken())).toBe(true);
    });

    it("leaves the link already sent working when sending a new one fails", async () => {
      const added = await addEmail();
      const first = lastToken();
      await minutePasses();
      const failing: DestinationDeps = {
        ...deps,
        mailer: { send: () => Promise.reject(new Error("the server said no")) },
      };

      expect(await sendConfirmationAgain(db, failing, ours, added.destination.id)).toBe("failed");
      expect(await confirmDestination(db, first)).toBe(true);
    });

    it("sends at most one confirmation mail a minute from a Workspace, however it's asked", async () => {
      const added = await addEmail();
      const before = sent.length;

      expect(await sendConfirmationAgain(db, deps, ours, added.destination.id)).toBe("too-soon");
      const another = await addEmail("another@example.com");
      expect(another.mail).toBe("too-soon");
      expect(await stateOf(another.destination.id)).toBe("waiting-confirmation");
      await removeDestination(db, ours, added.destination.id);
      expect((await addEmail("third@example.com")).mail).toBe("too-soon");
      expect(sent).toHaveLength(before);

      await minutePasses();
      expect(await sendConfirmationAgain(db, deps, ours, another.destination.id)).toBe("sent");
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

  describe("sending a test", () => {
    const tested: string[] = [];
    const recording = { send: (target: { name: string }) => Promise.resolve(void tested.push(target.name)) };
    const testDeps: TestAlertDeps = {
      senders: { telegram: recording, email: recording, webhook: recording },
      appUrl: "http://localhost:3000",
      emailCapped: false,
    };
    const nameOf = async (id: string) =>
      (await db.select({ name: destination.name }).from(destination).where(eq(destination.id, id)))[0]?.name;

    it("sends to a confirmed address and a webhook", async () => {
      const email = await addEmail(owner.email);
      const hook = await addWebhookDestination(db, deps, ours, { name: newName(), url: "https://hooks.example.com/t" });
      if (!("destination" in hook)) throw new Error("Not added");

      expect(await testDestination(db, testDeps, ours, email.destination.id)).toEqual({ status: "sent" });
      expect(await testDestination(db, testDeps, ours, hook.destination.id)).toEqual({ status: "sent" });
      expect(tested.slice(-2)).toEqual([await nameOf(email.destination.id), await nameOf(hook.destination.id)]);
    });

    it("sends nothing to an unconfirmed address, another Workspace's Destination or a malformed id", async () => {
      const waiting = await addEmail();
      const confirmed = await addEmail(owner.email);
      const before = tested.length;

      expect(await testDestination(db, testDeps, ours, waiting.destination.id)).toBeUndefined();
      expect(await testDestination(db, testDeps, theirs, confirmed.destination.id)).toBeUndefined();
      expect(await testDestination(db, testDeps, ours, "not-a-uuid")).toBeUndefined();
      expect(tested).toHaveLength(before);
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

    it("can't deadlock with the Act stage, which reads an Action and then its Destinations", async () => {
      const [{ id }, other] = [await addWebhook(), await addWebhook()];
      const actionId = await addAction("Firing", [id, other.id]);

      const removed = await db.transaction(async (tx) => {
        await tx.select({ id: action.id }).from(action).where(eq(action.id, actionId)).for("key share");
        const removing = removeDestination(db, ours, id);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await tx.select({ id: destination.id }).from(destination).where(eq(destination.id, id)).for("key share");
        return removing;
      });
      expect(removed).toEqual({ changed: [actionId] });
    });

    it("leaves an Action whose stored definition lists no Destinations", async () => {
      const [{ id }, other] = [await addWebhook(), await addWebhook()];
      const actionId = await addAction("Old shape", [id, other.id]);
      await db.update(action).set({ definition: { action: "Old shape" } }).where(eq(action.id, actionId));

      expect(await removeDestination(db, ours, id)).toEqual({ changed: [actionId] });
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
