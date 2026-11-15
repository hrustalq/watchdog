import { describe, expect, it } from "vitest";
import { decodeSentBack, encodeSentBack } from "./sent-back.ts";

describe("a refused form's values in a cookie", () => {
  it("come back as they went", () => {
    const values = { baseUrl: "https://llm.test/v1", draft: 'classifier: Ünïcode "quoted"\nwhen: {}\n', structured: "" };

    expect(decodeSentBack(encodeSentBack(values))).toEqual(values);
  });

  it("are written in characters a cookie holds as they are", () => {
    expect(encodeSentBack({ draft: "a; b=c, d\n" })).toMatch(/^[\w-]+$/);
  });

  it("aren't kept when they're too long for a browser to keep the cookie", () => {
    expect(encodeSentBack({ draft: "x".repeat(2800) })).toBeDefined();
    expect(encodeSentBack({ draft: "x".repeat(3000) })).toBeUndefined();
  });

  it.each([
    ["no cookie", undefined],
    ["an empty cookie", ""],
    ["a value that isn't ours", "not base64 at all!"],
    ["JSON that isn't an object", Buffer.from("[1,2]").toString("base64url")],
    ["a value that isn't text", Buffer.from('{"draft":1}').toString("base64url")],
  ])("are nothing for %s", (_what, cookie) => {
    expect(decodeSentBack(cookie)).toBeUndefined();
  });
});
