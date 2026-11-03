const origin = "http://watchdog.invalid";

/**
 * The page to return to after signing in: `value` when it's a path on this site, otherwise `/`.
 * It arrives in a URL or a form, so anything that would leave the site, such as `//host`, `/\host`
 * or `https://host`, falls back to `/`. So does an encoded slash in the path, which Better Auth
 * refuses as a callbackURL.
 */
export function returnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const url = URL.parse(value, origin);
  if (url?.origin !== origin || /%(2f|5c)/i.test(url.pathname)) return "/";
  return `${url.pathname}${url.search}`;
}

/** Sign-in, carrying the page to return to in `next` unless that's the home page. */
export const signInPath = (next: string) =>
  next === "/" ? "/sign-in" : `/sign-in?${new URLSearchParams({ next })}`;

/** The proxy sets this request header to the page's path, which a Server Component can't read itself. */
export const pathHeader = "x-watchdog-path";
