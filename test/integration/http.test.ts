import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { serveHttp, type HttpConfig, type HttpHandle } from "../../src/http.js";
import { Runtime } from "../../src/runtime.js";
import { TOOL_NAMES } from "../../src/tools/index.js";
import { Logger } from "../../src/utils/logger.js";
import { VaultRegistry } from "../../src/utils/vault.js";
import { createVault } from "../helpers.js";

const TOKEN = "integration-test-token-0123456789abcdef";

async function startServer(overrides: Partial<HttpConfig> = {}): Promise<HttpHandle> {
  const root = await createVault("obsidian-mcp-http-");
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const runtime = new Runtime(
    registry,
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await runtime.initialize();
  return serveHttp(runtime, new Logger("error"), {
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:3000",
    token: TOKEN,
    legacy: "serve",
    maxRequestBodyBytes: 16 * 1024 * 1024,
    rateLimitPerMinute: 10_000,
    allowedHostnames: ["127.0.0.1", "localhost"],
    ...overrides
  });
}

async function rawRequest(
  handle: HttpHandle,
  init: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: handle.port,
        method: init.method ?? "GET",
        path: init.path ?? "/mcp",
        headers: init.headers
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
        );
      }
    );
    request.on("error", reject);
    request.end(init.body);
  });
}

async function connectClient(handle: HttpHandle, token: string): Promise<Client> {
  const client = new Client(
    { name: "obsidian-mcp-http-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${handle.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } }
  );
  await client.connect(transport);
  return client;
}

async function data(
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

test("HTTP transport advertises every registered tool and the vault resource", async () => {
  const handle = await startServer();
  try {
    const client = await connectClient(handle, TOKEN);
    try {
      assert.equal(client.getProtocolEra(), "modern");
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        [...TOOL_NAMES]
      );
      assert.equal(listed.tools.length, 14);
      const resources = await client.listResources();
      assert.equal(resources.resources[0]?.uri, "obsidian-mcp://vaults");
    } finally {
      await client.close();
    }
  } finally {
    await handle.close();
  }
});

test("HTTP transport completes create, read, etag edit, recovery list, and restore", async () => {
  const handle = await startServer();
  try {
    const client = await connectClient(handle, TOKEN);
    try {
      const created = await data(client, "obsidian_create_note", {
        vault: "test",
        path: "Loop",
        content: "# Loop\n\noriginal\n"
      });
      const read = await data(client, "obsidian_read_note", {
        vault: "test",
        path: "Loop.md"
      });
      assert.equal(typeof read.etag, "string");
      const edited = await data(client, "obsidian_edit_note", {
        vault: "test",
        path: "Loop.md",
        operation: "append",
        content: " appended\n",
        if_match: read.etag
      });
      const afterEdit = await data(client, "obsidian_read_note", {
        vault: "test",
        path: "Loop.md"
      });
      assert.match(String(afterEdit.content), /appended/u);

      const list = await data(client, "obsidian_recovery_list", { vault: "test" });
      const entries = list.entries as { id: string; state: string }[];
      assert.equal(entries.length, 2);
      assert.equal(entries[0]?.state, "committed");
      assert.ok(entries.some((entry) => entry.id === String(created.transaction_id)));

      await data(client, "obsidian_recovery_restore", {
        vault: "test",
        transaction_id: String(edited.transaction_id),
        confirm_transaction_id: String(edited.transaction_id)
      });
      const afterRestore = await data(client, "obsidian_read_note", {
        vault: "test",
        path: "Loop.md"
      });
      assert.doesNotMatch(String(afterRestore.content), /appended/u);
      assert.match(String(afterRestore.content), /original/u);
    } finally {
      await client.close();
    }
  } finally {
    await handle.close();
  }
});

test("stale etag edits and unconfirmed restores fail across HTTP", async () => {
  const handle = await startServer();
  try {
    const client = await connectClient(handle, TOKEN);
    try {
      const created = await data(client, "obsidian_create_note", {
        vault: "test",
        path: "Guard",
        content: "a"
      });
      const staleEdit = await client.callTool({
        name: "obsidian_edit_note",
        arguments: {
          vault: "test",
          path: "Guard.md",
          operation: "append",
          content: "b",
          if_match: "0".repeat(64)
        }
      });
      assert.equal(staleEdit.isError, true);
      assert.equal(
        (staleEdit.structuredContent as { error: { code: string } }).error.code,
        "REVISION_CONFLICT"
      );
      const unconfirmed = await client.callTool({
        name: "obsidian_recovery_restore",
        arguments: { vault: "test", transaction_id: String(created.transaction_id) }
      });
      assert.equal(unconfirmed.isError, true);
      assert.match(
        textOf(unconfirmed),
        /confirm_transaction_id is required and must repeat transaction_id exactly/u
      );
    } finally {
      await client.close();
    }
  } finally {
    await handle.close();
  }
});

test("missing and wrong bearer tokens answer 401 with a WWW-Authenticate challenge", async () => {
  const handle = await startServer();
  try {
    const missing = await rawRequest(handle, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${handle.port}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    assert.equal(missing.status, 401);
    assert.match(String(missing.headers["www-authenticate"] ?? ""), /^Bearer /u);

    const wrong = await rawRequest(handle, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token-value-here-000000",
        host: `127.0.0.1:${handle.port}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    assert.equal(wrong.status, 401);
    assert.match(String(wrong.headers["www-authenticate"] ?? ""), /^Bearer /u);
  } finally {
    await handle.close();
  }
});

test("forged Host and mismatched Origin headers are refused before the MCP handler", async () => {
  const handle = await startServer();
  try {
    const forged = await rawRequest(handle, {
      path: "/mcp",
      headers: { host: "attacker.example", authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(forged.status, 403);

    const badOrigin = await rawRequest(handle, {
      path: "/mcp",
      headers: {
        host: `127.0.0.1:${handle.port}`,
        origin: "http://evil.example",
        authorization: `Bearer ${TOKEN}`
      }
    });
    assert.equal(badOrigin.status, 403);
  } finally {
    await handle.close();
  }
});

test("healthz answers without credentials and readyz probes vault access", async () => {
  const handle = await startServer();
  try {
    const health = await rawRequest(handle, {
      path: "/healthz",
      headers: { host: `127.0.0.1:${handle.port}` }
    });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);

    const ready = await rawRequest(handle, {
      path: "/readyz",
      headers: { host: `127.0.0.1:${handle.port}` }
    });
    assert.equal(ready.status, 200);
    const readiness = JSON.parse(ready.body) as {
      ok: boolean;
      vaults: { vault: string; readable: boolean; writable: boolean }[];
    };
    assert.equal(readiness.ok, true);
    assert.deepEqual(readiness.vaults, [{ vault: "test", readable: true, writable: true }]);
  } finally {
    await handle.close();
  }
});

test("rate limiter answers 429 with Retry-After once the window is exceeded", async () => {
  const handle = await startServer({ rateLimitPerMinute: 3 });
  try {
    const headers = {
      host: `127.0.0.1:${handle.port}`,
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json"
    };
    for (let index = 0; index < 3; index += 1) {
      await rawRequest(handle, { method: "POST", path: "/mcp", headers, body: "{}" });
    }
    const blocked = await rawRequest(handle, {
      method: "POST",
      path: "/mcp",
      headers,
      body: "{}"
    });
    assert.equal(blocked.status, 429);
    assert.equal(typeof blocked.headers["retry-after"], "string");
  } finally {
    await handle.close();
  }
});

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  return content?.find((item) => item.type === "text")?.text ?? "";
}

// chmod-based writability revocation is POSIX-only; Linux CI covers it.
if (process.platform !== "win32") {
  test("readyz reports 503 when a vault loses write access", async () => {
    const root = await createVault("obsidian-mcp-http-ro-");
    const registry = await VaultRegistry.create([{ id: "test", root }]);
    const runtime = new Runtime(
      registry,
      { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
      new Logger("error")
    );
    await runtime.initialize();
    const handle = await serveHttp(runtime, new Logger("error"), {
      host: "127.0.0.1",
      port: 0,
      publicUrl: "http://127.0.0.1:3000",
      legacy: "serve",
      maxRequestBodyBytes: 16 * 1024 * 1024,
      rateLimitPerMinute: 0,
      allowedHostnames: ["127.0.0.1", "localhost"]
    });
    try {
      await fs.chmod(root, 0o500);
      const ready = await rawRequest(handle, {
        path: "/readyz",
        headers: { host: `127.0.0.1:${handle.port}` }
      });
      assert.equal(ready.status, 503);
      assert.equal((JSON.parse(ready.body) as { ok: boolean }).ok, false);
    } finally {
      await fs.chmod(root, 0o700);
      await handle.close();
    }
  });
}
