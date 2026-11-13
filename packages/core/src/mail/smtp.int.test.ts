import { createServer } from "node:net";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEmailSender } from "../delivery/email.ts";
import type { Destination } from "../delivery/deliver.ts";
import { FinalSendError } from "../delivery/deliver.ts";
import { createMailer } from "./mailer.ts";

// Mailpit accepts any login over plain SMTP, so the all-or-nothing SMTP config can point at it.
const mailpitImage = "axllent/mailpit:v1.33.0";

const mailpitMessages = z.object({
  messages: z.array(z.object({ Subject: z.string(), To: z.array(z.object({ Address: z.string() })) })),
});

describe("createMailer with SMTP", () => {
  let mailpit: StartedTestContainer;

  beforeAll(async () => {
    mailpit = await new GenericContainer(mailpitImage)
      .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: "1", MP_SMTP_AUTH_ALLOW_INSECURE: "1" })
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp("/livez", 8025))
      .start();
    return async () => {
      await mailpit.stop();
    };
  }, 120_000);

  const smtp = () => ({
    host: mailpit.getHost(),
    port: mailpit.getMappedPort(1025),
    user: "watchdog",
    password: "watchdog",
    from: "Watchdog <watchdog@example.com>",
  });

  it("refuses to send without TLS in hosted mode", async () => {
    const mailer = createMailer({ mode: "hosted", smtp: smtp() });

    await expect(
      mailer.send({ to: "alice@example.com", subject: "Sign in to Watchdog", text: "A link" }),
    ).rejects.toThrow(/STARTTLS/);
  }, 60_000);

  it("delivers the message over SMTP", async () => {
    const mailer = createMailer({ mode: "self-hosted", smtp: smtp() });

    await mailer.send({ to: "alice@example.com", subject: "Sign in to Watchdog", text: "A link" });

    const api = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}/api/v1`;
    const list = mailpitMessages.parse(await (await fetch(`${api}/messages`)).json());
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0]?.Subject).toBe("Sign in to Watchdog");
    expect(list.messages[0]?.To.map((to) => to.Address)).toEqual(["alice@example.com"]);
  }, 60_000);

  it("sends from the message's own address when it has one, and from SMTP_FROM otherwise", async () => {
    const mailer = createMailer({ mode: "self-hosted", smtp: smtp() });

    await mailer.send({ to: "bob@example.com", subject: "From SMTP_FROM", text: "A" });
    await mailer.send({ to: "bob@example.com", subject: "From alerts", text: "B", from: "alerts@example.com" });

    const api = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}/api/v1`;
    const list = z
      .object({ messages: z.array(z.object({ Subject: z.string(), From: z.object({ Address: z.string() }) })) })
      .parse(await (await fetch(`${api}/messages`)).json());
    const fromOf = (subject: string) => list.messages.find((sent) => sent.Subject === subject)?.From.Address;
    expect(fromOf("From SMTP_FROM")).toBe("watchdog@example.com");
    expect(fromOf("From alerts")).toBe("alerts@example.com");
  }, 60_000);
});

/**
 * A mail server that can refuse a command, which Mailpit never does: it takes the greeting and any login,
 * then answers `refuse` with its reply and everything else with 250. `pipelining` is advertised the way a
 * real server advertises it, so nodemailer takes the other envelope path too.
 */
async function refusingServer(refuse: { command: string; reply: string }, pipelining = false) {
  const answer = (line: string) => {
    if (line.toUpperCase().startsWith(refuse.command)) return refuse.reply;
    if (line.startsWith("EHLO")) {
      return pipelining
        ? "250-watchdog.test\r\n250-AUTH PLAIN\r\n250 PIPELINING"
        : "250-watchdog.test\r\n250 AUTH PLAIN";
    }
    if (line.startsWith("AUTH")) return "235 2.7.0 Authentication successful";
    if (line.startsWith("MAIL FROM")) return "250 2.1.0 Ok";
    if (line.startsWith("RCPT TO")) return "250 2.1.5 Ok";
    if (line.startsWith("DATA")) return "354 End data with <CR><LF>.<CR><LF>";
    if (line.startsWith("QUIT")) return "221 2.0.0 Bye";
    return "250 2.0.0 Ok";
  };
  const server = createServer((socket) => {
    let pending = "";
    socket.write("220 watchdog.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      while (pending.includes("\r\n")) {
        const end = pending.indexOf("\r\n");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        socket.write(`${answer(line)}\r\n`);
      }
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** What nodemailer puts on the error it rejects with, which is what the email sender reads. */
function shapeOf(error: unknown) {
  if (!(error instanceof Error)) throw new Error("Expected an error");
  return {
    code: "code" in error ? String(error.code) : null,
    command: "command" in error ? String(error.command) : null,
    responseCode: "responseCode" in error && typeof error.responseCode === "number" ? error.responseCode : null,
  };
}

const confirmedEmail: Destination = {
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

describe("createMailer against a server that refuses", () => {
  const alert = { title: "A security advisory", source: "Hacker News", rating: "Severity 5", severity: 5, summary: "Patch now.", link: "https://watchdog.test/items/0a1b", why: "Severity is at least 4" };

  const mailerTo = (port: number) =>
    createMailer({
      mode: "self-hosted",
      smtp: { host: "127.0.0.1", port, user: "watchdog", password: "watchdog", from: "Watchdog <watchdog@example.com>" },
    });

  it.each([["one command at a time", false], ["pipelined", true]])(
    "reports a 550 to RCPT TO, sent %s, as a refused recipient",
    async (_name, pipelining) => {
      const sink = await refusingServer({ command: "RCPT TO", reply: "550 5.1.1 <me@example.com>: recipient address rejected" }, pipelining);

      const failure = await mailerTo(sink.port)
        .send({ to: "me@example.com", subject: "A", text: "A" })
        .catch((error: unknown) => error);
      await sink.stop();

      expect(shapeOf(failure)).toEqual({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 });
    },
    60_000,
  );

  it("fails the address for good, and not the install, when the server refuses the recipient", async () => {
    const sink = await refusingServer({ command: "RCPT TO", reply: "550 5.1.1 <me@example.com>: recipient address rejected" });
    const sender = createEmailSender(mailerTo(sink.port), undefined);

    const failure = await sender.send(confirmedEmail, alert).catch((error: unknown) => error);
    await sink.stop();

    expect(failure).toBeInstanceOf(FinalSendError);
    expect(String(failure)).toContain("the mail server refused this address");
  }, 60_000);

  it.each([
    ["550 to MAIL FROM", { command: "MAIL FROM", reply: "550 5.1.8 Sender address rejected" }, { code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 }],
    ["450 to RCPT TO", { command: "RCPT TO", reply: "450 4.2.0 Try again later" }, { code: "EENVELOPE", command: "RCPT TO", responseCode: 450 }],
    ["535 on login", { command: "AUTH", reply: "535 5.7.8 Authentication credentials invalid" }, { code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }],
  ])("keeps a %s retryable", async (_name, refuse, shape) => {
    const sink = await refusingServer(refuse);

    const failure = await mailerTo(sink.port)
      .send({ to: "me@example.com", subject: "A", text: "A" })
      .catch((error: unknown) => error);
    const classified = await createEmailSender(mailerTo(sink.port), undefined)
      .send(confirmedEmail, alert)
      .catch((error: unknown) => error);
    await sink.stop();

    expect(shapeOf(failure)).toEqual(shape);
    expect(classified).not.toBeInstanceOf(FinalSendError);
    expect(String(classified)).toContain("the mail server can't be reached or refused the mail");
  }, 60_000);
});
