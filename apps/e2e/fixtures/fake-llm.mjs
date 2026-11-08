// The smoke run's model, a small OpenAI-compatible server on the Compose network (compose.smoke.yaml),
// so the real provider code runs with no model bill and no way out. An Item is rated Importance 2 unless
// the prompt holds a Correction that raised a similar Item, and then Importance 5, which is how a
// Correction visibly changes a later Rating. It's rated Severity 1, or 5 when its title says "outage",
// which is how the M3 demo gets an Item an alert fires on.
import { createServer } from "node:http";
import { json } from "node:stream/consumers";

const words = (title) => new Set(title.toLowerCase().match(/\p{L}{5,}/gu));
const areSimilar = (one, other) => words(one).intersection(words(other)).size >= 2;

/** One of the prompt's sections as JSON. No value inside can close its section (buildAgentPrompt). */
const section = (prompt, name) => JSON.parse(new RegExp(`<${name}>(.*)</${name}>`, "s").exec(prompt)[1]);

function rate(prompt) {
  const { title } = section(prompt, "item");
  const raised = section(prompt, "corrections").find(
    ({ title: corrected, before, after }) => after.importance > before.importance && areSimilar(corrected, title),
  );
  return {
    summary: `The fake model's summary of "${title}".`,
    reasoning: raised === undefined ? "No Correction raised a similar Item." : `A Correction raised "${raised.title}".`,
    severity: /\boutage\b/i.test(title) ? 5 : 1,
    importance: raised === undefined ? 2 : 5,
  };
}

/** Without the structured output flag, the system message ends with the output's JSON Schema. */
function answer(system, prompt) {
  const { properties } = JSON.parse(system.slice(system.lastIndexOf("\n") + 1));
  if ("reply" in properties) return { reply: "ok" };
  if ("categories" in properties) return { categories: properties.categories.items.enum };
  return rate(prompt);
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  // The healthcheck.
  if (request.method !== "POST") {
    send(response, 200, {});
    return;
  }
  try {
    const [system, prompt] = (await json(request)).messages.map(({ content }) => content);
    send(response, 200, {
      id: "fake",
      object: "chat.completion",
      created: 0,
      model: "fake-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(answer(system, prompt)) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  } catch (error) {
    // Reaches the Item's Log and the Model screen, so a run that fails here says why.
    send(response, 500, { error: { message: String(error), type: "server_error" } });
  }
}).listen(8080);
