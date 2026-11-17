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

export interface WorkspaceNavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** The sections that watch and deliver: the reason the Workspace exists. */
export const primaryLinks: readonly WorkspaceNavLink[] = [
  { href: "/", label: "Feed", icon: Inbox },
  { href: "/sources", label: "Sources", icon: Rss },
  { href: "/rules", label: "Rules", icon: ListFilter },
  { href: "/destinations", label: "Destinations", icon: Send },
];

/** The sections that set the Workspace up: model, spend and the account around it. */
export const secondaryLinks: readonly WorkspaceNavLink[] = [
  { href: "/profile", label: "Profile", icon: UserRound },
  { href: "/model", label: "Model", icon: Cpu },
  { href: "/usage", label: "Usage", icon: ChartNoAxesColumn },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

/**
 * Whether a nav entry is the current screen. Feed stays current on an Item, because an Item is a
 * Feed row opened; every other section stays current on its detail screens. A path that only shares
 * a prefix (`/sources-other`) is not a match, so two sections can never light up at once.
 */
export function isCurrentWorkspaceLink(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/items/");
  return pathname === href || pathname.startsWith(`${href}/`);
}
