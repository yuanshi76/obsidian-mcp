# Creating tools

Each tool lives in `src/tools/<tool>/index.ts` and exports a definition factory. Add it to the explicit registry in `src/tools/index.ts`. Do not add low-level MCP request handlers or access filesystem paths directly.

A tool definition must provide:

- a service-prefixed snake_case name, title, and precise description;
- strict Zod input and data-output schemas;
- all four MCP annotations;
- an executor that returns vault-relative structured data;
- actionable `ToolFailure` errors rather than protocol errors.

## Schema contracts

Zod is the source of truth for the arguments the model sees, the values delivered to the executor, and successful structured output. The tool factory wraps each data schema in the shared result envelope:

```typescript
const inputSchema = z
  .object({
    vault: vaultSchema,
    path: relativePathSchema,
    limit: z
      .number({ error: "limit must be an integer result count." })
      .int("limit must be a whole number.")
      .min(1, "limit must be at least 1.")
      .max(100, "limit cannot exceed 100; use a cursor to continue.")
      .default(20)
      .meta({ description: "Maximum results in this page (1-100)" })
  })
  .strict();

const outputSchema = z
  .object({
    path: outputPathSchema,
    count: z.number().int().nonnegative(),
    next_cursor: z.string().optional()
  })
  .strict();

function createExampleTool(
  runtime: Runtime
): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    name: "obsidian_example",
    title: "Example Obsidian Tool",
    description: "Describe the complete operation and its important safety behavior.",
    inputSchema,
    outputSchema,
    annotations: READ_ONLY,
    execute: async ({ vault, path, limit }) => {
      // TypeScript requires this value to satisfy outputSchema.
      return { path, count: limit };
    }
  };
}
```

For every input field:

- use native constraints such as `.min()`, `.max()`, `.int()`, `.regex()`, enums, and strict objects so clients receive useful JSON Schema;
- provide schema-level error text that tells an agent how to repair the call;
- add `.meta({ description, examples })` after other immutable schema operations so metadata survives into `tools/list`;
- use `.refine()` or `.check()` only for stateless rules that JSON Schema cannot fully express, such as UTF-8 byte limits or conditional fields;
- do not coerce types or use transforms at the MCP boundary.

The SDK validates inputs before the executor runs and validates successful `structuredContent` against the concrete output schema. The tool factory explicitly validates error envelopes because the SDK intentionally skips output validation when `isError` is true.

Keep stateful and security-sensitive checks in the service layer. Vault existence, path containment, reserved roots, symlinks, current etags, filesystem state, and tag-domain grammar must continue to throw `ToolFailure`; this preserves stable codes such as `PATH_REJECTED` and `REVISION_CONFLICT`. Schema validation and service validation are complementary defenses.

Use `Runtime.forVault()` to resolve the requested vault and `VaultFs` to normalize and validate every path. Use `TransactionManager.run()` for every mutation; compute all primary and secondary changes before committing. Never interpolate a path into a shell command, follow symlinks, log note content, expose absolute paths, or write directly to stdout.

Add unit tests for schema issues, defaults, refinements, and output invariants; add service tests for security and stateful behavior; and add an end-to-end MCP call in `test/integration/server.test.ts`. Discovery tests must verify descriptive input properties and concrete output schemas. The registry must continue to expose exactly the documented 14 tools unless a deliberate API version changes that contract.
