import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state.tsx";

describe("EmptyState", () => {
  it("centres one headline and the line under it", () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No Items yet">
        <p className="mt-2 max-w-md text-sm text-muted-foreground">Your first poll runs within a minute.</p>
      </EmptyState>,
    );
    expect(html).toContain("text-headline");
    expect(html).toContain("text-center");
    expect(html).toContain("Your first poll runs within a minute.");
  });
});
