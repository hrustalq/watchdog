import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { providerNames } from "@/lib/auth";
import { server } from "@/lib/server";
import { sendMagicLink, signInWithProvider } from "./actions";
import { SubmitButton } from "./submit-button";

export const metadata: Metadata = { title: "Sign in · Watchdog" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-headline">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we&apos;ll send you a link that signs you in. No password needed.
        </p>
      </div>
      {/* The form is in the static shell; an error, read from the URL, streams in over it. */}
      <Suspense fallback={<SignInForm />}>
        <SignInFormWithError searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={null}>
        <ProviderButtons />
      </Suspense>
    </>
  );
}

const linkFailed =
  "That sign-in link has expired or was already used. Enter your email to get a new one.";

// The sign-in action's own codes, Better Auth's codes for a magic link that didn't work, then its
// codes for an OAuth sign-in that a provider's unverified email stopped.
const notices: Record<string, string> = {
  "too-many": "Too many sign-in links were requested. Wait a minute, then try again.",
  "send-failed":
    "Watchdog couldn't send the email. Try again in a moment. If it keeps failing, whoever runs this Watchdog should check its mail settings.",
  INVALID_TOKEN: linkFailed,
  EXPIRED_TOKEN: linkFailed,
  ATTEMPTS_EXCEEDED: linkFailed,
  email_not_verified:
    "That account's email isn't verified with the provider, so Watchdog can't sign you in with it. Verify the email there, or sign in with an email link.",
  account_not_linked:
    "This email already has a Watchdog account, and the provider didn't confirm the email is yours. Sign in with an email link instead.",
};
const unknownError =
  "Signing in didn't work. Try again. If it keeps failing, whoever runs this Watchdog can find the cause in its log.";

async function SignInFormWithError({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  const { error, email } = await searchParams;
  // access_denied: the person cancelled on the provider's page, which needs no notice.
  if (typeof error !== "string" || error === "access_denied") return <SignInForm />;
  if (error === "invalid-email") {
    return <SignInForm email={typeof email === "string" ? email : ""} invalidEmail />;
  }
  return <SignInForm notice={notices[error] ?? unknownError} />;
}

function SignInForm({
  email = "",
  invalidEmail = false,
  notice,
}: {
  email?: string;
  invalidEmail?: boolean;
  notice?: string;
}) {
  return (
    <form action={sendMagicLink} className="flex flex-col gap-4">
      {notice === undefined ? null : (
        <p role="alert" className="rounded-lg bg-destructive/20 px-3 py-2 text-sm text-alarm">
          {notice}
        </p>
      )}
      <div className="flex flex-col gap-2">
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
          defaultValue={email}
          aria-invalid={invalidEmail}
          aria-describedby={invalidEmail ? "email-error" : undefined}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-3 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/40 sm:text-sm"
        />
        {invalidEmail ? (
          <p id="email-error" role="alert" className="text-xs font-medium tracking-[0.01em] text-alarm">
            Enter a full email address, like name@example.com.
          </p>
        ) : null}
      </div>
      <SubmitButton />
    </form>
  );
}

/** Read per request: which providers are on comes from the runtime environment, not the build. */
async function ProviderButtons() {
  await connection();
  const { providers } = server();
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-3 text-xs font-medium tracking-[0.01em] text-muted-foreground">
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        or
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </p>
      <div className="flex flex-col gap-2">
        {providers.map((id) => (
          <form key={id} action={signInWithProvider.bind(null, id)}>
            <Button type="submit" variant="outline" className="w-full">
              Continue with {providerNames[id]}
            </Button>
          </form>
        ))}
      </div>
    </div>
  );
}
