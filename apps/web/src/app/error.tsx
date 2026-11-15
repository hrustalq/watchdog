"use client";

import Link from "next/link";
import { CenteredPage } from "@/components/centered-page";
import { filledLamp } from "@/components/rating";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * What a page that failed to render shows, instead of Next's own page, which arrives in no design at
 * all. A save the server couldn't finish lands here too, because only an error boundary catches it;
 * a form that keeps a draft in `sessionStorage` reads it back when Retry renders the page again.
 */
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <CenteredPage className="text-center">
      <span aria-hidden="true" className={`size-1.5 rounded-full bg-alarm ${filledLamp}`} />
      <h1 className="mt-3 text-headline">Something went wrong</h1>
      <p role="alert" className="mt-2 max-w-md text-sm text-muted-foreground">
        This page didn&apos;t load, and nothing was saved. Try again in a moment. Anything you&apos;d typed into the form
        comes back with it.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button
          onClick={() => {
            retry();
          }}
        >
          Try again
        </Button>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to the Feed
        </Link>
      </div>
    </CenteredPage>
  );
}
