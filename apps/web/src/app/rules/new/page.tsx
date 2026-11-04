import { draftToYaml } from "@watchdog/core/rules/draft";
import type { Metadata } from "next";
import { blankRule } from "@/lib/rule-draft";
import { isRuleType } from "@/lib/rules";
import { requireWorkspace } from "@/lib/server";
import { EditorScreen } from "../editor-screen";
import { kindLabel, ruleNoun } from "../words";

export const metadata: Metadata = { title: "New rule · Watchdog" };

// See EditorScreen.
export const instant = false;

export default async function NewRulePage({ searchParams }: PageProps<"/rules/new">) {
  const [{ workspace }, query] = await Promise.all([requireWorkspace(), searchParams]);
  const type = isRuleType(query.type) ? query.type : "classifier";
  const kind = query.kind === "agent" ? "agent" : "deterministic";
  return (
    <EditorScreen
      workspaceId={workspace.id}
      target={null}
      heading={`New ${kindLabel[kind]} ${ruleNoun[type]}`}
      yaml={draftToYaml(blankRule(type, kind))}
      query={query}
    />
  );
}
