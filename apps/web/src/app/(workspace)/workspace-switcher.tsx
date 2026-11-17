"use client";

import Link from "next/link";
import { Check, ChevronsUpDown, Plus, Settings2 } from "lucide-react";
import { switchWorkspaceAction } from "./workspaces/actions";
import { workspaceMark } from "./workspace-identity";

/** A Workspace as the switcher lists it. */
export interface WorkspaceChoice {
  id: string;
  name: string;
  /** The one this request reads, which the list marks and the others switch away from. */
  active: boolean;
}

const item =
  "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/60";

/**
 * The Workspace card at the top of the sidebar: the active Workspace's mark and name behind a chevron,
 * which opens the list of the user's Workspaces with New Workspace and Manage Workspaces under it.
 *
 * It's a native `<details>` and a form per Workspace, so it opens, switches and lists without
 * JavaScript; with it, a choice closes the phone's sheet before the next screen paints. The collapsed
 * rail keeps the mark alone, linking to the screen where the Workspaces are managed, because a
 * 3rem rail has no room for a list.
 */
export function WorkspaceSwitcher({
  workspaces,
  onNavigate,
}: {
  workspaces: readonly WorkspaceChoice[];
  /** What a choice or a link does beside navigating: the sidebar closes the phone's sheet with it. */
  onNavigate: () => void;
}) {
  const active = workspaces.find((workspace) => workspace.active);
  if (active === undefined) return null;
  return (
    <>
      <div className="group-data-[collapsible=icon]:hidden">
        <details className="group/switch min-w-0">
          <summary
            aria-label={`Workspace ${active.name}. Switch Workspace`}
            className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-sidebar-border p-2 text-left outline-hidden select-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-sidebar-ring/60 [&::-webkit-details-marker]:hidden"
          >
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center rounded-md bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground"
            >
              {workspaceMark(active.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-muted-foreground">Workspace</span>
              <span className="block truncate text-sm font-medium">{active.name}</span>
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground group-open/switch:rotate-180"
            />
          </summary>
          <div className="mt-1 flex flex-col gap-1 rounded-lg border border-sidebar-border p-1">
            <p className="px-2 pt-1 text-xs text-muted-foreground">Switch to</p>
            <ul className="flex flex-col">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  {workspace.active ? (
                    <p aria-current="true" className={`${item} bg-sidebar-accent text-sidebar-accent-foreground`}>
                      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                      <Check aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="sr-only">(the Workspace you&apos;re in)</span>
                    </p>
                  ) : (
                    <form action={switchWorkspaceAction} onSubmit={onNavigate}>
                      <input type="hidden" name="workspace" value={workspace.id} />
                      <button type="submit" className={item}>
                        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            <Link href="/workspaces#new" onClick={onNavigate} className={item}>
              <Plus aria-hidden="true" className="size-3.5 shrink-0" />
              New Workspace
            </Link>
            <Link href="/workspaces" onClick={onNavigate} className={item}>
              <Settings2 aria-hidden="true" className="size-3.5 shrink-0" />
              Manage Workspaces
            </Link>
          </div>
        </details>
      </div>
      <Link
        href="/workspaces"
        aria-label={`Workspace ${active.name}. Manage Workspaces`}
        onClick={onNavigate}
        className="mx-auto hidden size-8 place-items-center rounded-md bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground outline-hidden hover:bg-sidebar-accent/80 focus-visible:ring-3 focus-visible:ring-sidebar-ring/60 group-data-[collapsible=icon]:grid"
      >
        <span aria-hidden="true">{workspaceMark(active.name)}</span>
      </Link>
    </>
  );
}
