import { describe, expect, it } from "vitest";
import { htmlToText } from "./item.ts";

describe("htmlToText", () => {
  it("stays linear on openers that never close", () => {
    const start = performance.now();
    for (const opener of ["<!--", "<a ", "<p ", "<script>"]) htmlToText(opener.repeat(250_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("drops an unclosed comment and script to the end", () => {
    expect(htmlToText("<p>Kept</p><!-- open")).toBe("Kept");
    expect(htmlToText("Kept<script>alert(1)")).toBe("Kept");
  });
});
