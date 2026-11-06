import { randomBytes } from "node:crypto";
import { closeDb, createDb, type Db, destination, destinationConfirmation, eq, migrate, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addEmailDestination,
  confirmDestination,
  type DestinationDeps,
  listDestinations,
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
  egressAllows: () => true,
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
    if (!("destination" in result)) throw new Error(`Not added: ${result.problem}`);
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
});
