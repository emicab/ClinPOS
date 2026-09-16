"use client";

import { useState, useEffect, useCallback } from "react";

export type SyncBreakdown = { entity: string; operation: string; count: number };

const SYNC_ENTITY_LABELS: Record<string, string> = {
  Product: "productos",
  ProductBranchStock: "stock",
  WebOrder: "pedidos web",
  Sale: "ventas",
  Purchase: "compras",
  StockTransfer: "transferencias",
  ProductModifierGroup: "opciones de productos",
  Combo: "combos",
  Promotion: "promociones",
};

const SYNC_OPERATION_LABELS: Record<string, string> = {
  UPSERT: "actualizaciones",
  DELETE: "eliminaciones",
};

export function formatSyncBreakdown(item: SyncBreakdown): string {
  const operation = SYNC_OPERATION_LABELS[item.operation] || "cambios";
  const entity = SYNC_ENTITY_LABELS[item.entity] || item.entity.toLowerCase();
  return `${item.count} ${operation} de ${entity}`;
}

// Estado de conectividad + operaciones pendientes del outbox para el banner offline.
export function useSyncStatus() {
  const [online, setOnline] = useState<boolean>(true);
  const [pendingSync, setPendingSync] = useState<number>(0);
  const [lastSync, setLastSync] = useState<string>("");
  const [pendingBreakdown, setPendingBreakdown] = useState<SyncBreakdown[]>([]);
  const [openConflicts, setOpenConflicts] = useState<number>(0);

  useEffect(() => {
    const isOnline = () =>
      typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true;
    setOnline(isOnline());

    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status");
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.pendingSync === "number") setPendingSync(data.pendingSync);
      if (typeof data.lastSync === "string") setLastSync(data.lastSync);
      if (Array.isArray(data.pendingBreakdown)) setPendingBreakdown(data.pendingBreakdown);
      if (typeof data.openConflicts === "number") setOpenConflicts(data.openConflicts);
    } catch {
      // sin red: mantener estado actual
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 60000);
    const onSyncCompleted = () => refreshStatus();
    window.addEventListener("sync-completed", onSyncCompleted);
    return () => {
      clearInterval(interval);
      window.removeEventListener("sync-completed", onSyncCompleted);
    };
  }, [refreshStatus]);

  return { online, pendingSync, pendingBreakdown, openConflicts, lastSync, refreshStatus };
}
