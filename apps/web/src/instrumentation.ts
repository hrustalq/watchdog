// Next.js calls register once when a server starts, in each runtime it uses.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await (await import("./instrumentation-node")).start();
}
