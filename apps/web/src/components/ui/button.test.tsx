import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Button, buttonVariants } from "./button.tsx";

const classes = (...args: Parameters<typeof buttonVariants>) => buttonVariants(...args).split(" ");

describe("buttonVariants", () => {
  it("gives an outline button its border without the call site merging classes", () => {
    expect(classes({ variant: "outline" })).toContain("border-border");
    expect(classes({ variant: "outline" })).not.toContain("border-transparent");
  });

  it("leaves the other variants their transparent border", () => {
    expect(classes()).toContain("border-transparent");
    expect(classes({ variant: "ghost" })).toContain("border-transparent");
  });

  it("forwards size and a call site's className, which overrides the variant's", () => {
    const merged = classes({ variant: "outline", size: "lg", className: "border-ring mt-6" });
    expect(merged).toEqual(expect.arrayContaining(["h-9", "border-ring", "mt-6"]));
    expect(merged).not.toContain("border-border");
  });
});

describe("Button", () => {
  it("renders a call site's className over the variant's", () => {
    const html = renderToStaticMarkup(
      <Button variant="outline" className="w-full mt-2">
        Ship
      </Button>,
    );
    expect(html).toContain("w-full");
    expect(html).toContain("mt-2");
    expect(html).toContain("border-border");
  });

  it("types className as a string, so cva can't silently drop a function's classes", () => {
    expectTypeOf<ComponentProps<typeof Button>["className"]>().toEqualTypeOf<string | undefined>();
  });
});
