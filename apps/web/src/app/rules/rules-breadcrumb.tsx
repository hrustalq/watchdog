import Link from "next/link";

const crumb =
  "rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30";

function Separator() {
  return (
    <span aria-hidden="true" className="text-muted-foreground">
      /
    </span>
  );
}

/** Workspace / Rules, and on an editor the page under Rules. */
export function RulesBreadcrumb({ current }: { current: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
      <Link href="/" className={crumb}>
        Workspace
      </Link>
      <Separator />
      {current === "Rules" ? null : (
        <>
          <Link href="/rules" className={crumb}>
            Rules
          </Link>
          <Separator />
        </>
      )}
      <span aria-current="page" className="min-w-0 truncate">
        {current}
      </span>
    </nav>
  );
}
