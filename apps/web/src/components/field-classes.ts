// How a form's fields look (DESIGN.md, "Inputs / Fields").
export const textBox =
  "w-full rounded-lg border border-input bg-transparent px-3 text-base transition-colors outline-hidden placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/40 aria-invalid:focus-visible:border-ring sm:text-sm";
export const field = `h-8 ${textBox}`;
export const label = "text-xs font-medium tracking-[0.01em]";
export const fieldError = "text-xs font-medium tracking-[0.01em] text-alarm";
/** Data type on a text box, at the size that stops a phone zooming in on focus. */
export const dataBox = "font-mono sm:text-[0.8125rem]";

/** A link in running text. The outline holds 3:1 against the page, which a ring at 30% doesn't. */
export const textLink =
  "rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
