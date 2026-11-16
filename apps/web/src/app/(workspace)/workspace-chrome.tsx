"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartNoAxesColumn,
  Cpu,
  Inbox,
  ListFilter,
  Rss,
  Send,
  Settings2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { signOut } from "./actions";
import { WorkspaceMenu } from "./workspace-menu";

const primaryLinks = [
  { href: "/", label: "Feed", icon: Inbox },
  { href: "/sources", label: "Sources", icon: Rss },
  { href: "/rules", label: "Rules", icon: ListFilter },
  { href: "/destinations", label: "Destinations", icon: Send },
] as const;

const secondaryLinks = [
  { href: "/profile", label: "Profile", icon: UserRound },
  { href: "/model", label: "Model", icon: Cpu },
  { href: "/usage", label: "Usage", icon: ChartNoAxesColumn },
  { href: "/settings", label: "Settings", icon: Settings2 },
] as const;

const links = [...primaryLinks, ...secondaryLinks];

export function isCurrentWorkspaceLink(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/items/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function WorkspaceChrome({
  workspaceName,
  email,
  children,
}: {
  workspaceName: string;
  email: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const moreActive = secondaryLinks.some(({ href }) => isCurrentWorkspaceLink(pathname, href));

  return (
    <div className="flex min-h-dvh flex-1 flex-col pb-[calc(4rem+1px+env(safe-area-inset-bottom))] lg:pb-0">
      <header className="relative flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4">
        <p className="flex min-w-0 flex-1 items-baseline gap-2 lg:max-w-56 xl:max-w-none">
          <span className="hidden text-xs font-medium tracking-[0.01em] text-muted-foreground xl:inline">
            Workspace
          </span>
          <Link
            href="/"
            className="truncate rounded-sm text-title outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60"
          >
            {workspaceName}
          </Link>
        </p>
        <span className="hidden max-w-48 truncate text-sm text-muted-foreground xl:inline">{email}</span>
        <nav aria-label="Workspace" className="hidden shrink-0 items-center lg:flex">
          {links.map((link) => (
            <DesktopLink key={link.href} pathname={pathname} {...link} />
          ))}
        </nav>
        <form action={signOut} className="hidden shrink-0 lg:block">
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </header>
      {children}
      <nav
        aria-label="Workspace"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="grid h-16 grid-cols-[1fr_1fr_1fr_1.4fr_1fr]">
          {primaryLinks.map((link) => (
            <li key={link.href} className="min-w-0">
              <MobileLink pathname={pathname} {...link} />
            </li>
          ))}
          <li className="min-w-0">
            <WorkspaceMenu key={pathname} active={moreActive}>
              {secondaryLinks.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  aria-current={isCurrentWorkspaceLink(pathname, href) ? "page" : undefined}
                  className={buttonVariants({
                    variant: isCurrentWorkspaceLink(pathname, href) ? "secondary" : "ghost",
                    className: "w-full justify-start",
                  })}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </Link>
              ))}
              <form action={signOut} className="mt-1 border-t pt-1">
                <Button type="submit" variant="ghost" className="w-full justify-start">
                  Sign out
                </Button>
              </form>
            </WorkspaceMenu>
          </li>
        </ul>
      </nav>
    </div>
  );
}

function DesktopLink({ pathname, href, label }: { pathname: string; href: string; label: string; icon: LucideIcon }) {
  const current = isCurrentWorkspaceLink(pathname, href);
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={buttonVariants({ variant: current ? "secondary" : "ghost" })}
    >
      {label}
    </Link>
  );
}

function MobileLink({
  pathname,
  href,
  label,
  icon: Icon,
}: {
  pathname: string;
  href: string;
  label: string;
  icon: LucideIcon;
}) {
  const current = isCurrentWorkspaceLink(pathname, href);
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-16 min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs font-medium outline-hidden focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/60",
        current ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
      <span className="max-w-full truncate">{label}</span>
    </Link>
  );
}
