export { loadConfig, type Config } from "./config.ts";
export {
  createEgressFetch,
  EgressBlockedError,
  EgressLimitError,
  type EgressRule,
} from "./egress/egress.ts";
export { pollSource, type PollResult, type PollSourceDeps } from "./pipeline/capture.ts";
export type { ItemDraft } from "./sources/item.ts";
export {
  FeedHttpError,
  fetchFeed,
  type FetchFeedDeps,
  type FetchFeedResult,
  type FetchState,
  NotAFeedError,
} from "./sources/rss/fetch-feed.ts";
export { createMailer, type MailMessage, type Mailer } from "./mail/mailer.ts";
export { defaultSchedule, nextPollAt, scheduleError } from "./schedule.ts";
export { type ConditionItem, evaluateCondition } from "./rules/condition.ts";
export {
  agentClassifierSchema,
  type AgentClassifier,
  agentExtractorRuleSchema,
  type AgentExtractorRule,
  type Classifier,
  classifierSchema,
  type Condition,
  conditionSchema,
  type DeterministicClassifier,
  deterministicClassifierSchema,
  type DeterministicExtractorRule,
  deterministicExtractorRuleSchema,
  type ExtractorRule,
  extractorRuleSchema,
  type Predicate,
  type Rule,
  ruleSchema,
} from "./rules/schema.ts";
export { ruleFromYaml, ruleToYaml } from "./rules/yaml.ts";
