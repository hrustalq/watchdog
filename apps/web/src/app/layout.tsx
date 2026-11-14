import type { Metadata } from "next";
import { Recursive } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

// One variable family for the whole system: MONO 0 for UI text, MONO 1 for data.
// See DESIGN.md → Typography.
//
// `subsets` only chooses what to preload: next/font self-hosts every subset Google returns,
// each with its own unicode-range, so latin-ext (Polish, Czech) and vietnamese text already
// renders in Recursive and fetches those files on demand. Listing them here as well would only
// preload another 85 kB on every page, basic-Latin ones included (#136).
const recursive = Recursive({
  subsets: ["latin"],
  axes: ["MONO"],
  variable: "--font-recursive",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Watchdog",
  description: "Watches many sources, rates what matters, and shows the signal.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // The theme follows the OS colour scheme in CSS alone (`prefers-color-scheme` in
      // globals.css), so the first paint already has the right one and no script is needed.
      // Dark is the base and the reference theme (DESIGN.md → Overview).
      className={cn("h-full antialiased font-sans", recursive.variable)}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
