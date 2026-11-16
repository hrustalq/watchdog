import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CorrectCategories } from "./correct-categories.tsx";

/** The values the add box's datalist offers, in order. */
const offered = (html: string) =>
  [...html.matchAll(/<datalist id="item-categories">(.*?)<\/datalist>/gs)].flatMap(([, body]) =>
    [...(body ?? "").matchAll(/<option value="([^"]*)"/g)].map(([, value]) => value),
  );

describe("CorrectCategories", () => {
  it("offers the Workspace's known Categories in the add box's datalist, in the page's HTML", () => {
    const html = renderToStaticMarkup(
      <CorrectCategories itemId="item-1" categories={[]} suggestions={["lead", "pricing"]} />,
    );

    expect(html).toContain('list="item-categories"');
    expect(offered(html)).toEqual(["lead", "pricing"]);
  });

  it("leaves out the Item's own Categories, which it can't add again", () => {
    const html = renderToStaticMarkup(
      <CorrectCategories itemId="item-1" categories={["lead"]} suggestions={["lead", "pricing"]} />,
    );

    expect(offered(html)).toEqual(["pricing"]);
  });

  it("still takes a Category the Workspace doesn't know, because Categories are open-ended", () => {
    const html = renderToStaticMarkup(<CorrectCategories itemId="item-1" categories={[]} suggestions={[]} />);

    // The box is free text with a list of suggestions beside it, not a select of the known ones.
    expect(html).toContain('name="add"');
    expect(html).toContain('type="text"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("</option>");
    expect(offered(html)).toEqual([]);
  });

  it("renders a Category as text, whatever HTML it holds", () => {
    const html = renderToStaticMarkup(
      <CorrectCategories itemId="item-1" categories={[]} suggestions={['<img src=x onerror="alert(1)">']} />,
    );

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
  });
});
