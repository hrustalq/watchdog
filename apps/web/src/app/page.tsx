import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { eq, source } from "@watchdog/db";
import { CategoryList, Rating } from "@/components/rating";
import { Timestamp } from "@/components/timestamp";
import { feedPage, parseCursor, parseTopCursor, topPage, type FeedItem } from "@/lib/feed";
import { hasActiveModel } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { signOut } from "./actions";
import { RatingStepper } from "./correct-rating";
import { FeedRefresher } from "./feed-refresher";
import { modelLink } from "./rules/words";

// The data is read without Suspense, so the Feed is in the first HTML, which is how it and its
// Correction forms work without JavaScript.
export const instant = false;

/** The Feed's URL. It holds the view, the page and editing mode, so they survive a reload. */
function feedHref(latest: boolean, edit: boolean, before?: string) {
  const query = new URLSearchParams();
  if (latest) query.set("view", "latest");
  if (before !== undefined) query.set("before", before);
  if (edit) query.set("edit", "1");
  const text = query.toString();
  return text === "" ? "/" : `/?${text}`;
}

export default async function WorkspacePage({ searchParams }: PageProps<"/">) {
  const [{ user, workspace, admin }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const latest = params.view === "latest";
  const edit = params.edit === "1";
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
  // With no Items the empty state has the Feed's whole story, so Top has no order to explain.
  const caption = before === undefined && !(fallback && items.length === 0);
  const hasModel = fallback && caption && (await hasActiveModel(db, workspace.id));
  return (
    <div className="flex flex-1 flex-col">
      {/* Below md the links get a row of their own, under the name and Sign out, which they'd otherwise crush. */}
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 md:h-12 md:flex-nowrap md:gap-4 md:py-0">
        <p className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* Until there's room for both, the name needs it more than its label does. */}
          <span className="hidden text-xs font-medium tracking-[0.01em] text-muted-foreground lg:inline">
            Workspace
          </span>
          <span className="truncate text-title">{workspace.name}</span>
        </p>
        <span className="hidden truncate text-sm text-muted-foreground lg:inline">{user.email}</span>
        {/* The negative margin lines the first link's text up with the name above it. */}
        <nav
          aria-label="Workspace"
          className="order-last -ml-3 flex w-full flex-wrap items-center gap-1 md:order-none md:ml-0 md:w-auto md:shrink-0 md:flex-nowrap md:gap-3"
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
          <Link href="/usage" className={buttonVariants({ variant: "ghost" })}>
            Usage
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
      {/* The list ignores clicks while its rows settle, which FeedRefresher signals. */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-8 [&:has([data-settling])_ol]:pointer-events-none">
        {/* On every page, since a Rating can arrive for an Item on an older one. The key starts it
            afresh on each page, so paging isn't announced as Items arriving. It sits first, so it stays
            mounted when the empty state gives way to the list. */}
        <FeedRefresher key={[latest, fallback, before?.id].join()} ids={items.map((row) => row.id)} paused={edit} />
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h1 className="text-headline">Feed</h1>
            <div className="flex flex-wrap items-center gap-3">
              {items.length === 0 ? null : (
                // Outline in both states, because the only fill here says which view is selected.
                <Link
                  href={feedHref(latest, !edit, typeof params.before === "string" ? params.before : undefined)}
                  className={buttonVariants({ variant: "outline" })}
                >
                  {edit ? "Done" : "Correct Ratings"}
                </Link>
              )}
              <ViewControl latest={latest} edit={edit} />
            </div>
          </div>
          {caption ? (
            <p className="text-sm text-muted-foreground">
              <FeedCaption latest={latest} fallback={fallback} hasModel={hasModel} />
            </p>
          ) : null}
          {before === undefined ? null : (
            // The negative margin lines the link's text up with the heading above it.
            <Link
              href={feedHref(latest, edit)}
              className={`${buttonVariants({ variant: "ghost" })} -ml-3 self-start`}
            >
              {latest ? "Back to the newest" : "Back to the first page"}
            </Link>
          )}
        </div>
        <FeedBody items={items} paged={before !== undefined} sources={sources} edit={edit} />
        {older === null ? null : (
          <Link
            // Top's fallback pages through Latest, so its "Show older" goes there.
            href={feedHref(latest || fallback, edit, older)}
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
function ViewControl({ latest, edit }: { latest: boolean; edit: boolean }) {
  const view = (href: string, label: string, selected: boolean) => (
    <Link
      href={href}
      aria-current={selected ? "true" : undefined}
      // Forced colors drop the fill, which would leave the two views looking the same.
      className={`${buttonVariants({ variant: selected ? "default" : "ghost" })} ${selected ? "forced-color-adjust-none forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]" : ""}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Feed view" className="flex gap-1">
      {view(feedHref(false, edit), "Top", !latest)}
      {view(feedHref(true, edit), "Latest", latest)}
    </nav>
  );
}

/** What the list shows, including why Top is showing Latest order when no Item in its window is rated. */
function FeedCaption({ latest, fallback, hasModel }: { latest: boolean; fallback: boolean; hasModel: boolean }) {
  if (latest) return "Latest first";
  if (!fallback) return "Rated Items captured in the last 7 days, ranked by Importance and Severity";
  if (hasModel) return "Showing Latest order, because no Item captured in the last 7 days has a Rating.";
  // A model only rates what's captured after it's added, so the link promises new Items only.
  return (
    <>
      Showing Latest order, because Top ranks rated Items and this Workspace has no model.{" "}
      <Link
        href={modelLink}
        className="rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        Add a model to rate new Items
      </Link>
    </>
  );
}

function FeedBody({
  items,
  paged,
  sources,
  edit,
}: {
  items: FeedItem[];
  paged: boolean;
  sources: number;
  edit: boolean;
}) {
  if (items.length > 0) return <FeedList items={items} edit={edit} />;
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

function FeedList({ items, edit }: { items: FeedItem[]; edit: boolean }) {
  return (
    <ol className="divide-y overflow-hidden rounded-lg border">
      {items.map((row) => (
        // The title's link covers the row, so the whole row opens the Item. A Correction posted without
        // JavaScript comes back to the row's id.
        <li key={row.id} id={`item-${row.id}`} className="relative flex scroll-mt-4 flex-col gap-1 px-4 py-3 hover:bg-card">
          <div className="flex flex-col gap-x-4 sm:flex-row sm:items-baseline sm:justify-between">
            <h2 className="text-title min-w-0 break-words">
              <Link
                href={`/items/${row.id}`}
                aria-describedby={
                  edit && row.severity !== null && row.importance !== null
                    ? `rating-${row.id}-severity rating-${row.id}-importance`
                    : `rating-${row.id}`
                }
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
            {edit && row.severity !== null && row.importance !== null ? (
              <RatingStepper
                itemId={row.id}
                title={row.title ?? "Untitled Item"}
                severity={row.severity}
                importance={row.importance}
              />
            ) : (
              <Rating id={`rating-${row.id}`} severity={row.severity} importance={row.importance} />
            )}
            {edit && (row.severity === null || row.importance === null) ? (
              // An unrated Item takes both axes at once, which needs more room than a row has.
              <Link
                href={`/items/${row.id}#rating`}
                className="relative inline-flex min-h-6 items-center rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                Rate<span className="sr-only"> {row.title ?? "Untitled Item"}</span>
              </Link>
            ) : null}
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

