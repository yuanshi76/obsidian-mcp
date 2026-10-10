import type { McpServer } from "@modelcontextprotocol/server";

import type { Runtime } from "../runtime.js";
import { registerTool } from "../utils/tool-factory.js";
import { createAddTagsTool, TOOL_NAME as ADD_TAGS } from "./add-tags/index.js";
import {
  createCreateDirectoryTool,
  TOOL_NAME as CREATE_DIRECTORY
} from "./create-directory/index.js";
import { createCreateNoteTool, TOOL_NAME as CREATE_NOTE } from "./create-note/index.js";
import { createDeleteNoteTool, TOOL_NAME as DELETE_NOTE } from "./delete-note/index.js";
import { createEditNoteTool, TOOL_NAME as EDIT_NOTE } from "./edit-note/index.js";
import { createListVaultsTool, TOOL_NAME as LIST_VAULTS } from "./list-vaults/index.js";
import { createManageTagsTool, TOOL_NAME as MANAGE_TAGS } from "./manage-tags/index.js";
import { createMoveNoteTool, TOOL_NAME as MOVE_NOTE } from "./move-note/index.js";
import { createReadNoteTool, TOOL_NAME as READ_NOTE } from "./read-note/index.js";
import { createRecoveryListTool, TOOL_NAME as RECOVERY_LIST } from "./recovery-list/index.js";
import {
  createRecoveryRestoreTool,
  TOOL_NAME as RECOVERY_RESTORE
} from "./recovery-restore/index.js";
import { createRemoveTagsTool, TOOL_NAME as REMOVE_TAGS } from "./remove-tags/index.js";
import { createRenameTagTool, TOOL_NAME as RENAME_TAG } from "./rename-tag/index.js";
import { createSearchVaultTool, TOOL_NAME as SEARCH_VAULT } from "./search-vault/index.js";

export const TOOL_NAMES = [
  LIST_VAULTS,
  READ_NOTE,
  CREATE_NOTE,
  EDIT_NOTE,
  DELETE_NOTE,
  MOVE_NOTE,
  CREATE_DIRECTORY,
  SEARCH_VAULT,
  ADD_TAGS,
  REMOVE_TAGS,
  RENAME_TAG,
  MANAGE_TAGS,
  RECOVERY_LIST,
  RECOVERY_RESTORE
] as const;

export function createToolDefinitions(runtime: Runtime) {
  return [
    createListVaultsTool(runtime),
    createReadNoteTool(runtime),
    createCreateNoteTool(runtime),
    createEditNoteTool(runtime),
    createDeleteNoteTool(runtime),
    createMoveNoteTool(runtime),
    createCreateDirectoryTool(runtime),
    createSearchVaultTool(runtime),
    createAddTagsTool(runtime),
    createRemoveTagsTool(runtime),
    createRenameTagTool(runtime),
    createManageTagsTool(runtime),
    createRecoveryListTool(runtime),
    createRecoveryRestoreTool(runtime)
  ] as const;
}

export function registerTools(server: McpServer, runtime: Runtime): void {
  const definitions = createToolDefinitions(runtime);
  registerTool(server, definitions[0]);
  registerTool(server, definitions[1]);
  registerTool(server, definitions[2]);
  registerTool(server, definitions[3]);
  registerTool(server, definitions[4]);
  registerTool(server, definitions[5]);
  registerTool(server, definitions[6]);
  registerTool(server, definitions[7]);
  registerTool(server, definitions[8]);
  registerTool(server, definitions[9]);
  registerTool(server, definitions[10]);
  registerTool(server, definitions[11]);
  registerTool(server, definitions[12]);
  registerTool(server, definitions[13]);
}
