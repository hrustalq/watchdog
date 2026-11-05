// A Workspace's Profile, as its screen changes it. `loadProfile` in @watchdog/core reads it.
import { type Db, profile } from "@watchdog/db";

/** The body goes on every Agent call, so its length is a cost on every Item. */
export const maxProfileBody = 4000;

const iso639_1 =
  "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu";

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

/** Every language the Agent can be asked to write in, by English name. */
export const outputLanguages = iso639_1
  .split(" ")
  .map((code) => ({ code, label: `${languageNames.of(code) ?? code} (${code})` }))
  .sort((a, b) => a.label.localeCompare(b.label, "en"));

/** What the form posts, as text. */
export interface ProfileInput {
  body: string;
  language: string;
}

/**
 * The body as it's counted and stored. A browser counts a newline as one character and posts it as
 * two, so the form's count only agrees with this one here. Postgres text refuses a NUL and half a
 * surrogate pair.
 */
const cleanBody = (text: string) => text.replaceAll("\0", "").toWellFormed().replaceAll("\r\n", "\n").trim();

/** Creates or replaces the Workspace's Profile. An over-long body or unknown language changes nothing. */
export async function saveProfile(
  db: Db,
  workspaceId: string,
  input: ProfileInput,
): Promise<{ problem: "too-long" | "language" } | { saved: true }> {
  const body = cleanBody(input.body);
  if (body.length > maxProfileBody) return { problem: "too-long" };
  if (!outputLanguages.some(({ code }) => code === input.language)) return { problem: "language" };
  const values = { body, outputLanguage: input.language };
  await db
    .insert(profile)
    .values({ workspaceId, ...values })
    .onConflictDoUpdate({ target: profile.workspaceId, set: { ...values, updatedAt: new Date() } });
  return { saved: true };
}
