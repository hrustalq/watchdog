import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceSwitcher, type WorkspaceChoice } from "./workspace-switcher.tsx";

const work = { id: "11111111-1111-4111-8111-111111111111", name: "Work", active: false } as const;
const markets = { id: "22222222-2222-4222-8222-222222222222", name: "Markets", active: false } as const;

const render = (workspaces: readonly WorkspaceChoice[]) =>
  renderToStaticMarkup(<WorkspaceSwitcher workspaces={workspaces} onNavigate={() => undefined} />);

const active = (name: string, id: string): WorkspaceChoice => ({ id, name, active: true });

describe("WorkspaceSwitcher", () => {
  it("shows the active Workspace's name and mark, behind a disclosure that needs no script", () => {
    const html = render([work, active("Markets", markets.id)]);

    // A native disclosure: the control is a summary, not a button a script has to wire up.
    expect(html).toMatch(/<details\b/);
    expect(html).toMatch(/<summary\b/);
    expect(html).toContain('aria-label="Workspace Markets. Switch Workspace"');
    expect(html).toContain("Markets");
  });

  it("lists every Workspace, marking the active one and posting each other one's id", () => {
    const html = render([work, active("Markets", markets.id)]);

    expect(html.match(/name="workspace"/g)).toHaveLength(1);
    expect(html).toContain(`value="${work.id}"`);
    expect(html).toContain('aria-current="true"');
    // The active one is a reading, not a form that would post it again.
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("offers New Workspace and Manage Workspaces beside the list", () => {
    const html = render([active("Work", work.id)]);

    expect(html).toContain('href="/workspaces#new"');
    expect(html).toContain('href="/workspaces"');
    expect(html).toContain("New Workspace");
    expect(html).toContain("Manage Workspaces");
  });

  it("keeps the collapsed rail readable with the mark alone, linking to the Workspaces screen", () => {
    const html = render([active("Work", work.id)]);

    // The full card hides at rail width and the mark takes over; both are in the markup, and CSS picks.
    expect(html).toContain("group-data-[collapsible=icon]:hidden");
    expect(html).toContain("group-data-[collapsible=icon]:grid");
    expect(html).toContain('aria-label="Workspace Work. Manage Workspaces"');
  });

  it("renders nothing rather than an empty card when it is told about no Workspaces", () => {
    expect(render([])).toBe("");
  });
});
