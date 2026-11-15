import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Disclosure } from "./disclosure.tsx";

describe("Disclosure", () => {
  it("is a native details, so it opens without JavaScript", () => {
    const html = renderToStaticMarkup(
      <Disclosure label="Remove" openLabel="Keep it">
        <p>This can&apos;t be undone.</p>
      </Disclosure>,
    );
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Remove");
    expect(html).toContain("Keep it");
  });

  it("opens on a caller's condition, as a refused form does", () => {
    const html = renderToStaticMarkup(
      <Disclosure label="Replace token" openLabel="Cancel" open>
        Form
      </Disclosure>,
    );
    expect(html).toContain("open");
  });

  it("takes the surface the confirmation needs rather than nesting a well on a well", () => {
    const html = renderToStaticMarkup(
      <Disclosure label="Remove" openLabel="Keep it" bodyClassName="bg-card">
        Body
      </Disclosure>,
    );
    expect(html).toContain("bg-card");
    expect(html).toContain("rounded-lg");
  });
});
