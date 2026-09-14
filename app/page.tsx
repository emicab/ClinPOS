"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useModules } from "@/hooks/useModules";
import { formatCurrency } from "@/lib/formatCurrency";
import {
  ArrowUpRightSquare,
  History,
  LayoutDashboard,
  Package,
  Shapes,
  Tag,
  ShoppingCart,
  TrendingDown,
  Truck,
  Users,
  UserPlus,
  Wallet,
  AlertTriangle,
  Barcode,
  ShoppingBag,
  Percent,
  FileText,
  Settings,
  RefreshCcw,
  Ticket,
  Bookmark,
  ArrowRightLeft,
} from "lucide-react";

const priorityModules = [
  {
    name: "Caja",
    href: "/caja",
    icon: Wallet,
    description: "Abrir/Cerrar caja y ver movimientos del día.",
    shortcut: "Ctrl+J",
  },
  {
    name: "Nueva Venta",
    href: "/ventas/nueva",
    icon: ShoppingCart,
    description: "Registra una nueva transacción de venta.",
    shortcut: "Ctrl+N",
  },
  {
    name: "Productos",
    href: "/productos",
    icon: Package,
    description: "Gestiona tu catálogo de productos.",
    shortcut: "Ctrl+P",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Gastos",
    href: "/gastos",
    icon: TrendingDown,
    description: "Registra y controla tus gastos.",
    shortcut: "Ctrl+G",
    moduleId: "gastos",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Pedidos Web",
    href: "/pedidos-web",
    icon: ShoppingBag,
    description: "Gestiona y prepara pedidos de ClinStore.",
    shortcut: "Ctrl+W",
    moduleId: "pedidos_web",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Configuración",
    href: "/configuracion",
    icon: Settings,
    description: "Configura tu tienda web y tu sistema.",
    shortcut: "Ctrl+,",
    allowedRoles: ["ADMIN"],
  },
];

const secondaryModules = [
  {
    name: "Nueva Compra",
    href: "/compras/nueva",
    icon: ArrowUpRightSquare,
    description: "Ingresa mercadería y actualiza tu stock.",
    moduleId: "compras",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Analíticas",
    href: "/analiticas",
    icon: LayoutDashboard,
    description: "Visualiza tus métricas y gráficos clave.",
    moduleId: "analiticas",
    allowedRoles: ["ADMIN"],
  },
  {
    name: "Clientes",
    href: "/clientes",
    icon: Users,
    moduleId: "clientes",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Cuenta Corriente",
    href: "/cuenta-corriente",
    icon: Users,
    moduleId: "cuenta_corriente",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Proveedores",
    href: "/proveedores",
    icon: Truck,
    moduleId: "compras",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Vendedores",
    href: "/vendedores",
    icon: UserPlus,
    moduleId: "vendedores",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Categorías",
    href: "/categorias",
    icon: Shapes,
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Marcas",
    href: "/marcas",
    icon: Tag,
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Carga de Stock",
    href: "/stock",
    icon: Barcode,
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Alertas de Stock",
    href: "/stock/alertas",
    icon: AlertTriangle,
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Combos",
    href: "/combos",
    icon: ShoppingBag,
    moduleId: "combos_promociones",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Promociones",
    href: "/promociones",
    icon: Percent,
    moduleId: "combos_promociones",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  { name: "Historial Ventas", href: "/ventas", icon: FileText },
  {
    name: "Historial Compras",
    href: "/compras",
    icon: History,
    moduleId: "compras",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Pedidos Web",
    href: "/pedidos-web",
    icon: ShoppingBag,
    moduleId: "pedidos_web",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Consignaciones",
    href: "/consignaciones",
    icon: RefreshCcw,
    moduleId: "consignaciones",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Códigos de Descuento",
    href: "/codigos-descuento",
    icon: Ticket,
    moduleId: "combos_promociones",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    name: "Notas IA",
    href: "/notas-ia",
    icon: Bookmark,
    moduleId: "analiticas",
    allowedRoles: ["ADMIN"],
  },
  {
    name: "Configuración",
    href: "/configuracion",
    icon: Settings,
    allowedRoles: ["ADMIN"],
  },
  {
    name: "Usuarios y Permisos",
    href: "/configuracion/usuarios",
    icon: Users,
    allowedRoles: ["ADMIN"],
  },
];

const shortcuts = [
  { keys: ["Ctrl", "N"], label: "Nueva Venta" },
  { keys: ["Ctrl", "J"], label: "Caja" },
  {
    keys: ["Ctrl", "P"],
    label: "Productos",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    keys: ["Ctrl", "G"],
    label: "Gastos",
    moduleId: "gastos",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    keys: ["Ctrl", "E"],
    label: "Nueva Compra",
    moduleId: "compras",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  {
    keys: ["Ctrl", "A"],
    label: "Analíticas",
    moduleId: "analiticas",
    allowedRoles: ["ADMIN"],
  },
  { keys: ["F9"], label: "Ir a Caja" },
  {
    keys: ["Ctrl", "W"],
    label: "Pedidos Web",
    moduleId: "pedidos_web",
    allowedRoles: ["ADMIN", "SUPERVISOR"],
  },
  { keys: ["Ctrl", ",", ""], label: "Configuración", allowedRoles: ["ADMIN"] },
];

const NavCard = ({ module }: { module: (typeof priorityModules)[0] }) => (
  <Link
    href={module.href}
    className="group relative block rounded-2xl border border-border bg-white p-6 shadow-sm transition-all duration-200 ease-in-out hover:border-primary hover:shadow-lg hover:-translate-y-1 overflow-hidden"
  >
    <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-bl-full -z-0" />
    <div className="flex items-center space-x-4 relative z-10">
      <div className="rounded-xl bg-linear-to-br from-primary/20 to-primary/10 p-3.5 text-primary shadow-sm">
        <module.icon className="h-7 w-7" />
      </div>
      <div className="flex-1">
        <h3 className="text-lg font-semibold text-foreground group-hover:text-primary transition-colors">
          {module.name}
        </h3>
        <p className="mt-0.5 text-sm text-foreground-muted">
          {module.description}
        </p>
      </div>
      {module.shortcut && (
        <div className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md bg-muted border border-border text-[11px] font-mono text-foreground-muted shrink-0">
          {module.shortcut.split("+").map((k, i) => (
            <span key={i}>
              {i > 0 && (
                <span className="text-foreground-muted/40 mx-0.5">+</span>
              )}
              <kbd className="px-1 py-0.5 rounded bg-background border border-border">
                {k}
              </kbd>
            </span>
          ))}
        </div>
      )}
    </div>
  </Link>
);

const SecondaryNavCard = ({
  module,
}: {
  module: (typeof secondaryModules)[0];
}) => (
  <Link
    href={module.href}
    className="group flex flex-col items-center justify-center rounded-xl border border-border bg-white p-4 text-center shadow-sm transition-all duration-200 ease-in-out hover:border-primary hover:shadow-md hover:-translate-y-0.5"
  >
    <module.icon className="h-7 w-7 text-foreground-muted transition-colors group-hover:text-primary" />
    <p className="mt-2 text-xs font-semibold text-foreground">{module.name}</p>
  </Link>
);

interface TodayKpis {
  salesToday: { count: number; total: number } | null;
  ticketAvg: number | null;
  lowStock: number | null;
  cashOpen: { expected: number } | null;
}

export default function HomePage() {
  const { isModuleEnabled, currentUser } = useModules();
  // El ADMIN ve todos los accesos sin filtros de módulos ni roles.
  const isAdmin = currentUser?.role === "ADMIN";
  const [kpis, setKpis] = useState<TodayKpis | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/today")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setKpis(data);
      })
      .catch(() => {});
  }, []);

  const filteredPriorityModules = priorityModules.filter((mod) => {
    if (isAdmin) return true;
    if (mod.moduleId && !isModuleEnabled(mod.moduleId)) return false;
    if (isModuleEnabled("roles") && currentUser && mod.allowedRoles) {
      return mod.allowedRoles.includes(currentUser.role);
    }
    return true;
  });

  const filteredSecondaryModules = secondaryModules.filter((mod) => {
    if (isAdmin) return true;
    if (mod.moduleId && !isModuleEnabled(mod.moduleId)) return false;
    if (isModuleEnabled("roles") && currentUser && mod.allowedRoles) {
      return mod.allowedRoles.includes(currentUser.role);
    }
    return true;
  });

  const filteredShortcuts = shortcuts.filter((s) => {
    if (isAdmin) return true;
    if (s.moduleId && !isModuleEnabled(s.moduleId)) return false;
    if (isModuleEnabled("roles") && currentUser && s.allowedRoles) {
      return s.allowedRoles.includes(currentUser.role);
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-dream-100/30 to-background bg-fixed">
      <div className="w-full max-w-6xl mx-auto p-4 md:p-8">
        <header className="text-center pt-10 pb-6 md:pt-16 md:pb-10">
          <h1 className="text-4xl font-bold tracking-tight text-foreground uppercase sm:text-5xl">
            Bienvenido a <strong className="text-primary">ClinPOS</strong>
          </h1>
          <p className="mt-3 text-lg text-foreground-muted max-w-2xl mx-auto">
            Selecciona un módulo para empezar a gestionar tu negocio.
          </p>
        </header>

        <main className="space-y-10 pb-10">
          {kpis && (
            <section aria-label="Resumen del día">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Link
                  href="/ventas"
                  className="rounded-2xl border border-border bg-white p-4 shadow-sm hover:shadow-md hover:border-primary/50 transition-all"
                >
                  <p className="text-[11px] uppercase font-bold text-foreground-muted tracking-wider">
                    Ventas hoy
                  </p>
                  <p className="text-xl font-extrabold text-foreground mt-1">
                    {kpis.salesToday ? formatCurrency(kpis.salesToday.total) : "—"}
                  </p>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    {kpis.salesToday ? `${kpis.salesToday.count} ventas` : "sin datos"}
                    {kpis.ticketAvg !== null && kpis.salesToday && kpis.salesToday.count > 0
                      ? ` · ticket ${formatCurrency(kpis.ticketAvg)}`
                      : ""}
                  </p>
                </Link>
                <Link
                  href="/caja"
                  className="rounded-2xl border border-border bg-white p-4 shadow-sm hover:shadow-md hover:border-primary/50 transition-all"
                >
                  <p className="text-[11px] uppercase font-bold text-foreground-muted tracking-wider">
                    Caja abierta
                  </p>
                  <p className="text-xl font-extrabold text-foreground mt-1">
                    {kpis.cashOpen ? formatCurrency(kpis.cashOpen.expected) : "Cerrada"}
                  </p>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    {kpis.cashOpen ? "esperado en caja" : "sin caja abierta"}
                  </p>
                </Link>
                <Link
                  href="/stock/alertas"
                  className="rounded-2xl border border-border bg-white p-4 shadow-sm hover:shadow-md hover:border-primary/50 transition-all"
                >
                  <p className="text-[11px] uppercase font-bold text-foreground-muted tracking-wider">
                    Bajo stock
                  </p>
                  <p className={`text-xl font-extrabold mt-1 ${kpis.lowStock !== null && kpis.lowStock > 0 ? "text-destructive" : "text-foreground"}`}>
                    {kpis.lowStock !== null ? kpis.lowStock : "—"}
                  </p>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    productos para reponer
                  </p>
                </Link>
                <Link
                  href="/pedidos-web"
                  className="rounded-2xl border border-border bg-white p-4 shadow-sm hover:shadow-md hover:border-primary/50 transition-all"
                >
                  <p className="text-[11px] uppercase font-bold text-foreground-muted tracking-wider">
                    Pedidos web
                  </p>
                  <p className="text-xl font-extrabold text-foreground mt-1">
                    Ver
                  </p>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    preparar y despachar
                  </p>
                </Link>
              </div>
            </section>
          )}
          <section id="quick-access">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-semibold text-foreground px-1">
                <span className="inline-block w-1.5 h-5 bg-primary rounded-full align-middle mr-2" />
                Acceso Rápido
              </h2>
              <span className="text-xs text-foreground-muted bg-muted px-3 py-1 rounded-full border border-border">
                Tus módulos más usados
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {filteredPriorityModules.map((mod) => (
                <NavCard key={mod.name} module={mod} />
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-semibold text-foreground px-1">
                <span className="inline-block w-1.5 h-5 bg-primary rounded-full align-middle mr-2" />
                Atajos de Teclado
              </h2>
              <span className="text-xs text-foreground-muted bg-muted px-3 py-1 rounded-full border border-border">
                Presiona F1 para ayuda
              </span>
            </div>
            <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 gap-x-6">
                {filteredShortcuts.map((s) => (
                  <div key={s.label} className="flex items-center gap-2">
                    <div className="flex items-center gap-0.5">
                      {s.keys
                        .filter((k) => k)
                        .map((k, i) => (
                          <span key={i}>
                            {i > 0 && (
                              <span className="text-foreground-muted/40 mx-0.5 text-xs">
                                +
                              </span>
                            )}
                            <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border font-mono text-[11px] text-foreground-muted">
                              {k}
                            </kbd>
                          </span>
                        ))}
                    </div>
                    <span className="text-sm text-foreground-muted">
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-5 px-1">
              <span className="inline-block w-1.5 h-5 bg-primary rounded-full align-middle mr-2" />
              Todos los Módulos
            </h2>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {filteredSecondaryModules.map((mod) => (
                <SecondaryNavCard key={mod.name} module={mod} />
              ))}
            </div>
          </section>
        </main>

        {(!isModuleEnabled("roles") ||
          !currentUser ||
          ["ADMIN", "SUPERVISOR"].includes(currentUser.role)) && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("open-business-picker"))}
            className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary-dark hover:shadow-xl transition-all cursor-pointer text-sm font-bold"
            title="Cambiar o crear negocio"
          >
            <ArrowRightLeft size={18} />
            Cambiar negocio
          </button>
        )}
      </div>
    </div>
  );
}
