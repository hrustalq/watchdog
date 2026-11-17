"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Plus, Radar, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { signOut } from "./actions";
import { isCurrentWorkspaceLink, primaryLinks, secondaryLinks, type WorkspaceNavLink } from "./workspace-nav";
import { SidebarUserMenu } from "./workspace-user-menu";
import { WorkspaceSwitcher, type WorkspaceChoice } from "./workspace-switcher";

/**
 * The Workspace's persistent navigation: brand, the switcher for the Workspaces the user owns, the
 * sections that watch and deliver, and the account links. The sidebar is the only navigation, so it
 * stays on desktop and becomes the sheet on a phone. Collapsing keeps the glyphs and hides the words;
 * the trigger under the brand, and the rail at the edge, bring them back.
 */
export function WorkspaceSidebar({ workspaces, email }: { workspaces: readonly WorkspaceChoice[]; email: string }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  // A Link inside the mobile sheet must close it, or the next screen arrives under the sheet.
  const closeMobile = () => {
    setOpenMobile(false);
  };
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-2 border-b border-sidebar-border p-2">
        <div className="flex h-8 items-center gap-1 group-data-[collapsible=icon]:h-auto group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-2">
          <Link
            href="/"
            aria-label="Watchdog"
            onClick={closeMobile}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md outline-hidden focus-visible:ring-3 focus-visible:ring-sidebar-ring/60 group-data-[collapsible=icon]:flex-none"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <Radar aria-hidden="true" className="size-4" />
            </span>
            <span className="truncate text-title group-data-[collapsible=icon]:hidden">Watchdog</span>
          </Link>
          <SidebarTrigger className="hidden md:inline-flex" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Close navigation"
            onClick={closeMobile}
          >
            <X />
          </Button>
        </div>
        {/* The switcher: the Workspaces this account owns behind one card. It's a native disclosure
            and a form per Workspace, so it works without JavaScript; collapsing keeps the mark. */}
        <WorkspaceSwitcher workspaces={workspaces} onNavigate={closeMobile} />
        <Link
          href="/sources#add-source"
          aria-label="Add source"
          onClick={closeMobile}
          className={buttonVariants({
            className: "w-full group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-0",
          })}
        >
          <Plus aria-hidden="true" />
          <span className="group-data-[collapsible=icon]:hidden">Add source</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="Watch" links={primaryLinks} pathname={pathname} onNavigate={closeMobile} />
        <NavGroup label="Account" links={secondaryLinks} pathname={pathname} onNavigate={closeMobile} />
      </SidebarContent>
      {/* The footer's account menu is for the desktop rail. In the phone sheet the same menu is in
          the top bar; nesting a menu inside the sheet's focus trap would close the sheet as it
          opens. */}
      <SidebarFooter className="hidden border-t border-sidebar-border md:flex">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarUserMenu email={email} onNavigate={closeMobile} />
          </SidebarMenuItem>
        </SidebarMenu>
        {/* The account menu needs script; without it the footer keeps the one action that must work. */}
        <noscript>
          <form action={signOut}>
            <Button type="submit" variant="ghost" className="w-full justify-start">
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </form>
        </noscript>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** One labelled block of the sidebar, with the current screen marked for sight and for a screen reader. */
function NavGroup({
  label,
  links,
  pathname,
  onNavigate,
}: {
  label: string;
  links: readonly WorkspaceNavLink[];
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {links.map(({ href, label: linkLabel, icon: Icon }) => {
            const current = isCurrentWorkspaceLink(pathname, href);
            return (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  isActive={current}
                  tooltip={linkLabel}
                  aria-label={linkLabel}
                  aria-current={current ? "page" : undefined}
                  render={<Link href={href} onClick={onNavigate} />}
                >
                  <Icon aria-hidden="true" />
                  <span className="group-data-[collapsible=icon]:hidden">{linkLabel}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
