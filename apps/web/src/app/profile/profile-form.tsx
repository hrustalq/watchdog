"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { field, fieldError, label, textBox } from "@/components/field-classes";
import { cn } from "@/lib/utils";
import { SubmitButton } from "../sign-in/submit-button";
import { saveProfileAction } from "./actions";

interface ProfileFormProps {
  body: string;
  language: string;
  /** From `outputLanguages` and `maxProfileBody`, which live with code the browser can't load. */
  languages: { code: string; label: string }[];
  maxBody: number;
  /** The server just refused an over-long body. */
  refused: boolean;
  /** The refused body was too long to come back through a URL. */
  bodyLost: boolean;
}

/**
 * Next.js keeps a page's state when it's navigated away from (Activity), so an abandoned edit would
 * look saved on the way back. A link starts from what's saved, and Back still restores the edit.
 */
export function ProfileForm(props: ProfileFormProps) {
  const { bfcacheId } = useRouter();
  return <Form key={`${bfcacheId}:${props.language}:${props.body}`} {...props} />;
}

function Form({ body: savedBody, language, languages, maxBody, refused, bodyLost }: ProfileFormProps) {
  const [body, setBody] = useState(savedBody);
  const box = useRef<HTMLTextAreaElement>(null);
  const length = body.trim().length;
  const over = length - maxBody;
  const limit = maxBody.toLocaleString("en");

  // The browser refuses the submit itself, so a long draft is never lost on its way to the server's
  // refusal, which can't always bring it back.
  const validity = over > 0 ? `Shorten this to ${limit} characters to save it.` : "";
  useEffect(() => box.current?.setCustomValidity(validity), [validity]);

  const lost = bodyLost && body === savedBody;
  const invalid = over > 0 || lost;

  return (
    <form action={saveProfileAction} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="profile-body" className={label}>
          Who you are and what you track
        </label>
        <p id="profile-body-prompt" className="text-sm text-muted-foreground">
          In your own words: your products, competitors, markets, dependencies and interests. The Agent reads this to
          judge how much an Item matters to you.
        </p>
        <textarea
          ref={box}
          id="profile-body"
          name="body"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          aria-invalid={invalid}
          aria-describedby="profile-body-prompt profile-body-limit"
          // Focus lands here with the refusal, so the field and its message are read together.
          // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
          autoFocus={refused}
          className={cn(textBox, "min-h-64 py-2 leading-[1.5]")}
        />
        <div id="profile-body-limit" className="flex flex-col gap-1">
          {over > 0 ? (
            <p role="alert" className={fieldError}>
              {over.toLocaleString("en")} {over === 1 ? "character" : "characters"} over the limit, so this can&apos;t be
              saved. Shorten it and save again.
            </p>
          ) : null}
          {lost ? (
            <p role="alert" className={fieldError}>
              That wasn&apos;t saved, because it was over the limit and too long to bring back without JavaScript. This
              is your saved Profile.
            </p>
          ) : null}
          <div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
            <p>Up to {limit} characters. It goes to your model provider on every Agent call.</p>
            {/* It can't count without JavaScript, and a frozen count would be wrong. */}
            <p
              className={cn(
                "shrink-0 font-mono tabular-nums [@media(scripting:none)]:hidden",
                over > 0 && "text-alarm",
              )}
            >
              {length.toLocaleString("en")} / {limit}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="profile-language" className={label}>
          Output language
        </label>
        <select
          id="profile-language"
          name="language"
          defaultValue={language}
          aria-describedby="profile-language-note"
          className={cn(field, "bg-background sm:max-w-xs")}
        >
          {languages.map(({ code, label: name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <p id="profile-language-note" className="text-xs text-muted-foreground">
          The language of the Agent&apos;s summaries and rating reasoning. Items keep their original text, and
          Watchdog&apos;s own screens don&apos;t change.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          A saved change applies to Agent calls from now on. Past Items aren&apos;t rated again.
        </p>
        <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start">
          Save Profile
        </SubmitButton>
      </div>
    </form>
  );
}
