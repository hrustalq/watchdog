#!/usr/bin/env node
// Test gate: run the suite the way CI always has, and when the only failures are files in
// .github/flaky.txt, rerun exactly those files once. A real regression still fails the build,
// and a flake no longer forces a whole rerun of the suite.
//
// Fast path: `pnpm turbo run test` succeeds → exit 0, nothing else runs.
// Slow path: turbo names the failed packages; each is rerun with the JSON reporter to name
//            the failing files, which are checked against the registry.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
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

function run(argv, opts = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

console.log("test:gate — running the full suite");
const suite = run(["pnpm", "turbo", "run", "test"]);
process.stdout.write(suite.stdout ?? "");
process.stderr.write(suite.stderr ?? "");
if (suite.status === 0) process.exit(0);

// Which packages did turbo name as failed?
const failedPackages = [
  ...new Set(
    stripAnsi(`${suite.stdout ?? ""}\n${suite.stderr ?? ""}`)
      .split("\n")
      .filter((line) => line.trim().startsWith("Failed:"))
      .flatMap((line) => line.replace("Failed:", "").split(/[\s,]+/))
      .map((token) => token.replace(/#.*/, "").trim())
      .filter((name) => packageDirs[name]),
  ),
];
if (failedPackages.length === 0) {
  console.error("test:gate — the suite failed but turbo named no failed package; leaving it red.");
  process.exit(suite.status ?? 1);
}

// Name the failing files per failed package.
const scratch = mkdtempSync(path.join(tmpdir(), "watchdog-test-gate-"));
const failingFiles = [];
const unreadable = [];
for (const name of failedPackages) {
  const dir = packageDirs[name];
  const out = path.join(scratch, `${dir.replaceAll("/", "_")}.json`);
  run(["pnpm", "--filter", name, "exec", "vitest", "run", "--passWithNoTests", "--reporter=json", `--outputFile.json=${out}`]);
  if (!existsSync(out)) {
    unreadable.push(dir);
    continue;
  }
  const report = JSON.parse(readFileSync(out, "utf8"));
  for (const result of report.testResults ?? []) {
    const failed = result.status === "failed" || (result.assertionResults ?? []).some((a) => a.status === "failed");
    if (!failed) continue;
    const rel = path.relative(root, result.name ?? "").split(path.sep).join("/");
    failingFiles.push({ pkg: name, dir, rel, file: result.name });
  }
}

if (unreadable.length > 0) {
  console.error(`test:gate — no JSON report from ${unreadable.join(", ")}; leaving it red.`);
  process.exit(1);
}
if (failingFiles.length === 0) {
  console.error("test:gate — the suite failed with no failing file named; leaving it red.");
  process.exit(1);
}

const strangers = failingFiles.filter((f) => !flaky.has(f.rel));
if (strangers.length > 0) {
  console.error("test:gate — failures outside the flake registry:");
  for (const f of strangers) console.error(`  ${f.rel}`);
  process.exit(1);
}

console.log(`test:gate — only registry flakes failed (${failingFiles.length}); rerunning those files once`);
for (const name of failedPackages) {
  const files = failingFiles.filter((f) => f.pkg === name);
  if (files.length === 0) continue;
  const argv = ["pnpm", "--filter", name, "exec", "vitest", "run", ...files.map((f) => path.relative(path.join(root, f.dir), f.file))];
  const retry = run(argv, { stdio: "inherit" });
  if (retry.status !== 0) {
    console.error(`test:gate — ${name} still fails on the retry; leaving it red.`);
    process.exit(retry.status ?? 1);
  }
}
console.log("test:gate — registry flakes passed on the retry; suite green");
process.exit(0);
