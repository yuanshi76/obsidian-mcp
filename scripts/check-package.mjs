import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const cache = await mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-npm-cache-"));
const packArguments = ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache];
const npmCli = process.env.npm_execpath;
let stdout;
try {
  ({ stdout } = await run(
    npmCli === undefined ? "npm" : process.execPath,
    npmCli === undefined ? packArguments : [npmCli, ...packArguments],
    { maxBuffer: 10 * 1024 * 1024 }
  ));
} finally {
  await rm(cache, { recursive: true, force: true });
}
// npm < 12 emits `[{...}]`; npm 12+ emits `{ "<name>": {...} }` keyed by package.
const packed = JSON.parse(stdout);
const report = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
const files = report.files.map((entry) => entry.path).sort();
const forbidden = files.filter(
  (file) =>
    file.startsWith("test/") ||
    file.startsWith("src/") ||
    file.startsWith("build/") ||
    /^dist\/v\d+\//u.test(file) ||
    file.endsWith(".test.js") ||
    file.includes("bun.lock")
);
if (forbidden.length > 0) throw new Error(`Unexpected package files: ${forbidden.join(", ")}`);
for (const required of ["dist/main.js", "README.md", "LICENSE", "MIGRATING.md", "SECURITY.md"]) {
  if (!files.includes(required)) throw new Error(`Package is missing ${required}.`);
}
