import { loadConfig } from "@watchdog/core";
import { packageName as db } from "@watchdog/db";

// Fails with the invalid variables named before the worker does anything else.
const config = loadConfig();

// Nothing to do until the queue arrives; keep the process alive until it is told to stop.
const keepAlive = setInterval(() => {
  // Nothing to run; the timer only holds the event loop open.
}, 2 ** 31 - 1);

process.once("SIGTERM", () => {
  clearInterval(keepAlive);
  console.log("Worker stopped");
});

console.log(`Worker ready (${config.mode}, ${db})`);
