import { sendMagicLink } from "./actions";
import { TextField } from "@/components/form-field";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";

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
        <Notice role={noticeTone === "alarm" ? "alert" : "status"} tone={noticeTone === "alarm" ? "failed" : "quiet"}>
          {notice}
        </Notice>
      )}
      <TextField
        id="email"
        name="email"
        label="Email"
        type="email"
        required
        autoComplete="email"
        placeholder="name@example.com"
        defaultValue={email}
        error={invalidEmail ? "Enter a full email address, like name@example.com." : undefined}
      />
      <SubmitButton pendingLabel="Sending link…">Email me a sign-in link</SubmitButton>
    </form>
  );
}
