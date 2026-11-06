import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
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

  it("refuses for good when the Destination holds no address", async () => {
    const { sender } = recording();

    await expect(sender.send({ ...confirmed, config: {} }, message)).rejects.toBeInstanceOf(FinalSendError);
  });

  it("lets the Mailer's failure through, so it's retried", async () => {
    const sender = createEmailSender({ send: () => Promise.reject(new Error("SMTP down")) }, undefined);

    const send = sender.send(confirmed, message);

    await expect(send).rejects.toThrow("SMTP down");
    await expect(send).rejects.not.toBeInstanceOf(FinalSendError);
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
