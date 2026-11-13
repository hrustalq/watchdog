import { minimumMinutes } from "@watchdog/core";
import { hasUnreadableKey } from "@/lib/model";
import {
  declaredFields,
  destinationChoices,
  hasActiveModel,
  knownCategories,
  problemsInDraft,
  type RuleTarget,
} from "@/lib/rules";
import { server } from "@/lib/server";
import { listSources } from "@/lib/sources";
import { RuleEditor } from "./rule-editor";
import { RulesBreadcrumb } from "./rules-breadcrumb";

/**
 * The editor as a whole page. Both routes that use it set `instant = false` and read their data
 * without Suspense, so the form and what's wrong with it are in the first HTML, which is how they
 * work without JavaScript.
 */
export async function EditorScreen({
  workspace,
  target,
  heading,
  detail,
  yaml,
  query,
}: {
  workspace: { id: string; timezone: string };
  target: RuleTarget | null;
  heading: string;
  detail?: string;
  yaml: string;
  query: Record<string, string | string[] | undefined>;
}) {
  const { db, encryptionKey, mode } = server();
  const workspaceId = workspace.id;
  const sentBack = typeof query.draft === "string" ? query.draft : undefined;
  const [hasModel, unreadableKey, sources, categories, destinations, declared, problems] = await Promise.all([
    hasActiveModel(db, workspaceId),
    hasUnreadableKey(db, encryptionKey, workspaceId),
    listSources(db, workspaceId),
    knownCategories(db, workspaceId),
    destinationChoices(db, workspaceId),
    declaredFields(db, workspaceId),
    sentBack === undefined ? [] : problemsInDraft(db, workspaceId, target, sentBack, mode),
  ]);
  const tooLong =
    query["draft-too-long"] === undefined
      ? []
      : [{ path: "", message: "That rule wasn't saved, and it's too long to bring back without JavaScript. Check it for mistakes and try again." }];
  return (
    <div className="flex flex-1 flex-col">
      <RulesBreadcrumb editing={heading} />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-headline break-words">{heading}</h1>
          {detail === undefined ? null : <p className="text-sm text-muted-foreground">{detail}</p>}
        </div>
        <RuleEditor
          target={target}
          initialYaml={sentBack ?? yaml}
          initialProblems={[...tooLong, ...problems]}
          hasModel={hasModel}
          unreadableKey={unreadableKey}
          sources={sources.map(({ id, name }) => ({ id, name }))}
          categories={categories}
          destinations={destinations}
          declared={declared}
          scheduleHelp={`A cron expression in this Workspace's timezone (${workspace.timezone}), such as 0 9 * * 1 for Mondays at 09:00. It can't run more often than every ${String(minimumMinutes[mode])} minutes on ${mode}.`}
        />
      </main>
    </div>
  );
}
