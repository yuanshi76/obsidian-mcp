import * as z from "zod";

import type { Runtime } from "../../runtime.js";
import type { ToolDefinition } from "../../types.js";
import { transactionIdSchema, vaultSchema } from "../../utils/schemas.js";
import { MUTATE } from "../../utils/tool-factory.js";

export const TOOL_NAME = "obsidian_recovery_restore";

const inputSchema = z
  .object({
    vault: vaultSchema,
    transaction_id: transactionIdSchema.meta({
      description: "Committed transaction to roll back, from obsidian_recovery_list"
    }),
    confirm_transaction_id: transactionIdSchema.optional().meta({
      description:
        "Required and must repeat transaction_id exactly, confirming a destructive rollback"
    })
  })
  .strict()
  .refine((value) => value.confirm_transaction_id === value.transaction_id, {
    path: ["confirm_transaction_id"],
    error:
      "confirm_transaction_id is required and must repeat transaction_id exactly; restoring overwrites current files."
  });

const outputSchema = z
  .object({
    transaction_id: transactionIdSchema.meta({
      description: "New journaled transaction created by the restore itself"
    }),
    restored_transaction_id: transactionIdSchema.meta({
      description: "Transaction whose changes were rolled back"
    })
  })
  .strict();

export function createRecoveryRestoreTool(
  runtime: Runtime
): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    name: TOOL_NAME,
    title: "Restore Obsidian Transaction",
    description:
      "Rolls a committed transaction back to the exact pre-change bytes stored in the journal. Restore refuses unless every affected file still matches the bytes the transaction committed (REVISION_CONFLICT otherwise), and the restore is itself journaled so it can be undone.",
    inputSchema,
    outputSchema,
    annotations: MUTATE,
    execute: async ({ vault, transaction_id: transactionId }) => {
      const service = runtime.forVault(vault);
      const restoreId = await service.transactions.restoreRecovery(transactionId);
      return { transaction_id: restoreId, restored_transaction_id: transactionId };
    }
  };
}
