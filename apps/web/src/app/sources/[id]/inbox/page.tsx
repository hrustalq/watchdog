import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dataBox, textBox } from "@/components/field-classes";
import { Confirming } from "@/components/confirming";
import { PageBar } from "@/components/page-bar";
import { Page, PageHeader } from "@/components/page";
import { Section } from "@/components/section";
import { findInbox, inboxUrl, revealInboxToken } from "@/lib/inbox";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "@/components/notice";
import { replaceInboxTokenAction } from "../../actions";

export const metadata: Metadata = { title: "Webhook inbox · Watchdog" };

// Read without Suspense, so all of it is in the first HTML: the URL is shown only this once, and has to
// reach someone without JavaScript too.
export const instant = false;

const mapped = [
  { field: "title", term: "Title", unmapped: "“Webhook to” and the Source's name" },
  { field: "body", term: "Body", unmapped: "The whole JSON" },
  { field: "url", term: "URL", unmapped: "None" },
  { field: "externalId", term: "External ID", unmapped: "The body's SHA-256 hash" },
] as const;

export default async function InboxPage({ params }: PageProps<"/sources/[id]/inbox">) {
  const [{ workspace }, { id }] = await Promise.all([requireWorkspace(), params]);
  const { db, encryptionKey, baseURL } = server();
  const inbox = await findInbox(db, workspace.id, id);
  if (inbox === undefined) notFound();
  // Last, because a read that fails after this would lose a token nobody saw.
  const token = await revealInboxToken(db, encryptionKey, workspace.id, inbox.id);
  const url = token === undefined ? "<inbox URL>" : inboxUrl(baseURL, token);
  const curl = `curl -X POST -H 'content-type: application/json' -d '{"title":"Hello"}' '${url}'`;

  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Workspace" }, { href: "/sources", label: "Sources" }, { label: inbox.name }]} />
      <Page className="break-words">
        <PageHeader
          title={inbox.name}
          description="A webhook inbox. Each POST of JSON, up to 1 MB, becomes one Item in the Feed, at most 60 a minute."
        />

        {token === undefined ? (
          <Notice role="status">
            The URL for {inbox.name} was already shown. Replace the token if you didn&apos;t keep a copy.
          </Notice>
        ) : (
          <Section id="inbox-url" title="The inbox URL" tone="raised" gap={2}>
            <Notice role="status" tone="plain">
              Copy it now. Watchdog won&apos;t show it again. The token in it is the only proof a request is meant for
              this inbox, so keep it as you would a password.
            </Notice>
            {/* A text box, because Tab, select-all and copy work on it with no JavaScript and from a keyboard. */}
            <textarea
              readOnly
              rows={2}
              aria-labelledby="inbox-url"
              value={url}
              className={`${textBox} ${dataBox} resize-none py-1.5`}
            />
          </Section>
        )}

        <Section id="try-it" title="Try it" gap={2}>
          <p className="text-sm text-muted-foreground">
            Watchdog answers 202 when it captures an Item and 200 when it already has that one.
          </p>
          <textarea
            readOnly
            rows={3}
            aria-labelledby="try-it"
            value={curl}
            className={`${textBox} ${dataBox} resize-none py-1.5`}
          />
        </Section>

        <Section id="mapping" title="Mapping" gap={2}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            {mapped.map(({ field, term, unmapped }) => {
              const path = inbox.mapping[field];
              return (
                <div key={field} className="contents">
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd className="min-w-0 break-all">
                    {path === undefined ? unmapped : <span className="text-data">{path}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </Section>

        <Confirming
          label="Replace the token"
          name={inbox.name}
          warning={`The current URL stops working now, so whatever sends to ${inbox.name} has to be given the new one.`}
          action={replaceInboxTokenAction.bind(null, inbox.id)}
          button="Replace it"
          pendingLabel="Replacing…"
        />
      </Page>
    </div>
  );
}
