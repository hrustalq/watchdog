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
        <p className="truncate text-base font-semibold tracking-tight">{workspace.name}</p>
        <div className="flex items-center gap-3">
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
        <h1 className="text-2xl leading-tight font-[650] tracking-[-0.02em]">
          Nothing is being watched yet
        </h1>
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
      <header className="flex h-12 items-center border-b px-4">
        <div className="h-4 w-32 rounded-sm bg-muted" />
      </header>
    </div>
  );
}
