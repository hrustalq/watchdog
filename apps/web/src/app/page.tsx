import Link from "next/link";
import { Suspense } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { eq, source } from "@watchdog/db";
import { Timestamp } from "@/components/timestamp";
import { feedPage, parseCursor, type FeedItem } from "@/lib/feed";
import { requireWorkspace, server } from "@/lib/server";
import { signOut } from "./actions";
import { FeedRefresher } from "./feed-refresher";

export default function WorkspacePage({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <WorkspaceScreen searchParams={searchParams} />
    </Suspense>
  );
}

async function WorkspaceScreen({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const [{ user, workspace, admin }, params] = await Promise.all([requireWorkspace(), searchParams]);
  // A malformed cursor is ignored, so the page is the newest one and keeps refreshing.
  const before = parseCursor(params.before);
  const { db } = server();
  const { items, older } = await feedPage(db, workspace.id, before);
  // Only an empty newest page needs to know whether there's anything to watch.
  const sources =
    items.length === 0 && before === undefined
      ? await db.$count(source, eq(source.workspaceId, workspace.id))
      : 0;
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-12 items-center justify-between gap-2 border-b px-4 sm:gap-4">
        <p className="flex min-w-0 items-baseline gap-2">
          {/* On a phone the name needs the room more than its label does. */}
          <span className="hidden text-xs font-medium tracking-[0.01em] text-muted-foreground sm:inline">
            Workspace
          </span>
          <span className="truncate text-title">{workspace.name}</span>
        </p>
        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">
            {user.email}
          </span>
          <Link href="/sources" className={buttonVariants({ variant: "ghost" })}>
            Sources
          </Link>
          <Link href="/rules" className={buttonVariants({ variant: "ghost" })}>
            Rules
          </Link>
          {admin ? (
            <Link href="/settings" className={buttonVariants({ variant: "ghost" })}>
              Settings
            </Link>
          ) : null}
          <form action={signOut}>
            <Button type="submit" variant="outline">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-8">
        {/* Only the newest page changes as Items arrive. It sits first, so it stays mounted when the
            empty state gives way to the list. */}
        {before === undefined ? <FeedRefresher ids={items.map((row) => row.id)} /> : null}
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-headline">Feed</h1>
          {before === undefined ? (
            <p className="text-sm text-muted-foreground">Latest first</p>
          ) : (
            <Link href="/" className={buttonVariants({ variant: "ghost" })}>
              Back to the newest
            </Link>
          )}
        </div>
        <FeedBody items={items} paged={before !== undefined} sources={sources} />
        {older === null ? null : (
          <Link
            href={`/?before=${older}`}
            className={`${buttonVariants({ variant: "outline" })} self-center`}
          >
            Show older
          </Link>
        )}
      </main>
    </div>
  );
}

function FeedBody({ items, paged, sources }: { items: FeedItem[]; paged: boolean; sources: number }) {
  if (items.length > 0) return <FeedList items={items} />;
  if (paged) return <p className="text-sm text-muted-foreground">No older Items.</p>;
  if (sources === 0) {
    return (
      <EmptyState title="Nothing is being watched yet">
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          This Workspace has no Sources. Once you add one, every Item it captures shows up in the
          Feed here.
        </p>
        <Link href="/sources" className={`${buttonVariants()} mt-6`}>
          Add a Source
        </Link>
      </EmptyState>
    );
  }
  return (
    <EmptyState title="No Items yet">
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Your first poll runs within a minute. The Items it captures show up here on their own.
      </p>
    </EmptyState>
  );
}

function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
      <h2 className="text-headline">{title}</h2>
      {children}
    </div>
  );
}

function FeedList({ items }: { items: FeedItem[] }) {
  return (
    <ol className="divide-y overflow-hidden rounded-lg border">
      {items.map((row) => (
        // The title's link covers the row, so the whole row opens the Item.
        <li key={row.id} className="relative flex flex-col gap-1 px-4 py-3 hover:bg-card">
          <div className="flex flex-col gap-x-4 sm:flex-row sm:items-baseline sm:justify-between">
            <h2 className="text-title min-w-0 break-words">
              <Link
                href={`/items/${row.id}`}
                className="rounded-sm outline-none after:absolute after:inset-0 focus-visible:after:ring-3 focus-visible:after:ring-inset focus-visible:after:ring-ring/30"
              >
                {row.title ?? "Untitled Item"}
              </Link>
            </h2>
            <p className="shrink-0 text-muted-foreground">
              {row.publishedAt === null ? (
                <>
                  <span className="text-xs">Captured </span>
                  <Timestamp at={row.capturedAt} />
                </>
              ) : (
                <Timestamp at={row.publishedAt} />
              )}
            </p>
          </div>
          {row.excerpt === "" ? null : (
            <p className="line-clamp-1 max-w-[70ch] text-sm break-words text-muted-foreground">
              {row.excerpt}
            </p>
          )}
          <p className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-[0.01em]">
            <span className="text-muted-foreground">{row.sourceName}</span>
            {row.isBackfill ? (
              <span className="rounded-sm bg-muted px-1.5 py-0.5">Backfill</span>
            ) : null}
          </p>
        </li>
      ))}
    </ol>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <div className="h-4 w-32 rounded-sm bg-muted" />
        <div className="h-8 w-20 rounded-lg bg-muted" />
      </header>
      <main className="flex-1" />
    </div>
  );
}
