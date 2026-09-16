// pages/api/sync/status.ts
// Estado de conectividad y pendientes del outbox para el banner offline del UI.
import type { NextApiRequest, NextApiResponse } from "next";
import { getPendingCount } from "../../../lib/syncOutbox";
import prisma from "../../../lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const [pendingSync, lastSyncSetting, planSetting, failedSync, openConflicts, pendingBreakdown] = await Promise.all([
      getPendingCount(),
      prisma.setting.findUnique({ where: { key: "supabase_last_sync" } }),
      prisma.setting.findUnique({ where: { key: "app_plan" } }),
      prisma.syncOutbox.count({ where: { status: "FAILED" } }),
      prisma.syncConflict.count({ where: { status: "OPEN" } }),
      prisma.syncOutbox.groupBy({
        by: ["entity", "operation"],
        where: { status: "PENDING" },
        _count: { _all: true },
      }),
    ]);

    const isPro =
      planSetting?.value === "pro" ||
      (await prisma.setting.findUnique({ where: { key: "plan_type" } }))?.value === "pro";

    res.status(200).json({
      pendingSync,
      failedSync,
      openConflicts,
      pendingBreakdown: pendingBreakdown.map((item) => ({
        entity: item.entity,
        operation: item.operation,
        count: item._count._all,
      })),
      lastSync: lastSyncSetting?.value || "",
      isPro: !!isPro,
    });
  } catch (error: any) {
    console.error("[SyncStatus] Error:", error);
    res.status(500).json({ message: error.message || "Error al obtener estado de sync." });
  }
}
