import { describe, expect, it } from "vitest";
import { checkUnsubscribeToken, unsubscribeUrl } from "./unsubscribe.ts";

const secret = "a-better-auth-secret-of-at-least-32-chars";
const actionId = "6f1c1f0e-1d1a-4a43-9b1e-0f6a3f1b2c3d";
const destinationId = "0b7e6f52-8a1c-4c8e-9a51-3e2d1c0b9a87";

const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";

describe("unsubscribe tokens", () => {
  it("puts the token in a URL on the app, and checks back to the Action and Destination", () => {
    const url = unsubscribeUrl("https://watchdog.example/", secret, actionId, destinationId);
    expect(url.startsWith("https://watchdog.example/unsubscribe?token=")).toBe(true);
    expect(checkUnsubscribeToken(tokenOf(url), secret)).toEqual({ actionId, destinationId });
  });

  it("refuses a token whose ids or signature were changed, or signed with another secret", () => {
    const token = tokenOf(unsubscribeUrl("https://watchdog.example", secret, actionId, destinationId));
    const [, , signature] = token.split(".");
    const otherAction = "11111111-1111-4111-8111-111111111111";
    expect(checkUnsubscribeToken(`${otherAction}.${destinationId}.${String(signature)}`, secret)).toBeUndefined();
    expect(checkUnsubscribeToken(`${token.slice(0, -2)}AA`, secret)).toBeUndefined();
    expect(checkUnsubscribeToken(token, "another-secret-of-at-least-32-characters")).toBeUndefined();
  });

  it("refuses text that isn't a token", () => {
    for (const bad of ["", "a.b.c", `${actionId}.${destinationId}`, `${actionId}.${destinationId}.x.y`]) {
      expect(checkUnsubscribeToken(bad, secret)).toBeUndefined();
    }
  });
});
