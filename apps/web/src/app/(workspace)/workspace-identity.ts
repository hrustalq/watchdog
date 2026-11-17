/** The two-letter fallback avatar for a user whose email is all the Workspace knows about them. */
export function userMark(email: string) {
  const mark = email.trim().slice(0, 2).toUpperCase();
  return mark === "" ? "?" : mark;
}

/** The name a user with no profile name gets: the part of their email before the @. */
export function nameFromEmail(email: string) {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/** A Workspace's mark before it has an image: its first letter, so the card never shows an empty box. */
export function workspaceMark(name: string) {
  const letter = name.trim().slice(0, 1).toUpperCase();
  return letter === "" ? "W" : letter;
}
