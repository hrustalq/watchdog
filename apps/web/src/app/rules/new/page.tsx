import { draftToYaml } from "@watchdog/core/rules/draft";
import type { Metadata } from "next";
import { blankRule, kindOf, readDraft, ruleNoun, ruleTypeOf } from "@/lib/rule-draft";
import { isRuleType } from "@/lib/rules";
import { requireWorkspace } from "@/lib/server";
import { EditorScreen } from "../editor-screen";
import { kindLabel } from "../words";

export const metadata: Metadata = { title: "New rule · Watchdog" };

// See EditorScreen.
export const instant = false;

export default async function NewRulePage({ searchParams }: PageProps<"/rules/new">) {
  const [{ workspace }, query] = await Promise.all([requireWorkspace(), searchParams]);
  const blank = blankRule(
    isRuleType(query.type) ? query.type : "classifier",
    query.kind === "agent" ? "agent" : "deterministic",
  );
  // A draft sent back after a refused save says what it is itself.
  const sentBack = typeof query.draft === "string" ? readDraft(query.draft) : undefined;
  const shown = sentBack !== undefined && "draft" in sentBack ? sentBack.draft : blank;
  return (
    <EditorScreen
      workspaceId={workspace.id}
      target={null}
      heading={`New ${kindLabel[kindOf(shown)]} ${ruleNoun[ruleTypeOf(shown)]}`}
      yaml={draftToYaml(blank)}
      query={query}
    />
  );
}
