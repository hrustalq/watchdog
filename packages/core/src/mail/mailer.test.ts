import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMailer } from "./mailer.ts";

function captureOutput() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, output: () => chunks.join("") };
}

describe("createMailer without SMTP", () => {
  it("prints the message to the log instead of sending it", async () => {
    const { stream, output } = captureOutput();
    const mailer = createMailer({ mode: "self-hosted", smtp: undefined }, stream);

    await mailer.send({
      to: "alice@example.com",
      subject: "Sign in to Watchdog",
      text: "Open http://localhost:3000/sign-in/confirm?token=abc to sign in.",
    });

    expect(output()).toContain("alice@example.com");
    expect(output()).toContain("Sign in to Watchdog");
    expect(output()).toContain("http://localhost:3000/sign-in/confirm?token=abc");
  });
});
