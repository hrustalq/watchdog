"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { signOut } from "./actions";
import { isCurrentWorkspaceLink, primaryLinks, secondaryLinks } from "./workspace-nav";
import { HeaderUserMenu } from "./workspace-user-menu";
import { WorkspaceSidebar } from "./workspace-sidebar";
import type { WorkspaceChoice } from "./workspace-switcher";

/**
 * The Workspace shell: one persistent sidebar and the screen it sits beside. The sidebar owns the
 * navigation and the account; the inset owns the page's one `main` landmark, so a screen's `Page`
 * is a column inside it rather than a second main. The top bar exists only below `md`, where the
 * sidebar is a sheet and needs a trigger.
 */
export function WorkspaceChrome({
  workspaceName,
  workspaces,
  email,
  defaultOpen,
  children,
}: {
  workspaceName: string;
  workspaces: readonly WorkspaceChoice[];
  email: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={defaultOpen}>
        <nav aria-label="Skip">
          <a
            href="#workspace-main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md focus:outline-hidden focus:ring-3 focus:ring-ring/60"
          >
            Skip to content
          </a>
        </nav>
        <WorkspaceSidebar workspaces={workspaces} email={email} />
        {/* min-w-0: a flex item's min-width is auto, so without it the inset refuses to shrink below
            the widest row and pushes the page past the viewport at tablet widths. */}
        <SidebarInset id="workspace-main" tabIndex={-1} className="min-w-0">
          <MobileHeader workspaceName={workspaceName} email={email} />
          <NoScriptNav pathname={pathname} />
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

/** The phone's 48px bar: the only place the sheet's trigger can live, since the sidebar is closed. */
function MobileHeader({ workspaceName, email }: { workspaceName: string; email: string }) {
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2 md:hidden">
      <SidebarTrigger className="size-9" aria-label="Open navigation" />
      <p className="min-w-0 flex-1 truncate text-sm font-medium">{workspaceName}</p>
      <HeaderUserMenu email={email} />
    </header>
  );
}

/**
 * Navigation when JavaScript is off. The desktop sidebar is server-rendered and still works, but
 * below `md` the sidebar is a sheet whose trigger needs script, so without this row a phone could
 * open the app and never leave the screen. A `<noscript>` keeps the two navigation models from
 * appearing together.
 */
function NoScriptNav({ pathname }: { pathname: string }) {
  return (
    <noscript>
      {/* These controls open menus or a sheet, which is script; without it they would be dead. */}
      <style>{`[data-slot="sidebar-trigger"], [data-slot="user-menu-trigger"] { display: none; }`}</style>
      <nav aria-label="Workspace" className="border-b bg-background px-2 py-2 md:hidden">
        <ul className="flex flex-wrap gap-1">
          {[...primaryLinks, ...secondaryLinks].map(({ href, label, icon: Icon }) => {
            const current = isCurrentWorkspaceLink(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={current ? "page" : undefined}
                  className={buttonVariants({ variant: current ? "secondary" : "ghost", size: "sm" })}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </Link>
              </li>
            );
          })}
          <li>
            <Link href="/workspaces" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Workspaces
            </Link>
          </li>
          <li>
            <Link href="/account" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Account
            </Link>
          </li>
          <li>
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </li>
        </ul>
      </nav>
    </noscript>
  );
}
