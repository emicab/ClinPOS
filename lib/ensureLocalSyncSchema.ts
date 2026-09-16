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
