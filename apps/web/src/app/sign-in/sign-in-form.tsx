import { sendMagicLink } from "./actions";
import { Notice } from "./notice";
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
  noticeTone = "alarm",
}: {
  action?: (formData: FormData) => Promise<void>;
  hidden?: React.ReactNode;
  email?: string;
  invalidEmail?: boolean;
  notice?: string | undefined;
  /** Alarm for something that went wrong; neutral for a refusal the instance means to make. */
  noticeTone?: "alarm" | "neutral";
}) {
  return (
    <form action={action} className="flex flex-col gap-4">
      {hidden}
      {notice === undefined ? null : (
        <Notice
          role={noticeTone === "alarm" ? "alert" : "status"}
          className={`rounded-lg px-3 py-2 text-sm ${noticeTone === "alarm" ? "bg-destructive/10 text-alarm" : "bg-muted text-foreground"}`}
        >
          {notice}
        </Notice>
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
          // Focus lands here with the error, so the field and its message are read together.
          // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an invalid-email error to fix
          autoFocus={invalidEmail}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-3 text-base transition-colors outline-hidden placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/40 sm:text-sm"
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
