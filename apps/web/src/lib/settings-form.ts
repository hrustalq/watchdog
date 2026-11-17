/**
 * Whether a tab's fields, as its form would post them, are not the ones it started from. It compares
 * only the names `initial` carries: a field the tab doesn't show must not read as changed, or the tab
 * would claim unsaved changes forever and keep its saved notice hidden. It lives here, apart from
 * `lib/settings.ts`, because its caller is a Client Component and that module reaches the database.
 */
export function formDiffers(data: FormData, initial: Readonly<Record<string, string | boolean>>) {
  return Object.entries(initial).some(([name, value]) => {
    if (typeof value === "boolean") return data.has(name) !== value;
    const posted = data.get(name);
    return (typeof posted === "string" ? posted : "") !== value;
  });
}
