#!/usr/bin/env node
// Test gate: run the suite the way CI always has, and when the only failures are files in
// .github/flaky.txt, rerun exactly those files once. A real regression still fails the build,
// and a flake no longer forces a whole rerun of the suite.
//
// Failing files are read from turbo's own output (`@watchdog/<pkg>:test:  FAIL  src/x.test.ts`),
// never by re-running the suite: a stateful flake can pass on a second run, and that run would
// then hide the very file the gate needs to name.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const registryPath = path.join(root, ".github", "flaky.txt");
const packageDirs = {
  "@watchdog/core": "packages/core",
  "@watchdog/db": "packages/db",
  "@watchdog/web": "apps/web",
  "@watchdog/worker": "apps/worker",
};

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
const flaky = new Set(
  readFileSync(registryPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);

const run = (argv, opts = {}) =>
  spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });

console.log("test:gate — running the full suite");
const suite = run(["pnpm", "turbo", "run", "test"]);
process.stdout.write(suite.stdout ?? "");
process.stderr.write(suite.stderr ?? "");
if (suite.status === 0) process.exit(0);

// `@watchdog/core:test:  FAIL  src/delivery/deliver.int.test.ts > …` — one line per failing file.
const failing = [];
const seen = new Set();
for (const line of stripAnsi(`${suite.stdout ?? ""}\n${suite.stderr ?? ""}`).split("\n")) {
  const match = line.match(/^(@watchdog\/[a-z]+):test:\s+FAIL\s+(\S+)/);
  if (!match) continue;
  const [, pkg, file] = match;
  const dir = packageDirs[pkg];
  if (!dir) continue;
  const rel = path.posix.join(dir, file.replace(/^\.\//, ""));
  if (seen.has(rel)) continue;
  seen.add(rel);
  failing.push({ pkg, dir, rel, file });
}

if (failing.length === 0) {
  console.error("test:gate — the suite failed but named no failing file; leaving it red.");
  process.exit(suite.status ?? 1);
}

const strangers = failing.filter((f) => !flaky.has(f.rel));
if (strangers.length > 0) {
  console.error("test:gate — failures outside the flake registry:");
  for (const f of strangers) console.error(`  ${f.rel}`);
  process.exit(1);
}

console.log(`test:gate — only registry flakes failed (${failing.length}); rerunning those files once`);
for (const pkg of [...new Set(failing.map((f) => f.pkg))]) {
  const files = failing.filter((f) => f.pkg === pkg);
  const retry = run(["pnpm", "--filter", pkg, "exec", "vitest", "run", ...files.map((f) => f.file)], {
    stdio: "inherit",
  });
  if (retry.status !== 0) {
    console.error(`test:gate — ${pkg} still fails on the retry; leaving it red.`);
    process.exit(retry.status ?? 1);
  }
}
console.log("test:gate — registry flakes passed on the retry; suite green");
process.exit(0);
