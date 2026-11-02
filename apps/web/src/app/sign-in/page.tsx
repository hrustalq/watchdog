import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { providerNames, type ProviderId } from "@/lib/auth";
import { server } from "@/lib/server";
import { signInWithProvider } from "./actions";
import { SignInForm } from "./sign-in-form";
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

// The sign-in action's own codes, then Better Auth's codes for a magic link that didn't work.
const notices: Record<string, string> = {
  "too-many": "Too many sign-in attempts. Wait a minute, then try again.",
  "send-failed":
    "Watchdog couldn't send the email. Try again in a moment. If it keeps failing, whoever runs this Watchdog should check its mail settings.",
  INVALID_TOKEN: linkFailed,
  EXPIRED_TOKEN: linkFailed,
  ATTEMPTS_EXCEEDED: linkFailed,
};

// A self-hosted install refusing to create a new user, by magic link or OAuth alike. These are
// policy, not failures, so they aren't shown in red.
const refusals: Record<string, string> = {
  setup_pending:
    "This Watchdog isn't set up yet, so nobody can sign up. Whoever runs it will find a setup link in the web container's log. If you just used that link, sign in with the email you entered there.",
  signup_closed:
    "Sign-up is closed on this instance, so Watchdog can't create an account for that email. Ask whoever runs it to open sign-up.",
};

// Codes for an OAuth sign-in that stopped: Better Auth's, the provider's own access_denied (a
// cancel on its page, or an app it refuses), then the sign-in action's. `with` reads "with GitHub",
// or "with that provider" when the URL doesn't say which one the sign-in started with.
const providerNotices: Record<string, (withProvider: string) => string> = {
  email_not_verified: (withProvider) =>
    `The email on that account isn't verified ${withProvider}, so Watchdog can't sign you in with it. Verify it there, or sign in with an email link.`,
  account_not_linked: (withProvider) =>
    `Watchdog couldn't connect your sign-in ${withProvider} to the account that uses this email. Sign in with an email link instead.`,
  access_denied: (withProvider) =>
    `Signing in ${withProvider} was cancelled or refused. Try again, or sign in with an email link.`,
  "start-failed": (withProvider) =>
    `Watchdog couldn't start signing in ${withProvider}. Try again, or sign in with an email link.`,
};

const isProvider = (value: unknown): value is ProviderId =>
  typeof value === "string" && Object.hasOwn(providerNames, value);
const unknownError =
  "Signing in didn't work. Try again. If it keeps failing, whoever runs this Watchdog can find the cause in its log.";

async function SignInFormWithError({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  const { error, email, via } = await searchParams;
  if (typeof error !== "string") return <SignInForm />;
  if (error === "invalid-email") {
    return <SignInForm email={typeof email === "string" ? email : ""} invalidEmail />;
  }
  const providerNotice = providerNotices[error];
  if (providerNotice !== undefined) {
    const withProvider = isProvider(via) ? `with ${providerNames[via]}` : "with that provider";
    return <SignInForm notice={providerNotice(withProvider)} />;
  }
  const refusal = refusals[error];
  if (refusal !== undefined) return <SignInForm notice={refusal} noticeTone="neutral" />;
  return <SignInForm notice={notices[error] ?? unknownError} />;
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
            <SubmitButton variant="outline" pendingLabel={`Opening ${providerNames[id]}…`}>
              Continue with {providerNames[id]}
            </SubmitButton>
          </form>
        ))}
      </div>
    </div>
  );
}
