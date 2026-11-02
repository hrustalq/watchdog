import { sendMagicLink } from "./actions";
import { SubmitButton } from "./submit-button";

/**
 * The email field that asks for a magic link. The setup page submits it to its own action, with the
 * setup token as a hidden field.
 */
export function SignInForm({
  action = sendMagicLink,
  hidden,
  email = "",
  invalidEmail = false,
  notice,
}: {
  action?: (formData: FormData) => Promise<void>;
  hidden?: React.ReactNode;
  email?: string;
  invalidEmail?: boolean;
  notice?: string;
}) {
  return (
    <form action={action} className="flex flex-col gap-4">
      {hidden}
      {notice === undefined ? null : (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-alarm">
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
      <SubmitButton pendingLabel="Sending link…">Email me a sign-in link</SubmitButton>
    </form>
  );
}
