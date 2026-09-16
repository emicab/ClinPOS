// lib/syncConflict.ts
// Criterio de resolución de conflictos del sync bidireccional.
// La versión de la nube solo se aplica sobre la local si es MÁS RECIENTE.
// Evita que un pull (que ocurre antes del push) pise cambios locales recién
// hechos con datos viejos todavía presentes en Supabase.
import prisma from "./prisma";

export function isCloudNewer(
  cloudUpdatedAt: string | null | undefined,
  localUpdatedAt: Date,
): boolean {
  if (!cloudUpdatedAt) return false;
  const cloud = new Date(cloudUpdatedAt);
  if (isNaN(cloud.getTime())) return false;
  return cloud.getTime() > localUpdatedAt.getTime();
}

export async function recordSyncConflict(input: {
  entity: string;
  entityKey: string;
  localVersion?: Date | string | null;
  remoteVersion?: Date | string | null;
  localPayload?: unknown;
  remotePayload?: unknown;
}): Promise<void> {
  try {
    const open = await prisma.syncConflict.findFirst({
      where: { entity: input.entity, entityKey: input.entityKey, status: "OPEN" },
      select: { id: true },
    });
    if (open) return;

    const asText = (value: Date | string | null | undefined) =>
      value instanceof Date ? value.toISOString() : value ?? null;
    await prisma.syncConflict.create({
      data: {
        entity: input.entity,
        entityKey: input.entityKey,
        localVersion: asText(input.localVersion),
        remoteVersion: asText(input.remoteVersion),
        localPayload: input.localPayload === undefined ? null : JSON.stringify(input.localPayload),
        remotePayload: input.remotePayload === undefined ? null : JSON.stringify(input.remotePayload),
      },
    });
  } catch (error) {
    console.warn("[Sync] No se pudo registrar el conflicto:", error);
  }
}
