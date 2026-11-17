"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Plus, Radar, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { nameFromEmail, userMark } from "./workspace-identity";
import { isCurrentWorkspaceLink, primaryLinks, secondaryLinks, type WorkspaceNavLink } from "./workspace-nav";

/** A Workspace's mark before it has an image: its first letter, so the identity card never shows an empty box. */
function workspaceMark(name: string) {
  const letter = name.trim().slice(0, 1).toUpperCase();
  return letter === "" ? "W" : letter;
}

/**
 * The Workspace's persistent navigation: brand, the one Workspace it belongs to, the sections that
 * watch and deliver, and the account links. The sidebar is the only navigation, so it stays on
 * desktop and becomes the sheet on a phone. Collapsing keeps the glyphs and hides the words; the
 * trigger under the brand, and the rail at the edge, bring them back.
 */
export function WorkspaceSidebar({ workspaceName, email }: { workspaceName: string; email: string }) {
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
        {/* One Workspace per user, so this is an identity block, not a switcher: a switcher with one
            choice would be a control that cannot change anything. */}
        <div className="flex items-center gap-2 rounded-lg border border-sidebar-border p-2 group-data-[collapsible=icon]:hidden">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground">
            {workspaceMark(workspaceName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">Workspace</p>
            <p className="truncate text-sm font-medium">{workspaceName}</p>
          </div>
        </div>
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
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip={email}
              aria-label={`Profile, ${email}`}
              render={<Link href="/profile" onClick={closeMobile} />}
              className="h-auto min-h-12 py-1.5 group-data-[collapsible=icon]:justify-center"
            >
              <Avatar className="size-7">
                <AvatarFallback className="text-xs">{userMark(email)}</AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-medium">{nameFromEmail(email)}</span>
                <span className="truncate text-xs text-muted-foreground">{email}</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <form action={signOut}>
              <SidebarMenuButton type="submit" tooltip="Sign out" aria-label="Sign out">
                <LogOut aria-hidden="true" />
                <span className="group-data-[collapsible=icon]:hidden">Sign out</span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
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
