// An absolute http or https URL, or null. Everything else, from a relative path to a javascript:
// link, is refused before it reaches a fetch or a stored Source.
export function httpUrl(text: string): URL | null {
  const url = URL.parse(text.trim());
  return url !== null && (url.protocol === "http:" || url.protocol === "https:") ? url : null;
}
