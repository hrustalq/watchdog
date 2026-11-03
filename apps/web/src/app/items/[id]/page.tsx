import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Timestamp } from "@/components/timestamp";
import { itemWithLog } from "@/lib/feed";
import { requireWorkspace, server } from "@/lib/server";

export const metadata: Metadata = { title: "Item · Watchdog" };

export default function ItemPage({ params }: PageProps<"/items/[id]">) {
  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link
          href="/"
          className="rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          Feed
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page">Item</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col px-4 py-8">
        <Suspense fallback={<div aria-busy="true" className="h-48 rounded-lg bg-muted" />}>
          <ItemDetail params={params} />
        </Suspense>
      </main>
    </div>
  );
}

async function ItemDetail({ params }: Pick<PageProps<"/items/[id]">, "params">) {
  const [{ workspace }, { id }] = await Promise.all([requireWorkspace(), params]);
  // Another Workspace's Item is missing too, so its id says nothing about whether it exists.
  const found = (await itemWithLog(server().db, workspace.id, id)) ?? notFound();

  const envelope = [
    { term: "Source", detail: found.source.name },
    { term: "Author", detail: found.author ?? <Missing>None given</Missing> },
    {
      term: "Published",
      detail: found.publishedAt === null ? <Missing>No date given</Missing> : <Timestamp at={found.publishedAt} />,
    },
    { term: "Captured", detail: <Timestamp at={found.capturedAt} /> },
    {
      term: "Language",
      detail: found.language === null ? <Missing>Not detected</Missing> : <span className="font-mono">{found.language}</span>,
    },
    { term: "Backfill", detail: found.isBackfill ? "Yes, from the Source's first fetch" : "No" },
  ];

  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-headline break-words">{found.title ?? "Untitled Item"}</h1>
        {found.url === null ? null : (
          <a
            href={found.url}
            rel="noreferrer"
            className="self-start rounded-sm font-mono text-[0.8125rem] break-all text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            {found.url}
          </a>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          {envelope.map(({ term, detail }) => (
            <div key={term} className="contents">
              <dt className="text-xs leading-5 font-medium tracking-[0.01em] text-muted-foreground">{term}</dt>
              <dd className="min-w-0 break-words">{detail}</dd>
            </div>
          ))}
        </dl>
      </header>
      {found.body === "" ? (
        <p className="text-sm text-muted-foreground">The Source gave no text for this Item.</p>
      ) : (
        <p className="max-w-[70ch] text-base leading-[1.6] break-words">{found.body}</p>
      )}
      <section aria-labelledby="log" className="flex flex-col gap-3">
        <h2 id="log" className="text-title">
          Log
        </h2>
        <ol className="divide-y rounded-lg border bg-muted font-mono text-[0.8125rem]">
          {found.log.map((row) => (
            <li key={row.id} className="flex flex-col gap-x-4 px-3 py-2 sm:flex-row">
              <Timestamp at={row.at} seconds className="shrink-0 text-muted-foreground" />
              <span className="shrink-0 sm:w-16">{row.stage}</span>
              <span className="min-w-0 break-words">{row.message}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
