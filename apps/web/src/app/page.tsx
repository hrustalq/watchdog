import Link from "next/link";
import { Suspense } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { eq, source } from "@watchdog/db";
import { CategoryList, Rating } from "@/components/rating";
import { Timestamp } from "@/components/timestamp";
import { feedPage, parseCursor, parseTopCursor, topPage, type FeedItem } from "@/lib/feed";
import { getModel } from "@/lib/model";
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
  const latest = params.view === "latest";
  // A malformed cursor is ignored, so the page is the view's first one and keeps refreshing.
  const latestBefore = latest ? parseCursor(params.before) : undefined;
  const topBefore = latest ? undefined : parseTopCursor(params.before);
  const before = latestBefore ?? topBefore;
  const { db } = server();
  const { items, older, fallback } = latest
    ? { ...(await feedPage(db, workspace.id, latestBefore)), fallback: false }
    : await topPage(db, workspace.id, topBefore);
  // Only an empty first page needs to know whether there's anything to watch.
  const sources =
    items.length === 0 && before === undefined
      ? await db.$count(source, eq(source.workspaceId, workspace.id))
      : 0;
  // With no Items the empty state has the Feed's whole story, so there's no order to explain.
  const fallbackNotice = fallback && items.length > 0;
  const hasModel = fallbackNotice && (await getModel(db, workspace.id)) !== undefined;
  // Top's fallback pages through Latest, so its "Show older" goes there.
  const olderView = latest || fallback ? "view=latest&" : "";
  return (
    <div className="flex flex-1 flex-col">
      {/* On a phone the links get a row of their own, under the name and Sign out. */}
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 sm:h-12 sm:flex-nowrap sm:gap-4 sm:py-0">
        <p className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* On a phone the name needs the room more than its label does. */}
          <span className="hidden text-xs font-medium tracking-[0.01em] text-muted-foreground sm:inline">
            Workspace
          </span>
          <span className="truncate text-title">{workspace.name}</span>
        </p>
        <span className="hidden truncate text-sm text-muted-foreground sm:inline">{user.email}</span>
        {/* The negative margin lines the first link's text up with the name above it. */}
        <nav
          aria-label="Workspace"
          className="order-last -ml-3 flex w-full flex-wrap items-center gap-1 sm:order-none sm:ml-0 sm:w-auto sm:shrink-0 sm:flex-nowrap sm:gap-3"
        >
          <Link href="/sources" className={buttonVariants({ variant: "ghost" })}>
            Sources
          </Link>
          <Link href="/rules" className={buttonVariants({ variant: "ghost" })}>
            Rules
          </Link>
          <Link href="/profile" className={buttonVariants({ variant: "ghost" })}>
            Profile
          </Link>
          <Link href="/model" className={buttonVariants({ variant: "ghost" })}>
            Model
          </Link>
          {admin ? (
            <Link href="/settings" className={buttonVariants({ variant: "ghost" })}>
              Settings
            </Link>
          ) : null}
        </nav>
        <form action={signOut} className="shrink-0">
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-8">
        {/* On every page, since a Rating can arrive for an Item on an older one. The key starts it
            afresh on each page, so paging isn't announced as Items arriving. It sits first, so it stays
            mounted when the empty state gives way to the list. */}
        <FeedRefresher
          key={`${latest ? "latest" : "top"}:${before?.id ?? ""}`}
          ids={items.map((row) => row.id)}
        />
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h1 className="text-headline">Feed</h1>
            <div className="flex flex-wrap items-center gap-2">
              {before === undefined ? null : (
                <Link href={latest ? "/?view=latest" : "/"} className={buttonVariants({ variant: "ghost" })}>
                  {latest ? "Back to the newest" : "Back to the top"}
                </Link>
              )}
              <ViewControl latest={latest} />
            </div>
          </div>
          {before === undefined && !fallbackNotice ? (
            <p className="text-sm text-muted-foreground">
              {latest ? "Latest first" : "Rated Items from the last 7 days, most important first"}
            </p>
          ) : null}
        </div>
        {fallbackNotice ? <FallbackNotice hasModel={hasModel} /> : null}
        <FeedBody items={items} paged={before !== undefined} sources={sources} />
        {older === null ? null : (
          <Link
            href={`/?${olderView}before=${older}`}
            className={`${buttonVariants({ variant: "outline" })} self-center`}
          >
            Show older
          </Link>
        )}
      </main>
    </div>
  );
}

/** Top or Latest. The URL holds the choice, so it survives a reload and "Show older". */
function ViewControl({ latest }: { latest: boolean }) {
  const view = (href: string, label: string, selected: boolean) => (
    <Link
      href={href}
      aria-current={selected ? "page" : undefined}
      className={buttonVariants({ variant: selected ? "default" : "ghost" })}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Feed view" className="flex gap-1">
      {view("/", "Top", !latest)}
      {view("/?view=latest", "Latest", latest)}
    </nav>
  );
}

/** Says why Top is showing Latest order: no Item in its window has a Rating. */
function FallbackNotice({ hasModel }: { hasModel: boolean }) {
  return (
    <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
      {hasModel ? (
        "Showing Latest order, because no Item captured in the last 7 days has a Rating yet."
      ) : (
        <>
          Showing Latest order, because Top ranks rated Items and this Workspace has no model to rate
          them.{" "}
          <Link
            href="/model"
            className="rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            Add a model
          </Link>
        </>
      )}
    </p>
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
                aria-describedby={`rating-${row.id}`}
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
            <p className="line-clamp-2 max-w-[70ch] text-sm break-words text-muted-foreground">
              {row.excerpt}
            </p>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium tracking-[0.01em]">
            <Rating id={`rating-${row.id}`} severity={row.severity} importance={row.importance} />
            <CategoryList categories={row.categories} />
            <span className="min-w-0 break-words text-muted-foreground">{row.sourceName}</span>
            {row.isBackfill ? (
              <span className="rounded-sm bg-muted px-1.5 py-0.5">Backfill</span>
            ) : null}
          </div>
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
