// The YAML view of the rule model (docs: Rule model, "Three ways to write rules, one model").
import { parse, stringify } from "yaml";
import { type Rule, ruleSchema } from "./schema.ts";

/** A rule as YAML, with no aliases and each value on its own line, whatever its length. */
export function ruleToYaml(rule: Rule) {
  return stringify(rule, { aliasDuplicateObjects: false, lineWidth: 0 });
}

/**
 * The rule in this YAML. Throws a `ZodError` on a bad rule. On text it can't read it throws what the
 * parser throws: a `YAMLParseError`, or a `RangeError` when the text nests too deeply.
 */
export function ruleFromYaml(text: string): Rule {
  return ruleSchema.parse(parse(text));
}
