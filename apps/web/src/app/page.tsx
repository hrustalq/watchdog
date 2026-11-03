import Link from "next/link";
import { Suspense } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { eq, source } from "@watchdog/db";
import { requireWorkspace, server } from "@/lib/server";
import { signOut } from "./actions";

export default function WorkspacePage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <WorkspaceScreen />
    </Suspense>
  );
}

async function WorkspaceScreen() {
  const { user, workspace, admin } = await requireWorkspace();
  const sources = await server().db.$count(source, eq(source.workspaceId, workspace.id));
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
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        {sources === 0 ? (
          <>
            <h1 className="text-headline">Nothing is being watched yet</h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              This Workspace has no Sources. Once you add one, every Item it captures shows up in
              the Feed here.
            </p>
            <Link href="/sources" className={`${buttonVariants()} mt-6`}>
              Add a Source
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-headline">
              Watching <span className="tabular-nums">{sources}</span>{" "}
              {sources === 1 ? "Source" : "Sources"}
            </h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Every Item they capture shows up in the Feed here.
            </p>
          </>
        )}
      </main>
    </div>
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
