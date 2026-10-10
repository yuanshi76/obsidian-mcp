import { constants as fsConstants, promises as fs } from "node:fs";

import type { Logger } from "./utils/logger.js";
import { TransactionManager, type TransactionOptions } from "./utils/transaction.js";
import { VaultFs, type ResolvedVault, type VaultRegistry } from "./utils/vault.js";

export interface VaultServices {
  vault: ResolvedVault;
  fs: VaultFs;
  transactions: TransactionManager;
}

export class Runtime {
  private readonly services = new Map<string, VaultServices>();

  constructor(
    readonly registry: VaultRegistry,
    private readonly transactionOptions: TransactionOptions,
    private readonly logger: Logger
  ) {}

  async initialize(): Promise<void> {
    for (const vault of this.registry.values()) {
      const transactions = new TransactionManager(vault, this.transactionOptions, this.logger);
      await transactions.initialize();
      this.services.set(vault.id, { vault, fs: new VaultFs(vault), transactions });
    }
  }

  forVault(id: string): VaultServices {
    this.registry.get(id);
    const value = this.services.get(id);
    if (value === undefined) throw new Error(`Vault services for '${id}' were not initialized.`);
    return value;
  }

  async doctor(): Promise<
    { vault: string; readable: boolean; writable: boolean; recovery_entries: number }[]
  > {
    const output = [];
    for (const id of this.registry.ids()) {
      const service = this.forVault(id);
      const root = service.vault.root;
      const readable = await canAccess(root, fsConstants.R_OK);
      const writable = await canAccess(root, fsConstants.W_OK);
      output.push({
        vault: id,
        readable,
        writable,
        recovery_entries: (await service.transactions.listRecovery()).length
      });
    }
    return output;
  }
}

async function canAccess(target: string, mode: number): Promise<boolean> {
  try {
    await fs.access(target, mode);
    return true;
  } catch {
    return false;
  }
}
