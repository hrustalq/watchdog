import { describe, expect, it } from "vitest";
import { htmlToText } from "./item.ts";

describe("htmlToText", () => {
  // Compares two runs on the same machine, because a limit in milliseconds fails on a slow runner. On
  // 8 times the input, linear code takes about 8 times as long and quadratic code about 64 times, so
  // the limit sits between them. It measures CPU time, because a busy machine pausing the process
  // distorts the clock, and more on a long run than a short one. The fastest of a few runs counts.
  it.each(["<!--", "<a ", "<p ", "<script>"])(
    "stays linear on %s openers that never close",
    (opener) => {
      const small = opener.repeat(5_000);
      const large = opener.repeat(40_000);
      const cpuTimeOf = (html: string) => {
        const before = process.cpuUsage();
        htmlToText(html);
        const { user, system } = process.cpuUsage(before);
        return user + system;
      };
      const times = [0, 1, 2].map(() => ({ small: cpuTimeOf(small), large: cpuTimeOf(large) }));
      const growth = Math.min(...times.map((time) => time.large)) / Math.min(...times.map((time) => time.small));
      expect(growth).toBeLessThan(22);
    },
    // Only quadratic code needs this long, and then the assertion is what should report it.
    300_000,
  );

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
    expect(htmlToText("<p-note>a</p-note><li-item>b</li-item>")).toBe("ab");
  });

  it("breaks around details, summary and caption", () => {
    expect(htmlToText("<details><summary>Commits</summary>a</details>b")).toBe(
      "Commits\na\n\nb",
    );
    expect(htmlToText("<table><caption>Versions</caption><tr><td>1</td></tr></table>")).toBe(
      "Versions\n1",
    );
  });

  it("keeps at most one blank line in a row", () => {
    expect(htmlToText("<p>a</p><p></p><div> </div><p>&nbsp;</p><p>b</p>")).toBe("a\n\nb");
  });
});
