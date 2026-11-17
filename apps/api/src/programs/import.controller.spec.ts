import 'reflect-metadata';
import { ImportController } from './import.controller';
import { RLS_TX_TIMEOUT_KEY } from '../adapters/prisma/rls-context';
import { IMPORT_REPLACE_TX_TIMEOUT_MS } from '../adapters/prisma/prisma-tx.util';

describe('ImportController RLS transaction budget', () => {
  // The production import path runs inside the per-request RLS transaction, whose
  // timeout the interceptor reads from @RlsTxTimeout metadata. Without this, a large
  // (within-limit) commit would P2028 at the 15s default instead of the import budget
  // (#532) — the per-row IMPORT_BATCH_TX_OPTIONS only governs the self-opened-tx path.
  // Both routes can replace or restore stored history, so they get a restore's budget (#1182).
  it('annotates the import handler with the replacing-import transaction budget', () => {
    const timeout = Reflect.getMetadata(RLS_TX_TIMEOUT_KEY, ImportController.prototype.import);
    expect(timeout).toBe(IMPORT_REPLACE_TX_TIMEOUT_MS);
  });

  it('annotates the undo handler with the replacing-import transaction budget', () => {
    const timeout = Reflect.getMetadata(RLS_TX_TIMEOUT_KEY, ImportController.prototype.undoImport);
    expect(timeout).toBe(IMPORT_REPLACE_TX_TIMEOUT_MS);
  });
});
