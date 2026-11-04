import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRule, isRuleType } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { EditorScreen } from "../../editor-screen";

export const metadata: Metadata = { title: "Rule · Watchdog" };

// See EditorScreen.
export const instant = false;

export default async function EditRulePage({ params, searchParams }: PageProps<"/rules/[type]/[id]">) {
  const [{ workspace }, { type, id }, query] = await Promise.all([requireWorkspace(), params, searchParams]);
  if (!isRuleType(type)) notFound();
  // Another Workspace's rule is missing too, so its id says nothing about whether it exists.
  const rule = (await getRule(server().db, workspace.id, type, id)) ?? notFound();
  return (
    <EditorScreen
      workspaceId={workspace.id}
      target={{ type, id }}
      heading={rule.name}
      yaml={rule.yaml}
      query={query}
    />
  );
}
