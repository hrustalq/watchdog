"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { field, fieldError, label, textBox } from "@/components/field-classes";
import { cn } from "@/lib/utils";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { saveProfileAction } from "./actions";

interface ProfileFormProps {
  body: string;
  language: string;
  /** From `outputLanguages` and `maxProfileBody`, which live with code the browser can't load. */
  languages: { code: string; label: string }[];
  maxBody: number;
  /** The server just refused an over-long body, which only happens without JavaScript. */
  refused: boolean;
  justSaved: boolean;
}

/**
 * Next.js keeps a page's state when it's navigated away from (Activity), so an abandoned edit would
 * look saved on the way back. A link starts from what's saved, and Back still restores the edit.
 */
export function ProfileForm(props: ProfileFormProps) {
  const { bfcacheId } = useRouter();
  return <Form key={bfcacheId} {...props} />;
}

function Form({ body: savedBody, language: savedLanguage, languages, maxBody, refused, justSaved }: ProfileFormProps) {
  const [body, setBody] = useState(savedBody);
  const [language, setLanguage] = useState(savedLanguage);
  const box = useRef<HTMLTextAreaElement>(null);
  const length = body.trim().length;
  const over = length > maxBody;
  const dirty = body.trim() !== savedBody || language !== savedLanguage;
  const lost = refused && !dirty;
  const limit = maxBody.toLocaleString("en");

  return (
    <form
      action={saveProfileAction}
      onSubmit={(event) => {
        // Stopped here, the draft stays. The server's refusal can't bring it back.
        if (over) {
          event.preventDefault();
          box.current?.focus();
        }
      }}
      className="flex flex-col gap-6"
    >
      {justSaved ? (
        // A new key for each saved change, so a second save is announced like the first.
        <Notice
          key={`${savedLanguage}:${savedBody}`}
          role="status"
          className={cn("rounded-lg bg-muted px-3 py-2 text-sm", dirty && "hidden")}
        >
          Profile saved.
        </Notice>
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor="profile-body" className={label}>
          Who you are and what you track
        </label>
        <p id="profile-body-prompt" className="max-w-[70ch] text-sm text-muted-foreground">
          In your own words: your products, competitors, markets, dependencies and interests. The Agent reads this to
          judge how much an Item matters to you. It goes to your model provider on every Agent call, and its length adds
          to what each call costs.
          {savedBody === "" ? " Until you write this, the Agent has nothing about you to judge Importance by." : null}
        </p>
        <textarea
          ref={box}
          id="profile-body"
          name="body"
          dir="auto"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          placeholder="I run a small analytics app for online shops. I track rival apps, pricing changes in my niche, and the payment APIs I depend on."
          aria-invalid={over || lost}
          aria-describedby="profile-body-prompt profile-body-limit"
          // Focus lands here with the refusal, so the field and its message are read together.
          // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
          autoFocus={refused}
          className={cn(textBox, "min-h-64 py-2 leading-[1.5]")}
        />
        <div id="profile-body-limit" className="flex flex-col gap-1">
          {/* No number in these: a live region would read the whole sentence on every keystroke. */}
          {over ? (
            <p role="alert" className={fieldError}>
              Over the limit, so this can&apos;t be saved. Shorten it and save again.
            </p>
          ) : null}
          {lost ? (
            <p role="alert" className={fieldError}>
              That wasn&apos;t saved, because it was over the limit. Without JavaScript it can&apos;t come back here, but
              your browser&apos;s Back button may still have it. This is your saved Profile.
            </p>
          ) : null}
          <div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
            <p>Up to {limit} characters.</p>
            {/* It can't count without JavaScript, and a frozen count would be wrong. */}
            <p className={cn("shrink-0 font-mono tabular-nums [@media(scripting:none)]:hidden", over && "text-alarm")}>
              {length.toLocaleString("en")} of {limit}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="profile-language" className={label}>
          Output language
        </label>
        {/* Uncontrolled: React resets a form after its action, and that takes a controlled select back
            to its first option. The key moves the value a reset returns to along with what's saved. */}
        <select
          key={savedLanguage}
          id="profile-language"
          name="language"
          defaultValue={savedLanguage}
          onChange={(event) => {
            setLanguage(event.target.value);
          }}
          aria-describedby="profile-language-note"
          className={cn(field, "bg-background sm:max-w-xs")}
        >
          {languages.map(({ code, label: name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <p id="profile-language-note" className="max-w-[70ch] text-xs text-muted-foreground">
          The language of the Agent&apos;s summaries and rating reasoning. Items keep their original text, and
          Watchdog&apos;s own screens don&apos;t change.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          {dirty ? <strong className="font-medium text-foreground">Unsaved changes. </strong> : null}A saved change
          applies to Agent calls from now on. Past Items aren&apos;t rated again.
        </p>
        <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start">
          Save Profile
        </SubmitButton>
      </div>
    </form>
  );
}
