import { hasActiveModel, problemsInDraft, type RuleTarget } from "@/lib/rules";
import { server } from "@/lib/server";
import { listSources } from "@/lib/sources";
import { RuleEditor } from "./rule-editor";
import { RulesBreadcrumb } from "./rules-breadcrumb";

/**
 * The editor as a whole page. Both routes that use it set `instant = false` and read their data
 * without Suspense, so the form and what's wrong with it are in the first HTML, which is how they
 * work without JavaScript, and a missing rule is a real 404.
 */
export async function EditorScreen({
  workspaceId,
  target,
  heading,
  yaml,
  query,
}: {
  workspaceId: string;
  target: RuleTarget | null;
  heading: string;
  yaml: string;
  query: Record<string, string | string[] | undefined>;
}) {
  const { db } = server();
  const sentBack = typeof query.draft === "string" ? query.draft : undefined;
  const [hasModel, sources, problems] = await Promise.all([
    hasActiveModel(db, workspaceId),
    listSources(db, workspaceId),
    sentBack === undefined ? [] : problemsInDraft(db, workspaceId, target, sentBack),
  ]);
  const tooLong =
    query["draft-too-long"] === undefined
      ? []
      : [{ path: "", message: "That rule wasn't saved, and it's too long to bring back without JavaScript. Check it for mistakes and try again." }];
  return (
    <div className="flex flex-1 flex-col">
      <RulesBreadcrumb current={heading} />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <h1 className="text-headline break-words">{heading}</h1>
        <RuleEditor
          target={target}
          initialYaml={sentBack ?? yaml}
          initialProblems={[...tooLong, ...problems]}
          hasModel={hasModel}
          sources={sources.map(({ id, name }) => ({ id, name }))}
        />
      </main>
    </div>
  );
}
