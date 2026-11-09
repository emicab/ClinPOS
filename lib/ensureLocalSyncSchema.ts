import prisma from "./prisma";

let schemaReady: Promise<void> | null = null;

async function execute(statement: string): Promise<void> {
  try {
    await (prisma as any).$executeRawUnsafe(statement);
  } catch (error: any) {
    const message = String(error?.message || error);
    // ALTER TABLE sobre una columna ya existente es un estado válido.
    if (/duplicate column|already exists/i.test(message)) return;
    throw error;
  }
}

export function ensureLocalSyncSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS "SyncOutbox" (
          "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          "operation" TEXT NOT NULL,
          "entity" TEXT NOT NULL,
          "entityKey" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'PENDING',
          "attempts" INTEGER NOT NULL DEFAULT 0,
          "lastError" TEXT,
          "payloadJson" TEXT,
          "nextAttemptAt" DATETIME,
          "lastAttemptAt" DATETIME,
          "lockedAt" DATETIME,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        `ALTER TABLE "SyncOutbox" ADD COLUMN "payloadJson" TEXT`,
        `ALTER TABLE "SyncOutbox" ADD COLUMN "nextAttemptAt" DATETIME`,
        `ALTER TABLE "SyncOutbox" ADD COLUMN "lastAttemptAt" DATETIME`,
        `ALTER TABLE "SyncOutbox" ADD COLUMN "lockedAt" DATETIME`,
        `CREATE INDEX IF NOT EXISTS "SyncOutbox_status_idx" ON "SyncOutbox"("status")`,
        `CREATE INDEX IF NOT EXISTS "SyncOutbox_status_nextAttemptAt_idx" ON "SyncOutbox"("status", "nextAttemptAt")`,
        `CREATE INDEX IF NOT EXISTS "SyncOutbox_entity_entityKey_status_idx" ON "SyncOutbox"("entity", "entityKey", "status")`,
        `CREATE TABLE IF NOT EXISTS "SyncTombstone" (
          "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          "entity" TEXT NOT NULL,
          "entityKey" TEXT NOT NULL,
          "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "deviceId" TEXT,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "SyncTombstone_entity_entityKey_key" ON "SyncTombstone"("entity", "entityKey")`,
        `CREATE TABLE IF NOT EXISTS "SyncConflict" (
          "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          "entity" TEXT NOT NULL,
          "entityKey" TEXT NOT NULL,
          "localVersion" TEXT,
          "remoteVersion" TEXT,
          "localPayload" TEXT,
          "remotePayload" TEXT,
          "status" TEXT NOT NULL DEFAULT 'OPEN',
          "resolution" TEXT,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "resolvedAt" DATETIME
        )`,
        `CREATE INDEX IF NOT EXISTS "SyncConflict_status_idx" ON "SyncConflict"("status")`,
        `CREATE INDEX IF NOT EXISTS "SyncConflict_entity_entityKey_status_idx" ON "SyncConflict"("entity", "entityKey", "status")`,
        // Ledger local de stock (migración v28 de Tauri). Sin esta tabla,
        // lib/stockService.ts falla con P2021 en la primera operación de stock
        // de una instalación que actualiza desde una versión anterior.
        `CREATE TABLE IF NOT EXISTS "StockMovement" (
          "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          "productId" INTEGER NOT NULL,
          "branchId" INTEGER,
          "delta" REAL NOT NULL,
          "quantityAfter" REAL NOT NULL,
          "reason" TEXT NOT NULL,
          "refType" TEXT,
          "refId" TEXT,
          "note" TEXT,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
          CONSTRAINT "StockMovement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
        )`,
        `CREATE INDEX IF NOT EXISTS "StockMovement_productId_branchId_idx" ON "StockMovement"("productId", "branchId")`,
        `CREATE INDEX IF NOT EXISTS "StockMovement_createdAt_idx" ON "StockMovement"("createdAt")`,
        `CREATE INDEX IF NOT EXISTS "StockMovement_refType_refId_idx" ON "StockMovement"("refType", "refId")`,
      ];

      for (const statement of statements) await execute(statement);
      console.log("[Schema] Esquema local de sincronización verificado.");
    })().catch((error) => {
      schemaReady = null;
      console.error("[Schema] No se pudo reparar el esquema local de sincronización:", error);
      throw error;
    });
  }
  return schemaReady;
}
