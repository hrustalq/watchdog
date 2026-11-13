import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dataBox, textBox } from "@/components/field-classes";
import { Confirming } from "@/components/confirming";
import { findInbox, inboxUrl, revealInboxToken } from "@/lib/inbox";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "../../../sign-in/notice";
import { replaceInboxTokenAction } from "../../actions";

export const metadata: Metadata = { title: "Webhook inbox · Watchdog" };

// Read without Suspense, so all of it is in the first HTML: the URL is shown only this once, and has to
// reach someone without JavaScript too.
export const instant = false;

const crumb =
  "rounded-sm text-muted-foreground underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/60";

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
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link href="/" className={crumb}>
          Workspace
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <Link href="/sources" className={crumb}>
          Sources
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page" className="truncate">
          {inbox.name}
        </span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 break-words">
        <div className="flex flex-col gap-1">
          <h1 className="text-headline">{inbox.name}</h1>
          <p className="text-sm text-muted-foreground">
            A webhook inbox. Each POST of JSON, up to 1 MB, becomes one Item in the Feed, at most 60 a minute.
          </p>
        </div>

        {token === undefined ? (
          <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
            The URL for {inbox.name} was already shown. Replace the token if you didn&apos;t keep a copy.
          </Notice>
        ) : (
          <section aria-labelledby="inbox-url" className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h2 id="inbox-url" className="text-title">
              The inbox URL
            </h2>
            <Notice role="status" className="text-sm">
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
          </section>
        )}

        <section aria-labelledby="try-it" className="flex flex-col gap-2">
          <h2 id="try-it" className="text-title">
            Try it
          </h2>
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
        </section>

        <section aria-labelledby="mapping" className="flex flex-col gap-2">
          <h2 id="mapping" className="text-title">
            Mapping
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            {mapped.map(({ field, term, unmapped }) => {
              const path = inbox.mapping[field];
              return (
                <div key={field} className="contents">
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd className="min-w-0 break-all">
                    {path === undefined ? unmapped : <span className="font-mono text-[0.8125rem]">{path}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>

        <Confirming
          label="Replace the token"
          name={inbox.name}
          warning={`The current URL stops working now, so whatever sends to ${inbox.name} has to be given the new one.`}
          action={replaceInboxTokenAction.bind(null, inbox.id)}
          button="Replace it"
          pendingLabel="Replacing…"
        />
      </main>
    </div>
  );
}
