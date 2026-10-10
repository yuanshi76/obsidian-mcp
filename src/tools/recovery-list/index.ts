import * as z from "zod";

import type { Runtime } from "../../runtime.js";
import type { ToolDefinition } from "../../types.js";
import { nonNegativeIntegerSchema, transactionIdSchema, vaultSchema } from "../../utils/schemas.js";
import { READ_ONLY } from "../../utils/tool-factory.js";

export const TOOL_NAME = "obsidian_recovery_list";

const inputSchema = z
  .object({
    vault: vaultSchema
  })
  .strict();

const entrySchema = z
  .object({
    id: transactionIdSchema.meta({
      description: "Transaction identifier accepted by obsidian_recovery_restore"
    }),
    state: z
      .enum(["preparing", "committing", "committed", "rolled_back"])
      .meta({ description: "Journal state; only committed transactions are restorable" }),
    created_at: z.iso
      .datetime()
      .meta({ description: "ISO timestamp when the transaction was prepared" }),
    completed_at: z.iso.datetime().optional().meta({
      description: "ISO timestamp when the transaction committed or rolled back"
    }),
    files: nonNegativeIntegerSchema.meta({
      description: "Number of file changes journaled by the transaction"
    })
  })
  .strict();

const outputSchema = z
  .object({
    entries: z
      .array(entrySchema)
      .meta({ description: "Recovery journal entries ordered newest first" })
  })
  .strict();

export function createRecoveryListTool(
  runtime: Runtime
): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    name: TOOL_NAME,
    title: "List Obsidian Recovery Journal",
    description:
      "Lists journaled transactions for a vault, newest first, with the state and file count of each. Use the ids with obsidian_recovery_restore to roll a committed transaction back.",
    inputSchema,
    outputSchema,
    annotations: READ_ONLY,
    execute: async ({ vault }) => {
      const service = runtime.forVault(vault);
      return { entries: await service.transactions.listRecovery() };
    }
  };
}
