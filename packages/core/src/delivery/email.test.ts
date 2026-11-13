import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createMailer, type MailMessage } from "../mail/mailer.ts";
import type { AlertMessage } from "./content.ts";
import type { Destination } from "./deliver.ts";
import { FinalSendError } from "./deliver.ts";
import { createEmailSender } from "./email.ts";
import { groupedAlert } from "./group.ts";

const message: AlertMessage = {
  title: "A security advisory",
  source: "Hacker News",
  rating: "Severity 5, Importance 3",
  severity: 5,
  summary: "Patch now.",
  link: "https://watchdog.test/items/0a1b",
  why: "Severity is at least 4",
};

const confirmed: Destination = {
  id: "0a1b",
  workspaceId: "0a1c",
  type: "email",
  name: "me",
  config: { address: "me@example.com" },
  secretCiphertext: null,
  secretShownAt: null,
  confirmedAt: new Date(),
  lastError: null,
  lastErrorAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** A sender over a mailer that records what it's given. */
function recording(from?: string) {
  const sent: MailMessage[] = [];
  const sender = createEmailSender(
    {
      send: (mail) => {
        sent.push(mail);
        return Promise.resolve();
      },
    },
    from,
  );
  return { sent, sender };
}

/**
 * The error nodemailer rejects with when the server answers a command with a failure: its
 * `smtp-connection` sets `code`, `command` and, for a reply with a code, `responseCode` (see
 * smtp.int.test.ts for the real ones).
 */
function smtpError(text: string, fields: { code: string; command: string; responseCode?: number }) {
  return Object.assign(new Error(text), fields);
}

describe("createEmailSender", () => {
  it("sends the alert's lines as plain text to the Destination's address", async () => {
    const { sent, sender } = recording();

    await sender.send(confirmed, message);

    expect(sent).toEqual([
      {
        to: "me@example.com",
        subject: "[Watchdog] Act today · A security advisory",
        text: [
          "A security advisory",
          "Source: Hacker News",
          "Rating: Severity 5, Importance 3",
          "",
          "Patch now.",
          "",
          "https://watchdog.test/items/0a1b",
          "Why it fired: Severity is at least 4",
        ].join("\n"),
      },
    ]);
  });

  it("uses the alert sender address when there is one", async () => {
    const { sent, sender } = recording("Watchdog alerts <alerts@example.com>");

    await sender.send(confirmed, message);

    expect(sent[0]?.from).toBe("Watchdog alerts <alerts@example.com>");
  });

  it.each([
    [4, "Act this week"],
    [3, "Plan for it this month"],
    [2, "Minor, with no deadline"],
    [1, "Nothing urgent or harmful"],
    [null, "Unrated"],
  ])("names Severity %s in the subject as %s", async (severity, word) => {
    const { sent, sender } = recording();

    await sender.send(confirmed, { ...message, severity, rating: severity === null ? "unrated" : message.rating });

    expect(sent[0]?.subject).toBe(`[Watchdog] ${word} · A security advisory`);
  });

  it("says an unrated Item is unrated, and leaves out a summary it doesn't have", async () => {
    const { sent, sender } = recording();

    await sender.send(confirmed, { ...message, severity: null, rating: "unrated", summary: null });

    expect(sent[0]?.text).toBe(
      [
        "A security advisory",
        "Source: Hacker News",
        "Rating: unrated",
        "",
        "https://watchdog.test/items/0a1b",
        "Why it fired: Severity is at least 4",
      ].join("\n"),
    );
  });

  it("sends a title that holds HTML as text, with no markup part", async () => {
    const { sent, sender } = recording();
    const title = `<img src=x onerror="alert(1)"> & <b>bold</b>`;

    await sender.send(confirmed, { ...message, title });

    expect(sent[0]?.subject).toContain(title);
    expect(sent[0]?.text).toContain(title);
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(["subject", "text", "to"]);
  });

  it("keeps the subject to one line whatever the title holds", async () => {
    const { sent, sender } = recording();

    await sender.send(confirmed, { ...message, title: "Real\r\nBcc: someone@example.com" });

    expect(sent[0]?.subject).toBe("[Watchdog] Act today · Real Bcc: someone@example.com");
  });

  it("sends a Grouped alert with its count in the subject and every line in the text", async () => {
    const { sent, sender } = recording();
    const items = [
      { id: "a", title: "First", severity: 4, importance: 3 },
      { id: "b", title: "Second", severity: null, importance: null },
    ];

    await sender.send(confirmed, groupedAlert(items, "https://watchdog.test"));

    expect(sent[0]?.subject).toBe("[Watchdog] 2 alerts");
    expect(sent[0]?.text).toBe(
      [
        "2 alerts",
        "First · Severity 4, Importance 3 · https://watchdog.test/items/a",
        "Second · unrated · https://watchdog.test/items/b",
      ].join("\n"),
    );
  });

  it("refuses for good, and sends nothing, to an address that isn't confirmed", async () => {
    const { sent, sender } = recording();

    const send = sender.send({ ...confirmed, confirmedAt: null }, message);

    await expect(send).rejects.toBeInstanceOf(FinalSendError);
    await expect(send).rejects.toThrow("the address isn't confirmed yet");
    expect(sent).toEqual([]);
  });

  it.each([
    ["no address", {}],
    ["two addresses, which would reach one that never confirmed", { address: "me@a.test, other@b.test" }],
    ["text that isn't an address", { address: "not-an-address" }],
  ])("refuses for good, and sends nothing, when the Destination holds %s", async (_name, config) => {
    const { sent, sender } = recording();

    await expect(sender.send({ ...confirmed, config }, message)).rejects.toBeInstanceOf(FinalSendError);
    expect(sent).toEqual([]);
  });

  it("fails so as to be retried, and keeps the operator's mail server out of the reason", async () => {
    const sender = createEmailSender(
      { send: () => Promise.reject(new Error("connect ETIMEDOUT 10.0.3.7:587")) },
      undefined,
    );

    const failure = await sender.send(confirmed, message).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(FinalSendError);
    expect(String(failure)).not.toContain("10.0.3.7");
    expect(String(failure)).toContain("mail server");
  });

  it("fails for good when the server refuses the address, and keeps its answer for the worker's log", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const refused = smtpError(
      "Can't send mail - all recipients were rejected: 550 5.1.1 <me@example.com>: recipient address rejected",
      { code: "EENVELOPE", command: "RCPT TO", responseCode: 550 },
    );
    const sender = createEmailSender({ send: () => Promise.reject(refused) }, undefined);

    const failure = await sender.send(confirmed, message).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FinalSendError);
    expect(String(failure)).toContain("the mail server refused this address");
    expect(String(failure)).not.toContain("550");
    expect(String(failure)).not.toContain("me@example.com");
    expect(stderr.mock.calls.join()).toContain("recipient address rejected");
    stderr.mockRestore();
  });

  it.each([
    [
      "a failed login",
      smtpError("Invalid login: 535 5.7.8 Authentication credentials invalid", {
        code: "EAUTH",
        command: "AUTH PLAIN",
        responseCode: 535,
      }),
    ],
    [
      "a refused sender",
      smtpError("Mail command failed: 550 5.1.8 Sender address rejected", {
        code: "EENVELOPE",
        command: "MAIL FROM",
        responseCode: 550,
      }),
    ],
    [
      "a temporary refusal of the recipient",
      smtpError("Recipient command failed: 450 4.2.0 Try again later", {
        code: "EENVELOPE",
        command: "RCPT TO",
        responseCode: 450,
      }),
    ],
    [
      "a refused connection",
      smtpError("connect ECONNREFUSED 10.0.3.7:587", { code: "ESOCKET", command: "CONN" }),
    ],
  ])("queues a retry after %s", async (_name, refused) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sender = createEmailSender({ send: () => Promise.reject(refused) }, undefined);

    const failure = await sender.send(confirmed, message).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(FinalSendError);
    expect(String(failure)).toContain("the mail server can't be reached or refused the mail");
  });

  it("cuts a long title in the subject, and doesn't split a character made of two UTF-16 units", async () => {
    const { sent, sender } = recording();

    await sender.send(confirmed, { ...message, title: `${"x".repeat(198)}😀😀` });

    expect(sent[0]?.subject).toBe(`[Watchdog] Act today · ${"x".repeat(198)}…`);
  });

  it("prints the alert to the log on a self-hosted install without SMTP", async () => {
    const chunks: string[] = [];
    const log = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    const sender = createEmailSender(createMailer({ mode: "self-hosted", smtp: undefined }, log), undefined);

    await sender.send(confirmed, message);

    const output = chunks.join("");
    expect(output).toContain("me@example.com");
    expect(output).toContain("A security advisory");
    expect(output).toContain("https://watchdog.test/items/0a1b");
  });
});

describe("a Digest mail", () => {
  it("names the Digest, lists its Items and carries one-click unsubscribe headers", async () => {
    const { sent, sender } = recording();
    const items = [1, 2].map((n) => ({ id: `0a1${String(n)}`, title: `Item ${String(n)}`, severity: null, importance: null }));
    const unsubscribe = "https://watchdog.test/unsubscribe?token=abc";

    await sender.send(confirmed, { ...groupedAlert(items, "https://watchdog.test"), digest: "Morning", unsubscribeUrl: unsubscribe });

    expect(sent).toEqual([
      {
        to: "me@example.com",
        subject: "[Watchdog] Digest Morning · 2 Items",
        text: [
          "Digest Morning: 2 Items",
          "Item 1 · unrated · https://watchdog.test/items/0a11",
          "Item 2 · unrated · https://watchdog.test/items/0a12",
        ].join("\n"),
        headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      },
    ]);
  });
});
