import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/server";
import { signOut } from "./actions";

export default function WorkspacePage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <WorkspaceScreen />
    </Suspense>
  );
}

async function WorkspaceScreen() {
  const { user, workspace } = await requireWorkspace();
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-12 items-center justify-between gap-4 border-b px-4">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="text-xs font-medium tracking-[0.01em] text-muted-foreground">
            Workspace
          </span>
          <span className="truncate text-title">{workspace.name}</span>
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">
            {user.email}
          </span>
          <form action={signOut}>
            <Button type="submit" variant="outline">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <h1 className="text-headline">Nothing is being watched yet</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          This Workspace has no Sources. Once you add one, every Item it captures shows up in the
          Feed here.
        </p>
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
