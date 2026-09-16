-- Reparación idempotente para instalaciones que quedaron con la migración
-- del protocolo de sincronización aplicada de forma incompleta.
CREATE TABLE IF NOT EXISTS "SyncOutbox" (
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
);

CREATE TABLE IF NOT EXISTS "SyncTombstone" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "entity" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "SyncTombstone_entity_entityKey_key"
    ON "SyncTombstone"("entity", "entityKey");

CREATE TABLE IF NOT EXISTS "SyncConflict" (
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
);

CREATE INDEX IF NOT EXISTS "SyncConflict_status_idx" ON "SyncConflict"("status");
CREATE INDEX IF NOT EXISTS "SyncConflict_entity_entityKey_status_idx"
    ON "SyncConflict"("entity", "entityKey", "status");
