import { tl } from "@mtcute/node";
import { NodeCryptoProvider } from "@mtcute/node/utils.js";
import { createStub, StubTelegramClient } from "@mtcute/test";
import { describe, expect, it } from "vitest";
import { FloodWaitTooLong, readOnly } from "./read-only.ts";

const stub = () => {
  const client = new StubTelegramClient({ crypto: new NodeCryptoProvider() });
  client.respondWith("messages.getHistory", () => createStub("messages.messages", { messages: [], chats: [], users: [] }));
  client.respondWith("messages.sendMessage", () => {
    throw new Error("Telegram was called");
  });
  return client;
};
const history = createStub("messages.getHistory", { peer: { _: "inputPeerSelf" }, limit: 1 });
const floodWait = (seconds: number) => tl.RpcError.fromTl({ errorCode: 420, errorMessage: `FLOOD_WAIT_${String(seconds)}` });

describe("the read-only Telegram client", () => {
  it("lets a read method through", async () => {
    const client = readOnly(stub());

    await expect(client.call(history)).resolves.toMatchObject({ _: "messages.messages" });
  });

  it("throws on a send method before it reaches Telegram", async () => {
    const client = readOnly(stub());

    await expect(
      client.call(createStub("messages.sendMessage", { peer: { _: "inputPeerSelf" }, message: "hi" })),
    ).rejects.toThrow("messages.sendMessage isn't a read method, so Watchdog refuses to call it");
  });

  it.each([
    createStub("messages.readHistory"),
    createStub("channels.joinChannel"),
    createStub("channels.leaveChannel"),
    createStub("messages.getMessagesViews"),
    createStub("messages.getBotCallbackAnswer"),
    createStub("messages.getInlineBotResults"),
    createStub("contacts.getLocated"),
    createStub("auth.logOut"),
  ])("refuses $_", async (request) => {
    const client = readOnly(stub());

    await expect(client.call(request)).rejects.toThrow(/isn't a read method/);
  });

  it("allows the methods it is given on top, such as the logout a revoke needs", async () => {
    const telegram = stub();
    telegram.respondWith("auth.logOut", () => createStub("auth.loggedOut"));
    const client = readOnly(telegram, ["auth.logOut"]);

    await expect(client.call({ _: "auth.logOut" })).resolves.toMatchObject({ _: "auth.loggedOut" });
  });

  it("waits out a FLOOD_WAIT before its next call, rather than calling again at once", async () => {
    const telegram = stub();
    let answered = 0;
    telegram.respondWith("messages.getHistory", () => {
      answered += 1;
      if (answered === 1) throw floodWait(1);
      return createStub("messages.messages", { messages: [], chats: [], users: [] });
    });
    const client = readOnly(telegram);

    await expect(client.call(history)).rejects.toThrow();
    const asked = Date.now();
    await client.call(history);

    expect(Date.now() - asked).toBeGreaterThanOrEqual(950);
  });

  it("throws at once when the wait runs past its deadline, so the turn can end", async () => {
    const telegram = stub();
    telegram.respondWith("messages.getHistory", () => {
      throw floodWait(600);
    });
    const client = readOnly(telegram, [], { until: new Date(Date.now() + 60_000) });

    const refused: unknown = await client.call(history).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(FloodWaitTooLong);
    expect(refused instanceof FloodWaitTooLong && refused.until.getTime()).toBeGreaterThan(Date.now() + 590_000);
    await expect(client.call(history)).rejects.toBeInstanceOf(FloodWaitTooLong);
  });
});
