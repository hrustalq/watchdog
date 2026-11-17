"use client";

import Link from "next/link";
import { ChevronsUpDown, LogOut, UserRound } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { signOut } from "./actions";
import { nameFromEmail, userMark } from "./workspace-identity";

/**
 * The account menu: who is signed in, the Profile screen, and Sign out. It is one menu behind the
 * avatar in both places it appears, so the sidebar footer keeps one row instead of a profile row
 * and a second sign-out row. The trigger carries the accessible name, because the collapsed
 * sidebar hides the visible name and email.
 */
export function SidebarUserMenu({ email, onNavigate }: { email: string; onNavigate: () => void }) {
  const { state } = useSidebar();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="user-menu-trigger"
        aria-label={`Account, ${userMark(email)}, ${nameFromEmail(email)}, ${email}`}
        title={email}
        className="flex min-h-12 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/60 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2"
      >
        <UserAvatar email={email} />{" "}
        <span className="flex min-w-0 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
          <span className="truncate text-sm font-medium">{nameFromEmail(email)}</span>{" "}
          <span className="truncate text-xs text-muted-foreground">{email}</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
      </DropdownMenuTrigger>
      <UserMenuContent email={email} onNavigate={onNavigate} align="start" side={state === "collapsed" ? "right" : "top"} />
    </DropdownMenu>
  );
}

/** The phone header's avatar trigger: the same menu, opening under the bar instead of over the footer. */
export function HeaderUserMenu({ email }: { email: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="user-menu-trigger"
        aria-label={`Account, ${userMark(email)}, ${nameFromEmail(email)}, ${email}`}
        title={email}
        className="grid size-9 place-items-center rounded-full outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60"
      >
        <UserAvatar email={email} />
      </DropdownMenuTrigger>
      <UserMenuContent email={email} align="end" side="bottom" />
    </DropdownMenu>
  );
}

/**
 * The avatar both triggers show: the user's initials until they have an image. It is decorative,
 * because the trigger's accessible name already carries the initials, the name and the email.
 */
function UserAvatar({ email }: { email: string }) {
  return (
    <Avatar aria-hidden="true" className="size-7">
      <AvatarFallback className="text-xs">{userMark(email)}</AvatarFallback>
    </Avatar>
  );
}

/**
 * The menu itself. Profile is a link item; Sign out is a submit item in a form, so its action is the
 * same server action the no-JavaScript fallback uses. The email is repeated here because the header
 * trigger shows only the avatar.
 */
function UserMenuContent({
  email,
  onNavigate,
  align,
  side,
}: {
  email: string;
  onNavigate?: () => void;
  align: "start" | "end";
  side: "top" | "bottom" | "right";
}) {
  return (
    <DropdownMenuContent align={align} side={side} sideOffset={6} className="w-56">
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="truncate text-sm font-medium text-foreground">{nameFromEmail(email)}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem
          render={
            onNavigate === undefined ? <Link href="/profile" /> : <Link href="/profile" onClick={onNavigate} />
          }
        >
          <UserRound aria-hidden="true" />
          Profile
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <form action={signOut} className="contents">
        <DropdownMenuItem variant="destructive" nativeButton render={<button type="submit" className="w-full" />}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </form>
    </DropdownMenuContent>
  );
}
