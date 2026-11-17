import type { Metadata } from "next";
import { dataBox } from "@/components/field-classes";
import { Disclosure } from "@/components/disclosure";
import { TextField } from "@/components/form-field";
import { Notice } from "@/components/notice";
import { Page, PageHeader } from "@/components/page";
import { PageBar } from "@/components/page-bar";
import { Section } from "@/components/section";
import { SubmitButton } from "@/components/submit-button";
import { Timestamp } from "@/components/timestamp";
import { requireWorkspace, server } from "@/lib/server";
import { listWorkspaces, workspaceNameLimit, type WorkspaceSummary } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { createWorkspaceAction, deleteWorkspaceAction, renameWorkspaceAction, switchWorkspaceAction } from "./actions";

export const metadata: Metadata = { title: "Workspaces · Watchdog" };

// The list and the forms are read without Suspense, so all of it is in the first HTML, which is how
// the forms work without JavaScript and why a refusal is never a blank page.
export const instant = false;

/** What a saved action says, by the `saved` value its redirect carries. */
const savedNotices: Record<string, string> = {
  created: "Workspace created. You're in it now, and it starts empty.",
  renamed: "Workspace renamed.",
  deleted: "Workspace deleted. Its Sources, Items and everything else went with it.",
};

/** What a refused action says, by the `refused` value its redirect carries. */
const refusedNotices: Record<string, string> = {
  blank: "Enter a name of 1 to 100 characters.",
  duplicate: "Another of your Workspaces is already called that.",
  name: "That isn't this Workspace's name, so nothing was deleted.",
  last: "This is your only Workspace, so it can't be deleted. Create another one first, or delete your account on the Account screen.",
  unknown: "That Workspace isn't one of yours.",
};

export default async function WorkspacesPage({ searchParams }: PageProps<"/workspaces">) {
  const [{ user, workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const rows = await listWorkspaces(server().db, user.id);
  const param = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  const savedMessage = savedNotices[param("saved")];
  const refusedMessage = refusedNotices[param("refused")];
  // A refusal names the row it belongs to, so that row's form opens again with what it was sent.
  const refusedId = param("id");
  const postedName = param("name");

  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Workspace" }, { label: "Workspaces" }]} />
      <Page gap={6}>
        <PageHeader
          title="Workspaces"
          description="Each Workspace has its own Sources, Items, Rules, Destinations, Profile and model. Switching changes which one Watchdog shows you; nothing moves between them."
        />

        {savedMessage === undefined ? null : <Notice role="status">{savedMessage}</Notice>}
        {refusedMessage === undefined ? null : <Notice role="alert">{refusedMessage}</Notice>}

        <Section id="workspaces-heading" title="Yours" tone="panel" gap={4}>
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <WorkspaceRow
                key={row.id}
                workspace={row}
                active={row.id === workspace.id}
                refused={refusedId === row.id ? param("refused") : ""}
                postedName={refusedId === row.id ? postedName : undefined}
              />
            ))}
          </ul>
        </Section>

        <Section
          id="new"
          title="New Workspace"
          tone="panel"
          gap={4}
          description="It gets the defaults for timezone, alert limits and retention, and starts empty: no Sources, rules, Destinations, Profile or model are copied."
        >
          <form action={createWorkspaceAction} className="flex flex-col gap-4">
            <TextField
              id="workspace-name"
              name="name"
              label="Name"
              type="text"
              required
              autoComplete="off"
              maxLength={workspaceNameLimit}
              className="sm:max-w-sm"
              help="1 to 100 characters, and unlike any other Workspace of yours."
            />
            <SubmitButton pendingLabel="Creating…" className="sm:w-auto sm:self-start">
              Create Workspace
            </SubmitButton>
          </form>
        </Section>
      </Page>
    </div>
  );
}

/**
 * One Workspace in the list: its name, when it was made and whether it's the one the request reads,
 * with its own forms. Every one is a plain form or a native disclosure, so the screen works without
 * JavaScript, and which row a refusal belongs to comes from the URL rather than from script.
 */
function WorkspaceRow({
  workspace,
  active,
  refused,
  postedName,
}: {
  workspace: WorkspaceSummary;
  active: boolean;
  /** The refusal this row's last form came back with, or "" for none. */
  refused: string;
  /** What that form was sent, so a refused rename opens on it rather than on the saved name. */
  postedName: string | undefined;
}) {
  const renameOpen = refused === "blank" || refused === "duplicate";
  const deleteOpen = refused === "name" || refused === "last";
  const renameError =
    refused === "duplicate" ? "Another of your Workspaces is already called that." : undefined;
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-title break-words">{workspace.name}</h3>
        {active ? (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Active</span>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Created <Timestamp at={workspace.createdAt} />
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {active ? null : (
          <form action={switchWorkspaceAction}>
            <input type="hidden" name="workspace" value={workspace.id} />
            <SubmitButton pendingLabel="Opening…" variant="outline" className="w-auto">
              Open
            </SubmitButton>
          </form>
        )}
        <Disclosure label="Rename" openLabel="Close" open={renameOpen}>
          <form action={renameWorkspaceAction.bind(null, workspace.id)} className="flex flex-col gap-3">
            <TextField
              id={`rename-${workspace.id}`}
              name="name"
              label="New name"
              type="text"
              required
              autoComplete="off"
              maxLength={workspaceNameLimit}
              defaultValue={renameOpen ? postedName : workspace.name}
              error={renameError}
              className="sm:max-w-sm"
            />
            <SubmitButton pendingLabel="Renaming…" variant="outline" className="sm:w-auto sm:self-start">
              Rename Workspace
            </SubmitButton>
          </form>
        </Disclosure>
        <Disclosure label="Delete" openLabel="Close" open={deleteOpen} bodyClassName="border bg-card">
          <p className="max-w-[70ch] text-sm">
            This deletes <strong>{workspace.name}</strong> and everything in it: its Sources, Items and their Log,
            Corrections, Rules, Destinations, Actions, Deliveries, Profile, model settings, Agent calls and Telegram
            connections. It can&apos;t be undone, and your account stays.
          </p>
          <form action={deleteWorkspaceAction.bind(null, workspace.id)} className="flex flex-col gap-3">
            <TextField
              id={`delete-${workspace.id}`}
              name="name"
              label={<>Type {workspace.name} to confirm</>}
              type="text"
              required
              autoComplete="off"
              controlClassName={cn(dataBox, "sm:max-w-xs")}
            />
            <SubmitButton pendingLabel="Deleting…" variant="destructive" className="sm:w-auto sm:self-start">
              Delete Workspace
            </SubmitButton>
          </form>
        </Disclosure>
      </div>
    </li>
  );
}
