// The YAML view of the rule model (docs: Rule model, "Three ways to write rules, one model").
import { parse, stringify } from "yaml";
import { type Rule, ruleSchema } from "./schema.ts";

/** A rule as YAML, with no aliases and each value on its own line, whatever its length. */
export function ruleToYaml(rule: Rule) {
  return stringify(rule, { aliasDuplicateObjects: false, lineWidth: 0 });
}

/** The rule in this YAML. Throws a `YAMLParseError` on bad syntax and a `ZodError` on a bad rule. */
export function ruleFromYaml(text: string): Rule {
  return ruleSchema.parse(parse(text));
}
