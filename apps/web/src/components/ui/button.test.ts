import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button.tsx";

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

  it("lets a call site's class override the variant's", () => {
    expect(classes({ variant: "outline", className: "border-ring mt-6" })).toEqual(
      expect.arrayContaining(["border-ring", "mt-6"]),
    );
    expect(classes({ variant: "outline", className: "border-ring" })).not.toContain("border-border");
  });
});
