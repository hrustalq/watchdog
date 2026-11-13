// What a failed Agent call says in an Item's Log (docs: Processing pipeline, "Stages").
import { type AgentFailure, storableMessage } from "../agent/call-agent.ts";

/**
 * A failed call's sentence for the Log. An invalid answer's message is the validator's own output, with
 * symbols and field paths a user can neither read nor act on, so it stays in the call's meter row
 * (`agent_call.error_message`) and in the repair prompt, and the Log names the cause in plain words.
 */
export function callFailureInLog(failure: AgentFailure) {
  return failure.reason === "invalid_output"
    ? "the model's answer didn't match the shape Watchdog asked for"
    : storableMessage(failure.message);
}
