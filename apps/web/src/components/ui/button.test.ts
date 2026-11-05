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
});
