import type { ModelListReason } from "@/lib/model-list";

/**
 * Why the list didn't load, in the words the field shows. Every one of these leaves the name field
 * usable by hand, so each sentence says what to do next rather than only what went wrong.
 */
export const modelListFailureMessage: Record<ModelListReason, string> = {
  "invalid-input": "Check the provider type, the base URL and the API key.",
  "unreadable-key": "Watchdog can't read the saved API key. Enter the key above and try again.",
  unauthorized: "The provider refused this API key.",
  blocked: "Watchdog doesn't call this address, so no list was read.",
  unreachable: "Watchdog couldn't reach this address. Check the base URL.",
  "no-endpoint": "This address doesn't publish a model list. Type the model's name instead.",
  "bad-response": "The provider's answer wasn't a model list Watchdog could read. Type the name instead.",
};
