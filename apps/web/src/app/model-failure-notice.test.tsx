import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelFailureNotice } from "./model-failure-notice.tsx";

const notice = (failing: boolean) => renderToStaticMarkup(<ModelFailureNotice failing={failing} />);

/** What a sighted reader gets with colour taken away. */
const words = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#x27;|&apos;/g, "'");

describe("ModelFailureNotice", () => {
  it("says in words that the Agent can't rate, whatever the colour", () => {
    expect(words(notice(true))).toContain("The Agent can't rate Items right now");
  });

  it("links to the screen that carries the reason", () => {
    expect(notice(true)).toContain('href="/model"');
  });

  it("is an Alarm Red line with a lamp, so it reads as a failure", () => {
    const html = notice(true);
    expect(html).toContain("text-alarm");
    expect(html).toContain("bg-alarm");
    expect(html).toContain('aria-hidden="true"');
  });

  it("announces itself through a region that is there from the first render", () => {
    // Empty while healthy, filled when a refresh brings the failure, so the change is heard.
    expect(notice(false)).not.toContain("text-alarm");
    expect(words(notice(false))).toBe("");
    expect(notice(false)).toContain('role="status"');
    expect(notice(true)).toContain('role="status"');
  });
});
