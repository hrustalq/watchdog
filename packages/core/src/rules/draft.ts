// A rule on its way to being one: the YAML view reads and writes it whatever it holds, so a value
// the schemas would refuse survives until the user fixes it. Its own entry point, because the Rules
// screen runs this in the browser and the rest of this package doesn't belong there.
import { parse, stringify } from "yaml";

/** A draft as YAML, with no aliases and each value on its own line, whatever its length. */
export function draftToYaml(draft: unknown) {
  return stringify(draft, { aliasDuplicateObjects: false, lineWidth: 0 });
}

/**
 * What this YAML holds, unchecked. On text it can't read it throws what the parser throws: a
 * `YAMLParseError`, or a `RangeError` when the text nests too deeply.
 */
export function draftFromYaml(text: string): unknown {
  return parse(text);
}
