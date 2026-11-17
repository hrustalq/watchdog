import { TextField } from "@/components/form-field";
import { SubmitButton } from "@/components/submit-button";
import Link from "next/link";
import { textLink } from "@/components/field-classes";

/** What a refused Destination's form says beside the field it's about. */
export interface AddDestinationError {
  field: string;
  message: string;
}

/** A page's own form action: the Destinations screen's, or the guided setup's. */
type FormAction = (formData: FormData) => void | Promise<void>;

const configurationPage = "https://knowledge.hrustalq.dev/documents/8e6aedb7-ccc1-4057-9f9f-2a881d612d47";

function AddForm({ title, open, children }: { title: string; open: boolean; children: React.ReactNode }) {
  return (
    // Display stays the summary's own, because flex would take away the marker that says it opens.
    <details name="add-destination" open={open}>
      <summary className="cursor-pointer rounded-lg border border-transparent px-4 py-3 text-sm font-medium outline-hidden select-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset">
        {title}
      </summary>
      <div className="p-4 pt-2">{children}</div>
    </details>
  );
}

function NameField({
  id,
  value,
  error,
  placeholder = "Team inbox",
}: {
  id: string;
  value: string;
  error: AddDestinationError | undefined;
  placeholder?: string;
}) {
  return (
    <TextField
      id={id}
      name="name"
      label="Name"
      type="text"
      placeholder={placeholder}
      defaultValue={value}
      error={error?.field === "name" ? error.message : undefined}
      help="Actions refer to it by this name."
      maxLength={200}
      autoComplete="off"
      spellCheck={false}
      required
    />
  );
}

/**
 * The email form. It is the Destinations screen's form, reused by the guided setup with its own
 * action and any hidden fields the step needs; the wording and fields are the screen's.
 */
export function EmailDestinationForm({
  action,
  open,
  values = { name: "", address: "" },
  error,
  hidden,
}: {
  action: FormAction;
  open: boolean;
  values?: { name: string; address: string };
  error?: AddDestinationError | undefined;
  hidden?: React.ReactNode;
}) {
  return (
    <AddForm title="Email address" open={open}>
      <form action={action} className="flex flex-col gap-4">
        {hidden}
        <NameField id="email-name" value={values.name} error={error} />
        <TextField
          id="address"
          name="address"
          label="Address"
          type="email"
          placeholder="you@example.com"
          defaultValue={values.address}
          error={error?.field === "address" ? error.message : undefined}
          help="Any address but your own gets a link to confirm it, and receives nothing until then."
          required
          maxLength={2048}
          autoComplete="email"
          spellCheck={false}
        />
        <SubmitButton pendingLabel="Adding…" className="sm:w-auto sm:self-start">
          Add email address
        </SubmitButton>
      </form>
    </AddForm>
  );
}

/** The webhook form, as the Destinations screen shows it: its URL never comes back in a URL. */
export function WebhookDestinationForm({
  action,
  open,
  values = { name: "" },
  error,
  hidden,
}: {
  action: FormAction;
  open: boolean;
  values?: { name: string };
  error?: AddDestinationError | undefined;
  hidden?: React.ReactNode;
}) {
  return (
    <AddForm title="Webhook URL" open={open}>
      <form action={action} className="flex flex-col gap-4">
        {hidden}
        <NameField id="webhook-name" value={values.name} error={error} />
        <TextField
          id="webhook-url"
          name="url"
          label="URL"
          type="url"
          placeholder="https://example.com/watchdog"
          defaultValue=""
          error={error?.field === "url" ? error.message : undefined}
          help="Watchdog generates a signing secret and shows it once. The URL should answer directly, because a redirect can drop the request's body and signature."
          required
          maxLength={2048}
          autoComplete="off"
          spellCheck={false}
        />
        <SubmitButton pendingLabel="Adding…" className="sm:w-auto sm:self-start">
          Add webhook
        </SubmitButton>
      </form>
    </AddForm>
  );
}

/**
 * The Telegram form. An install with no bot offers the same explanation the Destinations screen
 * gives instead of a form it would refuse.
 */
export function TelegramDestinationForm({
  action,
  open,
  values = { name: "" },
  error,
  hidden,
  available,
}: {
  action: FormAction;
  open: boolean;
  values?: { name: string };
  error?: AddDestinationError | undefined;
  hidden?: React.ReactNode;
  available: boolean;
}) {
  return (
    <AddForm title="Telegram chat" open={open}>
      {available ? (
        <form action={action} className="flex flex-col gap-4">
          {hidden}
          <NameField id="telegram-name" value={values.name} error={error} placeholder="Ops alerts" />
          <p className="text-sm text-muted-foreground">
            Next, Watchdog gives you a link and a command to link a private chat or a group.
          </p>
          <SubmitButton pendingLabel="Adding…" className="sm:w-auto sm:self-start">
            Add Telegram chat
          </SubmitButton>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Telegram isn&apos;t set up on this install. Whoever runs this Watchdog can set{" "}
          <code className="text-data">TELEGRAM_BOT_TOKEN</code>, as the{" "}
          <Link href={configurationPage} className={textLink}>
            Configuration page
          </Link>{" "}
          describes.
        </p>
      )}
    </AddForm>
  );
}
