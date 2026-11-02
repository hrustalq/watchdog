import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
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

  it("delivers the message over SMTP", async () => {
    const mailer = createMailer({
      smtp: {
        host: mailpit.getHost(),
        port: mailpit.getMappedPort(1025),
        user: "watchdog",
        password: "watchdog",
        from: "Watchdog <watchdog@example.com>",
      },
    });

    await mailer.send({ to: "alice@example.com", subject: "Sign in to Watchdog", text: "A link" });

    const api = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}/api/v1`;
    const list = mailpitMessages.parse(await (await fetch(`${api}/messages`)).json());
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0]?.Subject).toBe("Sign in to Watchdog");
    expect(list.messages[0]?.To.map((to) => to.Address)).toEqual(["alice@example.com"]);
  }, 60_000);
});
