import type { Metadata } from "next";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { sendMagicLink } from "./actions";

export const metadata: Metadata = { title: "Sign in · Watchdog" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl leading-tight font-[650] tracking-[-0.02em]">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we&apos;ll send you a link that signs you in. No password needed.
        </p>
      </div>
      {/* The form is in the static shell; the error, read from the URL, streams in over it. */}
      <Suspense fallback={<SignInForm />}>
        <SignInFormWithError searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const errors = {
  "invalid-email": "Enter a full email address, like name@example.com.",
  // Better Auth sends people back here with an error code when a magic link doesn't work.
  link: "That sign-in link has expired or was already used. Enter your email to get a new one.",
};

async function SignInFormWithError({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  const { error } = await searchParams;
  if (typeof error !== "string") return <SignInForm />;
  return <SignInForm error={error === "invalid-email" ? errors["invalid-email"] : errors.link} />;
}

function SignInForm({ error }: { error?: string }) {
  return (
    <form action={sendMagicLink} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-xs font-medium tracking-[0.01em]">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="name@example.com"
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : "email-error"}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/40"
        />
        {error !== undefined && (
          <p id="email-error" className="text-xs font-medium tracking-[0.01em] text-alarm">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" className="w-full">
        Email me a sign-in link
      </Button>
    </form>
  );
}
