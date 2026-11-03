import { describe, expect, it } from "vitest";
import { htmlToText, tidyText } from "./item.ts";

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

  it("puts a blank line between paragraphs and headings", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\n\nTwo");
    expect(htmlToText("<h2>Notable</h2>\n<p>Text</p><hr><p>More</p>")).toBe(
      "Notable\n\nText\n\nMore",
    );
  });

  it("puts list items, br and table rows on their own lines", () => {
    expect(htmlToText("<p>Intro</p>\n<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n<p>End</p>")).toBe(
      "Intro\n\na\nb\n\nEnd",
    );
    expect(htmlToText("first<br>second<br/>third")).toBe("first\nsecond\nthird");
    expect(htmlToText("<table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>")).toBe(
      "k v\na 1",
    );
  });

  it("joins inline tags without breaks and collapses spaces within a line", () => {
    expect(htmlToText("<p>Use <code>npm</code>   <em>now</em>,\n  please</p>")).toBe(
      "Use npm now, please",
    );
    expect(htmlToText("<p>a&nbsp;&nbsp;b</p>")).toBe("a b");
  });

  it("keeps at most one blank line in a row", () => {
    expect(htmlToText("<p>a</p><p></p><div> </div><p>&nbsp;</p><p>b</p>")).toBe("a\n\nb");
  });
});

describe("tidyText", () => {
  it("keeps line breaks, trims lines and collapses blank runs", () => {
    expect(tidyText("  one \t two \r\n  three\n\n\n\nfour  ")).toBe("one two\nthree\n\nfour");
  });
});
