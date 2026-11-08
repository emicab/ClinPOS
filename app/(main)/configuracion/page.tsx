"use client";

import React, { useState, useEffect } from "react";
import {
  Building,
  LayoutDashboard,
  Users,
  Database,
  ShieldCheck,
  CreditCard,
} from "lucide-react";
import toast from "react-hot-toast";

import { useModules } from "@/hooks/useModules";

import ConfigGeneralTab from "@/components/configuracion/tabs/ConfigGeneralTab";
import ConfigRubroPlanTab from "@/components/configuracion/tabs/ConfigRubroPlanTab";
import ConfigUsuariosTab from "@/components/configuracion/tabs/ConfigUsuariosTab";
import ConfigBackupTab from "@/components/configuracion/tabs/ConfigBackupTab";
import ConfigArcaTab from "@/components/configuracion/tabs/ConfigArcaTab";
import ConfigPromocionesTarjetasTab from "@/components/configuracion/tabs/ConfigPromocionesTarjetasTab";
import ConfigTiendaWebTab from "@/components/configuracion/tabs/ConfigTiendaWebTab";
import ConfigSucursalesTab from "@/components/configuracion/tabs/ConfigSucursalesTab";
import ConfigPaymentModal from "@/components/configuracion/modals/ConfigPaymentModal";
import { ShoppingBag, Store, Lock } from "lucide-react";


export default function ConfiguracionPage() {
  const { refresh: refreshModules, plan, currentUser, cloudSyncEnabled } = useModules();
  // El ADMIN accede a todas las pestañas sin restricción de plan.
  const isAdmin = currentUser?.role === "ADMIN";
  const [form, setForm] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"general" | "sucursales" | "tienda_web" | "promociones_tarjetas" | "usuarios" | "backup" | "arca" | "suscripciones">(
    "general",
  );
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingTab, setPendingTab] = useState<string | null>(null);

  const isPlanPro = isAdmin || plan === "pro";

  // Modal de Pago
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentItem, setPaymentItem] = useState<{
    key: string;
    name: string;
    price: number;
    callback?: () => void;
  } | null>(null);

  const fetchConfig = () => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setForm(data))
      .catch(() => toast.error("Error al cargar configuración."))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    fetchConfig();
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get("tab");
      if (tabParam) setPendingTab(tabParam);
    }
  }, []);

  useEffect(() => {
    if (!pendingTab) return;
    const validTabs = ["general", "sucursales", "tienda_web", "promociones_tarjetas", "usuarios", "backup", "arca", "suscripciones"];
    if (!validTabs.includes(pendingTab)) return;
    if (pendingTab === "tienda_web" && !cloudSyncEnabled) {
      setActiveTab("general");
      return;
    }
    const proTabs = ["sucursales", "tienda_web"];
    if (proTabs.includes(pendingTab) && !isPlanPro) {
      setActiveTab("general");
    } else {
      setActiveTab(pendingTab as any);
    }
  }, [pendingTab, isPlanPro, cloudSyncEnabled]);

  const handleTabClick = (tab: "general" | "sucursales" | "tienda_web" | "promociones_tarjetas" | "usuarios" | "backup" | "arca" | "suscripciones") => {
    if (tab === "tienda_web" && !cloudSyncEnabled) {
      toast.error("La tienda web está desactivada en modo local.");
      return;
    }
    if ((tab === "sucursales" || tab === "tienda_web") && !isPlanPro) {
      toast.error("Esta sección requiere el plan Pro.");
      return;
    }
    setActiveTab(tab);
  };

  const handleChange = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleFileUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
    field: "arcaCert" | "arcaKey"
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        handleChange(field, content);
        toast.success(
          field === "arcaCert"
            ? "Certificado cargado correctamente."
            : "Clave privada cargada correctamente."
        );
      }
    };
    reader.readAsText(file);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) throw new Error();
      toast.success("Configuración guardada correctamente.");
      await refreshModules();
    } catch {
      toast.error("Error al guardar la configuración.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success("Copia de seguridad completada con éxito.");
        setForm((prev) => ({ ...prev, supabase_last_sync: data.lastSync }));
      } else {
        toast.error(data.message || "Error al sincronizar.");
      }
    } catch {
      toast.error("Error de conexión al sincronizar.");
    } finally {
      setIsSyncing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Configuración
        </h1>
        <p className="text-sm text-foreground-muted">
          Gestioná los datos de tu comercio, usuarios y claves, rubro de negocio, facturación y copias de seguridad.
        </p>
      </div>

      {/* Tabs Bar */}
      <div className="border-b border-border flex gap-2 overflow-x-auto pb-px">
        <button
          onClick={() => setActiveTab("general")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors shrink-0 cursor-pointer ${
            activeTab === "general"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground hover:border-border"
          }`}
        >
          <Building size={16} /> Datos del Comercio
        </button>

        <button
          onClick={() => handleTabClick("sucursales")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors shrink-0 cursor-pointer ${
            activeTab === "sucursales"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground hover:border-border"
          }`}
        >
          <Store size={16} /> Locales y Sucursales {!isPlanPro && <Lock size={13} className="text-foreground-muted" />}
        </button>

        {cloudSyncEnabled && (
        <button
          onClick={() => handleTabClick("tienda_web")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors shrink-0 cursor-pointer ${
            activeTab === "tienda_web"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground hover:border-border"
          }`}
        >
          <ShoppingBag size={16} /> Tienda ClinStore (Web) {!isPlanPro && <Lock size={13} className="text-foreground-muted" />}
        </button>
        )}

        <button
          onClick={() => setActiveTab("promociones_tarjetas")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors shrink-0 cursor-pointer ${
            activeTab === "promociones_tarjetas"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground hover:border-border"
          }`}
        >
          <CreditCard size={16} /> Promociones Tarjetas
        </button>

        <button
          onClick={() => setActiveTab("usuarios")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors shrink-0 cursor-pointer ${
            activeTab === "usuarios"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground hover:border-border"
          }`}
        >
          <Users size={16} /> Usuarios y Permisos
        </button>

        <button
          onClick={() => setActiveTab("backup")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors shrink-0 cursor-pointer ${
            activeTab === "backup"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground hover:border-border"
          }`}
        >
          <Database size={16} /> Copias de Seguridad
        </button>

        <button
          onClick={() => setActiveTab("arca")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors shrink-0 cursor-pointer ${
            activeTab === "arca"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground hover:border-border"
          }`}
        >
          <ShieldCheck size={16} /> Facturación ARCA (AFIP)
        </button>

        <button
          onClick={() => setActiveTab("suscripciones")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors shrink-0 cursor-pointer ${
            activeTab === "suscripciones"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground hover:border-border"
          }`}
        >
          <LayoutDashboard size={16} /> Suscripciones
        </button>
      </div>

      {/* Content Area */}
      {activeTab === "general" && (
        <ConfigGeneralTab
          form={form}
          handleChange={handleChange}
          handleSave={handleSave}
          isSaving={isSaving}
        />
      )}

      {activeTab === "sucursales" && (
        <ConfigSucursalesTab />
      )}

      {activeTab === "tienda_web" && (
        <ConfigTiendaWebTab />
      )}

      {activeTab === "promociones_tarjetas" && (
        <ConfigPromocionesTarjetasTab />
      )}

      {activeTab === "usuarios" && (
        <ConfigUsuariosTab />
      )}

      {activeTab === "backup" && (
        <ConfigBackupTab
          form={form}
          handleChange={handleChange}
          handleManualSync={handleManualSync}
          isSyncing={isSyncing}
          isPlanPro={isPlanPro}
          cloudSyncEnabled={cloudSyncEnabled}
        />
      )}

      {activeTab === "arca" && (
        <ConfigArcaTab
          form={form}
          handleChange={handleChange}
          handleFileUpload={handleFileUpload}
          handleSave={handleSave}
          isSaving={isSaving}
          onRefreshConfig={fetchConfig}
        />
      )}

      {activeTab === "suscripciones" && (
        <ConfigRubroPlanTab
          form={form}
          handleChange={handleChange}
          handleSave={handleSave}
          isSaving={isSaving}
        />
      )}

      {/* Modal de Simulación de Pago */}
      <ConfigPaymentModal
        isOpen={showPaymentModal}
        onClose={() => {
          setShowPaymentModal(false);
          setPaymentItem(null);
        }}
        paymentItem={paymentItem}
        onSuccessPayload={(payload) => {
          setForm((prev) => ({ ...prev, ...payload }));
        }}
      />
    </div>
  );
}
