#!/usr/bin/env node
// Test gate: run the suite the way CI always has, and when the only failures are files in
// .github/flaky.txt, rerun exactly those files once. A real regression still fails the build,
// and a flake no longer forces a whole rerun of the suite.
//
// Failing files are read from turbo's own output, never by re-running the suite: a stateful flake
// can pass on a second run, and that run would then hide the very file the gate needs to name.
// Turbo writes that output in two shapes. On a laptop every line carries the task's prefix
// (`@watchdog/<pkg>:test:  FAIL  src/x.test.ts`). On GitHub Actions it switches to workflow
// commands: `::group::@watchdog/<pkg>:test` (stored in the log as `##[group]@watchdog/<pkg>:test`)
// with the package's raw output underneath, and a bare `<pkg>:test` header for the task that
// failed — so an unprefixed FAIL line belongs to whichever task header preceded it. Both shapes
// are parsed here, which is what makes the registry work in the run it exists for.
//
// A failing task cancels the tasks still running beside it, and a canceled task never prints its
// own failures. `--summarize` records every task turbo attempted, so the gate can tell a named
// flake from a package whose tests never finished, cover that package before claiming green, and
// leave a half-run suite red instead of quietly passing it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const registryPath = path.join(root, ".github", "flaky.txt");
// Every package with a `test` script. One of these missing from turbo's run summary is a package
// whose tests never finished, which is what the summary is compared against below.
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

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

console.log("test:gate — running the full suite");
const suite = run(["pnpm", "turbo", "run", "test", "--summarize"]);
process.stdout.write(suite.stdout ?? "");
process.stderr.write(suite.stderr ?? "");
if (suite.status === 0) process.exit(0);

const output = stripAnsi(`${suite.stdout ?? ""}\n${suite.stderr ?? ""}`);

// One failing file per `FAIL` line, attributed to the package whose task header the line sits
// under. `group` is that header: set by `::group::<pkg>:<task>`, by its stored
// `##[group]<pkg>:<task>` form, and by the bare `<pkg>:<task>` turbo writes for a failed task.
const failing = [];
const seen = new Set();
const addFailure = (pkg, file) => {
  const dir = packageDirs[pkg];
  if (!dir || !file) return;
  const rel = path.posix.join(dir, file.replace(/^\.\//, ""));
  if (seen.has(rel)) return;
  seen.add(rel);
  failing.push({ pkg, dir, rel, file });
};

let group = null;
const unattributed = [];
for (const raw of output.split("\n")) {
  const line = raw.trimEnd();
  if (line === "::endgroup::" || line === "##[endgroup]") {
    group = null;
    continue;
  }

  const header = line.match(/^(?:::group::|##\[group\])?(@watchdog\/[a-z-]+):([a-z:]+)$/);
  if (header) {
    group = { pkg: header[1], task: header[2] };
    continue;
  }

  // `@watchdog/core:test:  FAIL  src/x.test.ts` — a laptop run, which prefixes every line.
  const prefixed = line.match(/^(@watchdog\/[a-z-]+):test:\s+FAIL\s+(\S+)/);
  if (prefixed) {
    addFailure(prefixed[1], prefixed[2]);
    continue;
  }

  const bare = line.match(/^\s*FAIL\s+(\S+)/);
  if (bare) {
    if (group && group.task === "test") addFailure(group.pkg, bare[1]);
    else unattributed.push(bare[1]);
  }
}

// A FAIL line outside any task header belongs to the one package that holds that file. When two
// packages both do, which one failed is unknowable from the log, so the run stays red.
let unresolved = 0;
for (const file of unattributed) {
  const owners = Object.keys(packageDirs).filter((pkg) =>
    existsSync(path.join(root, packageDirs[pkg], file.replace(/^\.\//, ""))),
  );
  if (owners.length === 1) addFailure(owners[0], file);
  else unresolved += 1;
}

// Which packages' test tasks turbo actually finished. A canceled task prints no result of its own,
// so this comes from the run summary: a package absent from it never ran, and retrying only the
// named flakes would then pass a suite whose other half never executed.
const summaryLine = output.match(/^Summary:\s+(\S+)\s*$/m);
const summary = summaryLine ? readJson(path.resolve(root, summaryLine[1])) : null;
const execution = summary && typeof summary === "object" ? summary.execution : null;
const tasks = summary && typeof summary === "object" ? summary.tasks : null;
const countedOk =
  execution !== null &&
  typeof execution === "object" &&
  [execution.success, execution.failed, execution.cached, execution.attempted].every(
    (n) => typeof n === "number",
  );
if (!countedOk || !tasks || typeof tasks !== "object") {
  console.error("test:gate — turbo wrote no readable run summary, so the gate can't tell whether");
  console.error("            every test task ran; leaving the run red.");
  process.exit(suite.status ?? 1);
}

const counted = execution.success + execution.failed + execution.cached;
const canceled = Math.max(0, execution.attempted - counted);
const finished = new Set();
for (const task of Object.values(tasks)) {
  const id = task && typeof task === "object" ? task.taskId : undefined;
  if (typeof id !== "string") continue;
  const match = id.match(/^(@watchdog\/[a-z-]+)#test$/);
  if (match) finished.add(match[1]);
}
const uncovered = Object.keys(packageDirs).filter((pkg) => !finished.has(pkg));

if (uncovered.length > 0) {
  const why =
    canceled > 0
      ? `turbo canceled ${canceled} task${canceled === 1 ? "" : "s"} after a failure, so the run`
      : "turbo's summary holds no result for it, so the run";
  console.error(`test:gate — ${uncovered.join(", ")}: ${why} is inconclusive for it.`);
}

if (unresolved > 0) {
  console.error(`test:gate — ${unresolved} FAIL line(s) named no package; leaving the run red.`);
  process.exit(1);
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

// The canceled packages get a full run of their own: their tests produced no output the gate could
// read, so nothing above has covered them yet.
for (const pkg of uncovered) {
  console.log(`test:gate — covering ${pkg}, whose test task the failed run never finished`);
  const covered = run(["pnpm", "--filter", pkg, "test"], { stdio: "inherit" });
  if (covered.status !== 0) {
    console.error(`test:gate — ${pkg} fails when run on its own; leaving it red.`);
    process.exit(covered.status ?? 1);
  }
}

console.log("test:gate — registry flakes passed on the retry; suite green");
process.exit(0);
