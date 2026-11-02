import { loadConfig } from "@watchdog/core";

// Stops with the invalid variables named before the worker does anything else.
const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return process.exit(1);
  }
})();

// Nothing to do until the queue arrives; keep the process alive until it is told to stop.
const keepAlive = setInterval(() => {
  // Nothing to run; the timer only holds the event loop open.
}, 2 ** 31 - 1);

process.once("SIGTERM", () => {
  clearInterval(keepAlive);
  console.log("Worker stopped");
});

console.log(`Worker ready (${config.mode})`);
