import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { planLinkUpdates } from "../src/utils/links.js";
import { VaultFs, VaultRegistry } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

async function vaultFsFor(root: string): Promise<VaultFs> {
  const registry = await VaultRegistry.create([{ id: "t", root }]);
  return new VaultFs(registry.get("t"));
}

test("markdown links with %20-encoded spaces still resolve and rewrite", async () => {
  const root = await createVault("obsidian-mcp-links-");
  await fs.writeFile(path.join(root, "My File.md"), "# Target\n");
  await fs.writeFile(
    path.join(root, "Source.md"),
    "See [x](My%20File.md) and ![e](<My%20File.md>) inline.\n"
  );
  const vaultFs = await vaultFsFor(root);
  const result = await planLinkUpdates(vaultFs, "My File.md", "Renamed File.md", "move");
  assert.deepEqual(result.updatedFiles, ["Source.md"]);
  const change = result.changes[0];
  assert.ok(change);
  assert.equal(change.kind, "write");
  const rewritten = Buffer.from(change.data).toString("utf8");
  assert.match(rewritten, /\[x\]\(Renamed%20File\.md\)/u);
  assert.match(rewritten, /!\[e\]\(<Renamed%20File\.md>\)/u);
});

test(
  "adversarial percent-space runs cannot stall link rewriting",
  { timeout: 10_000 },
  async () => {
    const root = await createVault("obsidian-mcp-redos-");
    await fs.writeFile(path.join(root, "Target.md"), "# t\n");
    // An unterminated markdown URL of repeated "%20". A nested quantifier over
    // a character class that already admits %, 2, and 0 backtracks
    // exponentially on this input (CWE-1333); a single class must not.
    const payload = `[a](${Array(48).fill("%20").join("")}`;
    await fs.writeFile(path.join(root, "Poison.md"), `${payload}\n`);
    const vaultFs = await vaultFsFor(root);
    const startedAt = Date.now();
    const result = await planLinkUpdates(vaultFs, "Target.md", undefined, "mark_broken");
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 500, `link rewriting took ${elapsed}ms; expected linear matching`);
    assert.equal(result.changes.length, 0);
  }
);
