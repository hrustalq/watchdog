/**
 * The chats whose title contains the filter, case-insensitively, in the order Telegram listed them.
 * An empty filter keeps every chat, and a chat that is already watched stays in the list too, so it
 * can be found by its title as well. A blank filter is the page's, which trims the field before it
 * gets here.
 */
export function matchingChats<T extends { title: string }>(chats: readonly T[], filter: string): readonly T[] {
  if (filter === "") return chats;
  const wanted = filter.toLowerCase();
  return chats.filter(({ title }) => title.toLowerCase().includes(wanted));
}
