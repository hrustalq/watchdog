import { dataBox, textBox } from "@/components/field-classes";
import { Notice } from "@/components/notice";
import { Section } from "@/components/section";

/** The one time a webhook secret is shown. A reload doesn't show it again. */
export function SecretPanel({ secret, name }: { secret: string; name: string | undefined }) {
  return (
    <Section id="secret" title={<>The secret for {name ?? "this webhook"}</>} tone="raised" gap={2}>
      <Notice role="status" tone="plain">
        Copy it now. Watchdog won&apos;t show it again. Your receiver uses it to check the{" "}
        <code className="text-data">X-Watchdog-Signature</code> header on every call.
      </Notice>
      {/* A text box, because Tab, select-all and copy work on it with no JavaScript and from a keyboard. */}
      <textarea
        readOnly
        rows={2}
        aria-labelledby="secret"
        value={secret}
        className={`${textBox} ${dataBox} resize-none py-1.5`}
      />
    </Section>
  );
}
