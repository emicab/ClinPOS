// components/layout/Layout.tsx
"use client";

import React, { useState } from "react";
import Sidebar from "./Sidebar";
import Header from "./Header";
import KbdFooter from "./KbdFooter";
import { useModules } from "@/hooks/useModules";
import { formatSyncBreakdown, useSyncStatus } from "@/hooks/useSyncStatus";
import { usePathname } from "next/navigation";
import { ShieldAlert, WifiOff, CloudOff } from "lucide-react";
import { createClient } from "@supabase/supabase-js";

interface LayoutProps {
  children: React.ReactNode;
}

const AccessDeniedView = () => (
  <div className="flex flex-col items-center justify-center p-12 py-24 text-center space-y-4">
    <div className="bg-destructive/10 text-destructive p-4 rounded-full shadow-inner animate-pulse">
      <ShieldAlert size={36} />
    </div>
    <h2 className="text-2xl font-bold text-foreground uppercase tracking-tight">
      Acceso Restringido
    </h2>
    <p className="text-sm text-foreground-muted max-w-sm leading-relaxed">
      Tu cuenta no tiene los permisos necesarios para acceder a esta sección.
      Comunicante con el administrador del sistema.
    </p>
  </div>
);

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const {
    businessProfile,
    isLoading,
    isModuleEnabled,
    currentUser,
    hasSupabaseConfig,
    storageMode,
    hasRolePermission,
    plan,
  } = useModules();
  const { online, pendingSync, pendingBreakdown, cloudBlocked } = useSyncStatus();
  const pathname = usePathname() || "";
  // Backoff de sync: ante fallos repetidos se espacian los intentos
  // (2^n min, tope 30) en vez de quemar egress cada 5 min en loop.
  const syncFailCount = React.useRef(0);
  const syncCooldownUntil = React.useRef(0);

  // El sync a la nube solo está activo en planes con respaldo en la nube.
  const isSyncEnabled =
    plan === "pro" && hasSupabaseConfig && storageMode !== "local";

  const showOnboarding = !isLoading && businessProfile === "unset";
  const showPinLock =
    !isLoading && !showOnboarding && isModuleEnabled("roles") && !currentUser;

  // Auto-sync periódico con Supabase + Realtime liviano (solo WebOrder).
  // El backoff evita quemar egress en loops de fallo; ver efecto Realtime abajo.
  React.useEffect(() => {
    if (
      isLoading ||
      plan !== "pro" ||
      !hasSupabaseConfig ||
      showOnboarding ||
      showPinLock ||
      storageMode === "local"
    ) {
      return;
    }

    const registerSyncFailure = () => {
      syncFailCount.current += 1;
      const backoffMs = Math.min(Math.pow(2, syncFailCount.current) * 60000, 30 * 60000);
      syncCooldownUntil.current = Date.now() + backoffMs;
    };

    const triggerSync = async () => {
      // Enfriamiento por fallos: no gastar egress en un loop que no avanza.
      if (Date.now() < syncCooldownUntil.current) return;
      try {
        const res = await fetch("/api/sync");
        if (res.ok) {
          syncFailCount.current = 0;
          syncCooldownUntil.current = 0;
          window.dispatchEvent(new Event("sync-completed"));
          // Cron distribuido de expiración de pedidos web: reusa el ciclo de
          // 5 min del sync. Fire-and-forget, no bloquea ni rompe el sync.
          fetch("/api/web-orders/expire-pending", {
            method: "POST",
          }).catch((err) => {
            console.error("Error al disparar la expiración de pedidos web:", err);
          });
        } else {
          registerSyncFailure();
        }
      } catch (err) {
        registerSyncFailure();
        console.error(
          "Error al sincronizar automáticamente con Supabase:",
          err,
        );
      }
    };

    const initialTimeout = setTimeout(triggerSync, 5000);
    const fallbackInterval = setInterval(triggerSync, 300000);
    const onConnectionRestored = () => {
      // El watermark y el outbox hacen que este intento sea idempotente.
      triggerSync();
    };
    window.addEventListener("online", onConnectionRestored);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(fallbackInterval);
      window.removeEventListener("online", onConnectionRestored);
    };
  }, [isLoading, hasSupabaseConfig, showOnboarding, showPinLock, storageMode, plan]);

  // Realtime liviano: SOLO WebOrder dispara un pull de pedidos (no un sync
  // full). ProductBranchStock se excluyó a propósito: cada venta escribe
  // stock en la nube y esos eventos rebotaban a todos los POS disparando
  // full-syncs (origen del salto 800MB→4GB / 1.4M mensajes). El ciclo
  // periódico sigue siendo el respaldo ante eventos perdidos.
  React.useEffect(() => {
    if (isLoading || plan !== "pro" || !hasSupabaseConfig || showOnboarding || showPinLock || storageMode === "local") return;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const refreshFromRealtime = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        try {
          const response = await fetch("/api/web-orders/pull");
          if (response.ok) window.dispatchEvent(new Event("sync-completed"));
        } catch (error) {
          console.warn("[Realtime] No se pudo actualizar el estado local:", error);
        }
      }, 5000);
    };

    (async () => {
      try {
        const response = await fetch("/api/sync/config");
        if (!response.ok || cancelled) return;
        const config = await response.json();
        const client = createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: false } });
        channel = client
          .channel(`clinpos-${config.tenantId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "WebOrder", filter: `tenant_id=eq.${config.tenantId}` }, refreshFromRealtime)
          .subscribe();
      } catch (error) {
        console.warn("[Realtime] No se pudo iniciar la escucha:", error);
      }
    })();

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (channel) channel.unsubscribe();
    };
  }, [isLoading, hasSupabaseConfig, showOnboarding, showPinLock, storageMode, plan]);

  let isAccessAllowed = true;
  if (
    !isLoading &&
    !showOnboarding &&
    !showPinLock &&
    isModuleEnabled("roles") &&
    currentUser
  ) {
    isAccessAllowed = hasRolePermission(currentUser.role, pathname);
  }

  return (
    <div className="md:flex h-screen bg-background text-foreground">
      <div className="print:hidden">
        <Sidebar
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
        />
      </div>

      <div className="flex flex-1 flex-col min-w-0 print:block">
        <div className="print:hidden">
          <Header onMenuClick={() => setIsSidebarOpen(true)} />
        </div>
        <main className="flex-1 overflow-y-auto p-6 md:p-8 print:p-0 print:overflow-visible">
          {isSyncEnabled && !online && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-600">
              <WifiOff size={16} className="shrink-0" />
              Sin conexión a internet. Tus ventas y cambios se guardan en esta
              computadora y se sincronizarán automáticamente cuando vuelva la conexión.
            </div>
          )}
          {isSyncEnabled && online && pendingSync > 0 && !cloudBlocked && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 text-sm font-semibold text-blue-600">
              <CloudOff size={16} className="shrink-0" />
              {pendingSync} operación{pendingSync !== 1 ? "es" : ""} pendiente
              {pendingSync !== 1 ? "s" : ""} de sincronizar con la nube
              {pendingBreakdown.length > 0 && (
                <span className="ml-1 inline-flex flex-wrap items-center gap-1 font-normal">
                  {pendingBreakdown.map((item) => (
                    <span key={`${item.entity}-${item.operation}`} className="rounded-full border border-blue-500/20 bg-white/60 px-2 py-0.5 text-[11px] font-semibold">
                      {formatSyncBreakdown(item)}
                    </span>
                  ))}
                </span>
              )}.
            </div>
          )}
          {isAccessAllowed ? children : <AccessDeniedView />}
        </main>
        <div className="print:hidden">
          <KbdFooter />
        </div>
      </div>
    </div>
  );
};

export default Layout;
