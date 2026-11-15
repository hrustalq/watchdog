import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeSentBack, encodeSentBack } from "./sent-back.ts";

/** JSON packed as the cookie holds it, for values the encoder would never write. */
const packed = (json: string) => deflateRawSync(json).toString("base64url");

describe("a refused form's values in a cookie", () => {
  it("come back as they went", () => {
    const values = { baseUrl: "https://llm.test/v1", draft: 'classifier: Ünïcode "quoted"\nwhen: {}\n', structured: "" };

    expect(decodeSentBack(encodeSentBack(values))).toEqual(values);
  });

  it("are written in characters a cookie holds as they are", () => {
    expect(encodeSentBack({ draft: "a; b=c, d\n" })).toMatch(/^[\w-]+$/);
  });

  it("keep a rule draft as long as the URL used to, because YAML compresses", () => {
    const rule = "classifier: Launch watch\nwhen:\n  field: title\n  op: matches\n  value: \"(?i)launch\"\n";
    const draft = rule.repeat(Math.ceil(6000 / rule.length));

    expect(decodeSentBack(encodeSentBack({ draft }))).toEqual({ draft });
  });

  it("aren't kept when they're too long for a browser to keep the cookie", () => {
    expect(encodeSentBack({ draft: randomBytes(3000).toString("base64") })).toBeUndefined();
  });

  it.each([
    ["no cookie", undefined],
    ["an empty cookie", ""],
    ["a value that isn't ours", "not base64 at all!"],
    ["JSON that isn't an object", packed("null")],
    ["a value that isn't text", packed('{"draft":1}')],
  ])("are nothing for %s", (_what, cookie) => {
    expect(decodeSentBack(cookie)).toBeUndefined();
  });
});
