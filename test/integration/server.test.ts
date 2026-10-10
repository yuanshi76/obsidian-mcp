import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Stream } from "node:stream";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { TOOL_NAMES } from "../../src/tools/index.js";
import { createVault } from "../helpers.js";

test("modern stdio server advertises complete schemas and executes all fourteen tools", async () => {
  const root = await createVault("obsidian-mcp-integration-");
  await fs.writeFile(path.join(root, "Source.md"), "# Source\n\n#old\n");
  await fs.writeFile(
    path.join(root, "Links.md"),
    "See [[Source#Heading|alias]].\n`[[Source]]`\n<!-- [[Source]] -->\n"
  );
  const client = new Client(
    { name: "obsidian-mcp-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/main.js", "serve", "--vault", `test=${root}`, "--log-level", "error"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  await client.connect(transport);
  try {
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getServerVersion()?.version, packageVersion());
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      TOOL_NAMES
    );
    for (const tool of listed.tools) {
      assert.ok(tool.title);
      assert.ok(tool.description);
      assert.ok(tool.outputSchema);
      assert.equal(tool.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.ok(tool.annotations);
      for (const [field, schema] of schemaProperties(tool.inputSchema)) {
        assert.equal(
          typeof schema.description,
          "string",
          `${tool.name}.${field} must describe how the argument is used`
        );
      }
      const successData = successDataSchema(tool.outputSchema);
      assert.ok(
        "properties" in successData || "oneOf" in successData || "anyOf" in successData,
        `${tool.name} must advertise a concrete data schema`
      );
    }
    const manageSchema = listed.tools.find(
      (tool) => tool.name === "obsidian_manage_tags"
    )?.inputSchema;
    assert.ok(Array.isArray(manageSchema?.oneOf));
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 1);
    assert.equal(resources.resources[0]?.uri, "obsidian-mcp://vaults");
    const resource = await client.readResource({ uri: "obsidian-mcp://vaults" });
    assert.doesNotMatch(JSON.stringify(resource), new RegExp(escapeRegExp(root), "u"));

    await success(client, "obsidian_list_vaults", {});
    const read = await success(client, "obsidian_read_note", { vault: "test", path: "Source.md" });
    assert.match(String(read.etag), /^[a-f0-9]{64}$/u);
    const directory = await success(client, "obsidian_create_directory", {
      vault: "test",
      path: "folder/deep"
    });
    assert.match(String(directory.transaction_id), /^[0-9a-f-]{36}$/u);
    await success(client, "obsidian_create_note", {
      vault: "test",
      path: "folder/New",
      content: "new"
    });
    await success(client, "obsidian_edit_note", {
      vault: "test",
      path: "folder/New.md",
      operation: "append",
      content: " note"
    });
    await success(client, "obsidian_add_tags", {
      vault: "test",
      paths: ["folder/New.md"],
      tags: ["project/active"]
    });
    await success(client, "obsidian_remove_tags", {
      vault: "test",
      paths: ["folder/New.md"],
      tags: ["project"],
      include_children: true
    });
    await success(client, "obsidian_manage_tags", {
      operation: "add",
      vault: "test",
      paths: ["folder/New.md"],
      tags: ["managed"]
    });
    await success(client, "obsidian_rename_tag", {
      vault: "test",
      old_tag: "old",
      new_tag: "renamed"
    });
    await success(client, "obsidian_move_note", {
      vault: "test",
      source: "Source.md",
      destination: "Moved.md"
    });
    const links = await fs.readFile(path.join(root, "Links.md"), "utf8");
    assert.match(links, /\[\[Moved#Heading\|alias\]\]/u);
    assert.match(links, /`\[\[Source\]\]`/u);
    assert.match(links, /<!-- \[\[Source\]\] -->/u);
    const search = await success(client, "obsidian_search_vault", {
      vault: "test",
      query: "managed",
      mode: "tag"
    });
    assert.equal(search.count, 1);
    const deleted = await success(client, "obsidian_delete_note", {
      vault: "test",
      path: "folder/New.md",
      mode: "trash"
    });
    const recovery = await success(client, "obsidian_recovery_list", { vault: "test" });
    const entries = recovery.entries as { id: string; state: string }[];
    assert.ok(Array.isArray(entries));
    assert.ok(entries.some((entry) => entry.id === deleted.transaction_id));
    const unconfirmedRestore = await client.callTool({
      name: "obsidian_recovery_restore",
      arguments: { vault: "test", transaction_id: deleted.transaction_id }
    });
    assert.equal(unconfirmedRestore.isError, true);
    assert.match(
      textOf(unconfirmedRestore),
      /confirm_transaction_id is required and must repeat transaction_id exactly/u
    );
    const restored = await success(client, "obsidian_recovery_restore", {
      vault: "test",
      transaction_id: deleted.transaction_id,
      confirm_transaction_id: deleted.transaction_id
    });
    assert.equal(typeof restored.transaction_id, "string");
    const revived = await success(client, "obsidian_read_note", {
      vault: "test",
      path: "folder/New.md"
    });
    assert.match(String(revived.content), /new note/u);

    const escaped = await client.callTool({
      name: "obsidian_read_note",
      arguments: { vault: "test", path: "../package.json" }
    });
    assert.equal(escaped.isError, true);
    assert.equal(
      (escaped.structuredContent as { error: { code: string } }).error.code,
      "PATH_REJECTED"
    );

    const invalidEdit = await client.callTool({
      name: "obsidian_edit_note",
      arguments: { vault: "test", path: "", operation: "merge", content: "x" }
    });
    assert.equal(invalidEdit.isError, true);
    const invalidEditText = textOf(invalidEdit);
    assert.match(invalidEditText, /path: Path cannot be empty\./u);
    assert.match(
      invalidEditText,
      /operation: operation must be one of 'append', 'prepend', or 'replace'\./u
    );

    const unconfirmedDelete = await client.callTool({
      name: "obsidian_delete_note",
      arguments: { vault: "test", path: "Moved.md", mode: "permanent" }
    });
    assert.equal(unconfirmedDelete.isError, true);
    assert.match(
      textOf(unconfirmedDelete),
      /confirm_path: confirm_path is required when mode is 'permanent'/u
    );

    const emptyTagRemoval = await client.callTool({
      name: "obsidian_remove_tags",
      arguments: { vault: "test", paths: ["Moved.md"], tags: [], patterns: [] }
    });
    assert.equal(emptyTagRemoval.isError, true);
    assert.match(
      textOf(emptyTagRemoval),
      /tags: At least one tag or pattern is required for a remove operation\./u
    );
  } finally {
    await client.close();
  }
});

test("server accepts a legacy initialization by default and emits migration guidance", async () => {
  const root = await createVault("obsidian-mcp-legacy-");
  const client = new Client({ name: "legacy-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/main.js", "serve", "--vault", `test=${root}`, "--log-level", "error"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const stderr = capture(transport.stderr);
  await client.connect(transport);
  try {
    assert.equal(client.getProtocolEra(), "legacy");
    await waitForText(stderr, "LEGACY_MCP_PROTOCOL");
    assert.match(stderr.value, /Upgrade the MCP client or host/u);
    assert.match(stderr.value, /More help:/u);
  } finally {
    await client.close();
  }
});

test("modern-only mode rejects legacy initialization with a corrective diagnostic", async () => {
  const root = await createVault("obsidian-mcp-legacy-rejected-");
  const client = new Client({ name: "legacy-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/main.js",
      "serve",
      "--vault",
      `test=${root}`,
      "--legacy",
      "reject",
      "--log-level",
      "error"
    ],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const stderr = capture(transport.stderr);
  await assert.rejects(() => client.connect(transport), /Unsupported protocol version|2026-07-28/u);
  await waitForText(stderr, "STRICT_PROTOCOL_REJECTION");
  assert.match(stderr.value, /--legacy.*serve/u);
  await transport.close();
});

test("unchanged v1 positional configuration starts and prints exact replacement args", async () => {
  const root = await createVault("Obsidian MCP Legacy Vault-");
  const client = new Client({ name: "legacy-config-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/main.js", root],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const stderr = capture(transport.stderr);
  await client.connect(transport);
  try {
    assert.equal(client.getProtocolEra(), "legacy");
    await waitForText(stderr, "V1_POSITIONAL_CONFIG_DEPRECATED");
    assert.match(stderr.value, /\["serve","--vault"/u);
    assert.match(stderr.value, /Restart the MCP client/u);
    assert.match(stderr.value, /LEGACY_MCP_PROTOCOL/u);
  } finally {
    await client.close();
  }
});

async function success(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const structured = result.structuredContent as { ok: boolean; data: Record<string, unknown> };
  assert.equal(structured.ok, true);
  return structured.data;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  return content?.find((item) => item.type === "text")?.text ?? "";
}

function schemaProperties(
  schema: Record<string, unknown>,
  prefix = ""
): Array<[string, Record<string, unknown>]> {
  const found: Array<[string, Record<string, unknown>]> = [];
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties !== undefined) {
    for (const [name, property] of Object.entries(properties)) {
      found.push([`${prefix}${name}`, property]);
    }
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[keyword] as Record<string, unknown>[] | undefined;
    for (const [index, branch] of branches?.entries() ?? []) {
      found.push(...schemaProperties(branch, `${prefix}${keyword}[${index}].`));
    }
  }
  return found;
}

function successDataSchema(outputSchema: Record<string, unknown>): Record<string, unknown> {
  const branches = outputSchema.oneOf as Record<string, unknown>[] | undefined;
  assert.ok(branches);
  for (const branch of branches) {
    const properties = branch.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties?.ok?.const === true) {
      assert.ok(properties.data);
      return properties.data;
    }
  }
  assert.fail("Output schema has no successful data branch");
}

function packageVersion(): string {
  const value = JSON.parse(requirePackageJson()) as { version: string };
  return value.version;
}

function requirePackageJson(): string {
  return readFileSync(new URL("../../package.json", import.meta.url), "utf8");
}

function capture(stream: Stream | null): { value: string } {
  const target = { value: "" };
  stream?.on("data", (chunk: Buffer | string) => {
    target.value += chunk.toString();
  });
  return target;
}

async function waitForText(target: { value: string }, text: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!target.value.includes(text) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(target.value, new RegExp(text, "u"));
}
