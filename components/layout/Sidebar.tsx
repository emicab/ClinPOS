import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import pkg from "../../package.json";
import { useModules } from "@/hooks/useModules";
import {
  Package,
  Tag,
  Users,
  UserPlus,
  FileText,
  PlusSquare,
  TrendingDown,
  X,
  Truck,
  ArrowUpRightSquare,
  History,
  LayoutDashboard,
  Wallet,
  Settings,
  Barcode,
  ShoppingBag,
  Percent,
  AlertTriangle,
  ChevronDown,
  RefreshCcw,
  Bookmark,
  Ticket,
  ArrowRightLeft,
  ChefHat,
  Building2,
} from "lucide-react";
import toast from "react-hot-toast";
import ConfirmationModal from "@/components/ui/ConfirmationModal";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  moduleId?: string;
  allowedRoles?: string[];
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    title: "Ventas y Caja",
    items: [
      { href: "/caja", label: "Caja", icon: <Wallet size={20} /> },
      {
        href: "/ventas/nueva",
        label: "Nueva Venta",
        icon: <PlusSquare size={20} />,
      },
      {
        href: "/ventas",
        label: "Historial Ventas",
        icon: <FileText size={20} />,
      },
      {
        href: "/pedidos-web",
        label: "Pedidos Web (ClinStore)",
        icon: <ShoppingBag size={20} />,
        moduleId: "pedidos_web",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/consignaciones",
        label: "Consignaciones",
        icon: <RefreshCcw size={20} />,
        moduleId: "consignaciones",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
    ],
  },
  {
    title: "Productos y Stock",
    items: [
      {
        href: "/productos",
        label: "Productos",
        icon: <Package size={20} />,
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/recetario",
        label: "Recetario 🧾",
        icon: <ChefHat size={20} />,
        moduleId: "recetario",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/stock",
        label: "Carga de Stock",
        icon: <Barcode size={20} />,
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/stock/alertas",
        label: "Alertas de Stock",
        icon: <AlertTriangle size={20} />,
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/traspasos",
        label: "Traspasos",
        icon: <ArrowRightLeft size={20} />,
        moduleId: "traspasos",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/categorias",
        label: "Categorías",
        icon: <Tag size={20} />,
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/marcas",
        label: "Marcas",
        icon: <Tag size={20} />,
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
    ],
  },
  {
    title: "Marketing",
    items: [
      {
        href: "/combos",
        label: "Combos",
        icon: <ShoppingBag size={20} />,
        moduleId: "combos_promociones",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/promociones",
        label: "Promociones",
        icon: <Percent size={20} />,
        moduleId: "combos_promociones",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/codigos-descuento",
        label: "Códigos de Descuento",
        icon: <Ticket size={20} />,
        moduleId: "combos_promociones",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
    ],
  },
  {
    title: "Compras y Gastos",
    items: [
      {
        href: "/compras/nueva",
        label: "Nueva Compra",
        icon: <ArrowUpRightSquare size={20} />,
        moduleId: "compras",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/compras",
        label: "Historial Compras",
        icon: <History size={20} />,
        moduleId: "compras",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/gastos",
        label: "Gastos",
        icon: <TrendingDown size={20} />,
        moduleId: "gastos",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
    ],
  },
  {
    title: "Contactos",
    items: [
      {
        href: "/clientes",
        label: "Clientes",
        icon: <Users size={20} />,
        moduleId: "clientes",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/cuenta-corriente",
        label: "Cuenta Corriente",
        icon: <Users size={20} />,
        moduleId: "cuenta_corriente",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/proveedores",
        label: "Proveedores",
        icon: <Truck size={20} />,
        moduleId: "compras",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
      {
        href: "/vendedores",
        label: "Vendedores",
        icon: <UserPlus size={20} />,
        moduleId: "vendedores",
        allowedRoles: ["ADMIN", "SUPERVISOR"],
      },
    ],
  },
  {
    title: "General",
    items: [
      {
        href: "/analiticas",
        label: "Analíticas",
        icon: <LayoutDashboard size={20} />,
        moduleId: "analiticas",
        allowedRoles: ["ADMIN"],
      },
      {
        href: "/notas-ia",
        label: "Notas Guardadas (IA)",
        icon: <Bookmark size={20} />,
        moduleId: "analiticas",
        allowedRoles: ["ADMIN"],
      },
      {
        href: "/configuracion/usuarios",
        label: "Usuarios y Permisos",
        icon: <Users size={20} />,
        allowedRoles: ["ADMIN"],
      },
      {
        href: "/configuracion",
        label: "Configuración",
        icon: <Settings size={20} />,
        allowedRoles: ["ADMIN"],
      },
    ],
  },
];

const STORAGE_KEY = "sidebar-collapsed-groups";

function loadCollapsed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveCollapsed(groups: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...groups]));
}

import ProUpgradeModal from "@/components/ui/ProUpgradeModal";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { isRouteVisibleForProfile } from "@/lib/moduleCatalog";

const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  const { online, pendingSync } = useSyncStatus();
  const {
    isModuleEnabled,
    currentUser,
    logout,
    supabaseLastSync,
    hasSupabaseConfig,
    storageMode,
    plan,
    hasRolePermission,
    businessProfile,
  } = useModules();
  const [alertCount, setAlertCount] = useState(0);
  const [activeBusinessName, setActiveBusinessName] = useState<string | null>(null);
  const [isMultiBusiness, setIsMultiBusiness] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const hasHydratedRef = useRef(false);
  const [appVersion, setAppVersion] = useState(pkg.version);
  const [lockedFeatureModal, setLockedFeatureModal] = useState<string | null>(
    null,
  );
  const reviewNotifiedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    setCollapsedGroups(loadCollapsed());
    hasHydratedRef.current = true;
  }, []);

  useEffect(() => {
    fetch("/api/profiles")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setIsMultiBusiness((data.profiles || []).length > 1);
        const active = (data.profiles || []).find(
          (p: any) => p.id === data.activeProfileId,
        );
        if (active) setActiveBusinessName(active.name);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (hasHydratedRef.current) {
      saveCollapsed(collapsedGroups);
    }
  }, [collapsedGroups]);

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
          const { getVersion } = await import("@tauri-apps/api/app");
          const version = await getVersion();
          setAppVersion(version);
        }
      } catch (err) {
        console.error("Failed to fetch Tauri version", err);
      }
    };
    fetchVersion();
  }, []);

  useEffect(() => {
    const fetchAlertCount = async () => {
      try {
        const res = await fetch("/api/products/alert-count");
        if (res.ok) {
          const data = await res.json();
          setAlertCount(data.count);
        }
      } catch {
        // Silently fail
      }
    };
    fetchAlertCount();
    const interval = setInterval(fetchAlertCount, 60000);
    return () => clearInterval(interval);
  }, []);

  // Alertas urgentes: pedidos web rechazados por stock insuficiente.
  useEffect(() => {
    const fetchWebOrderAlerts = async () => {
      try {
        const res = await fetch("/api/web-order-alerts");
        if (!res.ok) return;
        const data = await res.json();
        const alerts: any[] = data.alerts || [];
        alerts.forEach((alert: any) => {
          const qtyText = alert.requestedQty != null ? ` (${alert.requestedQty})` : "";
          const productName = alert.productName || "Producto";
          toast.error(
            `Pedido web rechazado: sin stock de ${productName}${qtyText}. Actualizá el stock o contactá al cliente.`,
            { duration: 8000 }
          );
        });
      } catch {
        // Silently fail
      }
    };
    fetchWebOrderAlerts();
    const interval = setInterval(fetchWebOrderAlerts, 60000);
    return () => clearInterval(interval);
  }, []);

  // Pedidos web EN REVISIÓN por falta de stock local (Regla de Oro: el cliente
  // físico gana la última unidad). Avisa al comerciante para que decida.
  useEffect(() => {
    const fetchReviewAlerts = async () => {
      try {
        const res = await fetch("/api/web-orders/review-alerts");
        if (!res.ok) return;
        const data = await res.json();
        const alerts: any[] = data.alerts || [];
        alerts.forEach((a: any) => {
          const id = Number(a.id);
          if (reviewNotifiedRef.current.has(id)) return;
          reviewNotifiedRef.current.add(id);
          const money =
            a.totalAmount != null
              ? ` ($${Number(a.totalAmount).toLocaleString("es-AR")})`
              : "";
          toast.error(
            `⚠️ Pedido ${a.webOrderNumber} en revisión: falta stock local${money}. Revisá y decidí cancelar/reponer.`,
            { duration: 10000 }
          );
        });
      } catch {
        // silencioso
      }
    };
    fetchReviewAlerts();
    const interval = setInterval(fetchReviewAlerts, 60000);
    return () => clearInterval(interval);
  }, []);

  const toggleGroup = (title: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
  };

  const sidebarClasses = `
    fixed inset-y-0 left-0 z-50 h-full w-64 bg-muted text-foreground-muted flex-col border-r border-border
    transform transition-transform duration-300 ease-in-out
    md:sticky md:translate-x-0 md:flex
    ${isOpen ? "translate-x-0" : "-translate-x-full"}
  `;

  const overlayClasses = `
    fixed inset-0 z-40 bg-black/60 md:hidden
    transition-opacity duration-300 ease-in-out
    ${isOpen ? "opacity-100" : "opacity-0 pointer-events-none"}
  `;

  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<any>(null);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);

  useEffect(() => {
    let mounted = true;
    const checkSilent = async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (mounted && update) {
          setAvailableUpdate(update);
        }
      } catch (e) {
        // silently ignore error on mount
      }
    };
    // Delay check slightly to avoid blocking initial render
    const timer = setTimeout(checkSilent, 3000);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, []);

  const checkForUpdates = async () => {
    try {
      setIsCheckingUpdate(true);
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setAvailableUpdate(update);
        setIsUpdateModalOpen(true);
      } else {
        toast.success("La aplicación está en su última versión.");
      }
    } catch (err: any) {
      console.error("Update error:", err);
      const errMsg =
        typeof err === "string"
          ? err
          : err?.message ||
            (typeof err === "object" ? JSON.stringify(err) : String(err));
      toast.error(`Error: ${errMsg}`);
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  // Espera a que el server local libere el puerto 3001 (cualquier respuesta
  // HTTP = sigue vivo; solo "connection refused" = libre). Evita el clásico
  // `os error 32` del instalador por archivos bloqueados por node huérfano.
  const waitForPortFree = async (timeoutMs = 15000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2000);
        await fetch("http://127.0.0.1:3001/api/health/db", {
          cache: "no-store",
          signal: ctl.signal,
        });
        clearTimeout(t);
        await new Promise((r) => setTimeout(r, 500));
      } catch (err: any) {
        if (err?.name === "AbortError") continue; // timeout: sigue vivo
        return true; // connection refused: puerto libre
      }
    }
    return false;
  };

  const handleInstallUpdate = async () => {
    if (!availableUpdate) return;
    try {
      setIsInstallingUpdate(true);
      toast.success(
        `Descargando e instalando versión ${availableUpdate.version}... aguarda un momento.`,
      );
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        await invoke("kill_server");
      } catch (e) {
        console.error("Failed to kill server", e);
      }
      // Cazar huérfanos de versiones viejas (sin Job Object) que atan el
      // puerto 3001 y los archivos. Sin esto, el update se bloquea sin salida
      // porque cerrar la app también cierra esta pantalla.
      try {
        const killed = await invoke<number>("kill_stale_node_servers");
        if (killed > 0) {
          console.log(`Update: se eliminaron ${killed} procesos node huérfanos`);
        }
      } catch (e) {
        console.error("Failed to kill stale servers", e);
      }
      const portFree = await waitForPortFree();
      if (!portFree) {
        toast.error(
          "El servidor local sigue ocupado después de limpiar procesos. Reiniciá la PC e intentá actualizar de nuevo.",
        );
        return;
      }
      await availableUpdate.downloadAndInstall();
      toast.success(
        "¡Actualización instalada! La aplicación se cerrará para aplicar los cambios.",
      );
      setIsUpdateModalOpen(false);
      // Cerrar la ventana aplica la actualización (reemplaza el exe en uso).
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (err: any) {
      console.error("Install error:", err);
      const errMsg =
        typeof err === "string"
          ? err
          : err?.message ||
            (typeof err === "object" ? JSON.stringify(err) : String(err));
      toast.error(`Error al instalar: ${errMsg}`);
    } finally {
      setIsInstallingUpdate(false);
    }
  };

  // El ADMIN ve todo: se salta candados de plan y filtros de módulos/perfil.
  // Los demás roles pasan por las 3 compuertas (plan Pro, permisos, perfil).
  const isAdmin = currentUser?.role === "ADMIN";

  // Filtrar los grupos según módulos activos y rol de usuarios
  const filteredGroups = navGroups
    .map((group) => {
      const processedItems = group.items
        .map((item) => {
          if (isAdmin) return { ...item, isLocked: false };
          const isEnabled = !item.moduleId || isModuleEnabled(item.moduleId);
          const isProFeature = [
            "cuenta_corriente",
            "analiticas",
            "consignaciones",
            "agente_ia",
            "traspasos",
            "pedidos_web",
          ].includes(item.moduleId || "");

          // If feature belongs to Pro plan and we are in basic plan, keep item visible with lock
          if (!isEnabled && isProFeature && plan === "basico") {
            return {
              ...item,
              href: "/configuracion",
              isLocked: true,
            };
          }

          if (!isEnabled) return null;

          // Filter role permissions dynamically
          if (isModuleEnabled("roles") && currentUser) {
            if (!hasRolePermission(currentUser.role, item.href)) return null;
          }

          // UX por rubro (WP5): ocultar módulos avanzados en perfiles minimalistas.
          if (!isRouteVisibleForProfile(businessProfile, item.href)) return null;

          return { ...item, isLocked: false };
        })
        .filter(
          (item): item is NavItem & { isLocked: boolean } => item !== null,
        );

      return { ...group, items: processedItems };
    })
    .filter((group) => group.items.length > 0);

  return (
    <>
      <div className={overlayClasses} onClick={onClose} />

      <aside id="sidebar" className={sidebarClasses}>
        <div className="flex h-16 items-center justify-between border-b border-border px-4">
          <Link href="/" className="text-xl font-semibold text-primary">
            ClinPOS
          </Link>
          <button
            onClick={onClose}
            className="rounded-full p-1 hover:bg-border md:hidden"
            aria-label="Cerrar menú"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-grow overflow-y-auto p-4 space-y-3">
          {filteredGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.title);
            return (
              <div key={group.title}>
                <button
                  onClick={() => toggleGroup(group.title)}
                  className="flex w-full items-center justify-between px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-foreground-muted/70 hover:text-foreground transition-colors rounded-md"
                >
                  {group.title}
                  <ChevronDown
                    size={14}
                    className={`transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}`}
                  />
                </button>
                <div
                  className={`overflow-hidden transition-all duration-200 ease-in-out ${
                    isCollapsed ? "max-h-0 opacity-0" : "max-h-96 opacity-100"
                  }`}
                >
                  <div className="space-y-0.5 pt-0.5">
                    {group.items.map((item) => (
                      <Link
                        key={item.label}
                        href={item.isLocked ? "#" : item.href}
                        onClick={(e) => {
                          if (item.isLocked) {
                            e.preventDefault();
                            setLockedFeatureModal(item.label);
                          } else {
                            onClose();
                          }
                        }}
                        className={`flex items-center space-x-3 px-3 py-2 rounded-md transition-colors duration-150 ease-in-out font-medium text-sm ${
                          item.isLocked
                            ? "opacity-75 hover:bg-amber-50 text-amber-800 cursor-pointer"
                            : "hover:bg-primary-light hover:text-primary"
                        }`}
                      >
                        {item.icon}
                        <span className="flex-1">{item.label}</span>
                        {item.isLocked && (
                          <span className="text-[9px] font-extrabold uppercase bg-amber-100 text-amber-900 border border-amber-300 px-1.5 py-0.5 rounded shadow-xs">
                            PRO 🔒
                          </span>
                        )}
                        {item.label === "Notas Guardadas (IA)" && (
                          <span className="text-[9px] font-extrabold uppercase bg-blue-100 text-blue-900 border border-blue-300 px-1.5 py-0.5 rounded shadow-xs ml-1">
                            Experimental
                          </span>
                        )}
                        {item.label === "Alertas de Stock" &&
                          alertCount > 0 && (
                            <span className="bg-destructive text-destructive-foreground text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                              {alertCount > 99 ? "99+" : alertCount}
                            </span>
                          )}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </nav>

        {activeBusinessName && (
          <div className="mx-4 mb-2 p-3 rounded-xl border border-border bg-background/50">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Building2 size={16} className="text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="text-[9px] uppercase font-bold text-foreground-muted tracking-wider">
                    Negocio activo
                  </p>
                  <p className="text-xs font-bold text-foreground truncate">
                    {activeBusinessName}
                  </p>
                </div>
              </div>
              {isMultiBusiness && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new Event("open-business-picker"))}
                  className="px-2 py-1 text-[10px] font-bold bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors cursor-pointer shrink-0"
                  title="Cambiar de negocio"
                >
                  Cambiar
                </button>
              )}
            </div>
          </div>
        )}

        {currentUser && (
          <div className="px-4 py-2.5 border-t border-border flex items-center justify-between text-xs bg-background/50">
            <div className="min-w-0">
              <p className="font-bold text-foreground truncate">
                {currentUser.name}
              </p>
              <p className="text-[9px] uppercase font-bold text-primary tracking-wider mt-0.5">
                {currentUser.role === "ADMIN"
                  ? "👑 Administrador"
                  : currentUser.role === "SUPERVISOR"
                    ? "⭐ Supervisor"
                    : "🛒 Cajero"}
              </p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="px-2.5 py-1.5 text-[10px] font-bold bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors cursor-pointer shrink-0"
              title="Cerrar sesión y cambiar usuario"
            >
              Cambiar Usuario 🔓
            </button>
          </div>
        )}

        {availableUpdate && (
          <div className="mx-4 mb-3 p-3 bg-primary/10 border border-primary/30 rounded-xl shadow-sm">
            <p className="text-xs font-bold text-primary mb-1 flex items-center">
              <span className="relative flex h-2 w-2 mr-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              ¡Actualización disponible!
            </p>
            <p className="text-[10px] text-foreground-muted mb-3 font-medium leading-tight">
              La versión <span className="font-bold text-foreground">v{availableUpdate.version}</span> está lista para ser instalada.
            </p>
            <button
              onClick={() => setIsUpdateModalOpen(true)}
              className="w-full py-1.5 bg-primary hover:bg-primary-dark text-primary-foreground text-[10px] font-bold rounded-lg shadow-sm transition-colors cursor-pointer"
            >
              Ver e Instalar
            </button>
          </div>
        )}

        <div className="p-4 border-t border-border space-y-2 text-center">
          <div className="flex items-center justify-center gap-2">
            <p className="text-[11px] font-semibold text-foreground-muted">
              ClinPOS v{appVersion}
            </p>
            <button
              onClick={checkForUpdates}
              disabled={isCheckingUpdate}
              className="text-[10px] font-bold text-primary hover:text-primary-dark transition-colors flex items-center gap-1 bg-primary/10 hover:bg-primary/20 px-2 py-0.5 rounded-full cursor-pointer disabled:opacity-50"
              title="Buscar actualizaciones"
            >
              <RefreshCcw
                size={10}
                className={isCheckingUpdate ? "animate-spin" : ""}
              />
              Actualizar
            </button>
          </div>
          {plan === "pro" && storageMode === "safe" && (
            <div className="flex items-center justify-center gap-1.5 text-[9px] text-foreground-muted/70 font-semibold mb-1">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  !online
                    ? "bg-amber-400 animate-pulse"
                    : pendingSync > 0
                      ? "bg-blue-500"
                      : !hasSupabaseConfig
                        ? "bg-amber-400 animate-pulse"
                        : !supabaseLastSync
                          ? "bg-amber-400 animate-pulse"
                          : Date.now() - new Date(supabaseLastSync).getTime() <
                              24 * 60 * 60 * 1000
                            ? "bg-emerald-500"
                            : "bg-amber-400"
                }`}
              />
              <span
                className="truncate max-w-[160px]"
                title={
                  !online
                    ? "Sin conexión"
                    : pendingSync > 0
                      ? `${pendingSync} operación(es) pendiente(s) de sincronizar`
                      : !hasSupabaseConfig
                        ? "Nube sin configurar"
                        : !supabaseLastSync
                          ? "Sincronización pendiente"
                          : `Último backup: ${new Date(supabaseLastSync).toLocaleString("es-AR")}`
                }
              >
                {!online
                  ? "Sin conexión"
                  : pendingSync > 0
                    ? `${pendingSync} pendiente${pendingSync !== 1 ? "s" : ""}`
                    : !hasSupabaseConfig
                      ? "Nube sin configurar"
                      : !supabaseLastSync
                        ? "Sincronización pendiente"
                        : `Nube: ${new Date(supabaseLastSync).toLocaleDateString("es-AR")} ${new Date(supabaseLastSync).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`}
              </span>
            </div>
          )}
        </div>
      </aside>

      <ProUpgradeModal
        isOpen={!!lockedFeatureModal}
        onClose={() => setLockedFeatureModal(null)}
        featureName={lockedFeatureModal || undefined}
      />

      <ConfirmationModal
        isOpen={isUpdateModalOpen}
        onClose={() => setIsUpdateModalOpen(false)}
        onConfirm={handleInstallUpdate}
        title="Actualización Disponible"
        confirmText="Descargar e Instalar"
        isLoading={isInstallingUpdate}
      >
        <div className="space-y-3 text-sm">
          <p className="text-foreground">
            Hay una nueva versión de <strong>ClinPOS (v{availableUpdate?.version})</strong> disponible para ti.
          </p>
          <p className="text-foreground-muted">
            ¿Deseas descargar e instalar esta actualización ahora? La aplicación se reiniciará una vez completado el proceso.
          </p>
          {availableUpdate?.body && (
            <div className="mt-4 p-3 bg-muted rounded-md text-xs border border-border overflow-y-auto max-h-32">
              <strong className="block mb-1 text-foreground">Notas de la versión:</strong>
              <div className="whitespace-pre-wrap">{availableUpdate.body}</div>
            </div>
          )}
        </div>
      </ConfirmationModal>
    </>
  );
};

export default Sidebar;
