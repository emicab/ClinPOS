-- Sync protocol v2: durable retry metadata, tombstones and conflict records.
ALTER TABLE "SyncOutbox" ADD COLUMN "payloadJson" TEXT;
ALTER TABLE "SyncOutbox" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "SyncOutbox" ADD COLUMN "lastAttemptAt" DATETIME;
ALTER TABLE "SyncOutbox" ADD COLUMN "lockedAt" DATETIME;

CREATE INDEX "SyncOutbox_status_nextAttemptAt_idx"
  ON "SyncOutbox"("status", "nextAttemptAt");
CREATE INDEX "SyncOutbox_entity_entityKey_status_idx"
  ON "SyncOutbox"("entity", "entityKey", "status");

CREATE TABLE "SyncTombstone" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "entity" TEXT NOT NULL,
  "entityKey" TEXT NOT NULL,
  "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deviceId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SyncTombstone_entity_entityKey_key"
  ON "SyncTombstone"("entity", "entityKey");
CREATE INDEX "SyncTombstone_deletedAt_idx"
  ON "SyncTombstone"("deletedAt");

CREATE TABLE "SyncConflict" (
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
CREATE INDEX "SyncConflict_status_idx" ON "SyncConflict"("status");
CREATE INDEX "SyncConflict_entity_entityKey_status_idx"
  ON "SyncConflict"("entity", "entityKey", "status");
