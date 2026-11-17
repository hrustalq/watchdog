import Link from "next/link";
import { settingsTabHref, settingsTabsFor, type SettingsTab } from "@/lib/settings";
import { cn } from "@/lib/utils";

const tab =
  "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm font-medium outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60";
const current = "bg-muted text-foreground";
const other = "text-muted-foreground hover:bg-muted/50 hover:text-foreground";

/**
 * The Settings screen's tabs: one link per section, right under the page header, the open one in the
 * Instrument Well navigation fills for the current section. Each is a plain link carrying `?tab=`, so
 * a tab deep-links, survives a reload and a Back, and opens without JavaScript. The strip scrolls
 * sideways when it doesn't fit instead of wrapping into a tall block, and the label names the
 * Workspace, because it's that Workspace's settings the tabs switch between.
 */
export function SettingsTabs({
  current: open,
  workspaceName,
  admin,
}: {
  current: SettingsTab;
  workspaceName: string;
  admin: boolean;
}) {
  return (
    <nav aria-label={`${workspaceName} settings`} className="overflow-x-auto">
      <ul className="flex w-max gap-1">
        {settingsTabsFor(admin).map(({ value, label }) => (
          <li key={value}>
            <Link
              href={settingsTabHref(value)}
              aria-current={value === open ? "page" : undefined}
              className={cn(tab, value === open ? current : other)}
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
