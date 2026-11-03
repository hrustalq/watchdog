// An Item's language, detected on capture (docs: Processing pipeline, "Item envelope").
import { detect } from "tinyld";

// Below this many letters the detector guesses: it reads "Hello" as Italian.
const minLetters = 12;

/** The ISO 639-1 code of the text's language, or null when the text is too short to tell. */
export function detectLanguage(text: string) {
  if ((text.match(/\p{L}/gu)?.length ?? 0) < minLetters) return null;
  // tinyld also knows a few languages with no two-letter code, such as Klingon ("tlh").
  const code = detect(text);
  return /^[a-z]{2}$/.test(code) ? code : null;
}
