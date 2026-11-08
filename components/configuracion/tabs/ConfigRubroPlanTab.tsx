"use client";

import React, { useState } from "react";
import {
  CheckCircle2,
  ShieldCheck,
  Key,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import toast from "react-hot-toast";

import { useModules } from "@/hooks/useModules";

interface ConfigRubroPlanTabProps {
  form: Record<string, string>;
  handleChange: (key: string, value: string) => void;
  handleSave: () => void;
  isSaving: boolean;
}

export default function ConfigRubroPlanTab({
  form,
  handleChange,
  handleSave,
  isSaving,
}: ConfigRubroPlanTabProps) {
  const { refresh: refreshModules, cloudSyncEnabled } = useModules();
  const [licenseKeyInput, setLicenseKeyInput] = useState("");
  const [activatingLicense, setActivatingLicense] = useState(false);
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [connectingSucursal, setConnectingSucursal] = useState(false);

  const handleConnectSucursal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pairingCodeInput.trim()) {
      toast.error("Ingresá el código de emparejamiento.");
      return;
    }

    setConnectingSucursal(true);
    try {
      const res = await fetch("/api/pairing/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCodeInput.trim() }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || "El código no es válido.");
      }

      setPairingCodeInput("");
      toast.success(data.message || "¡Sucursal conectada!");

      if (cloudSyncEnabled) {
        toast.loading("Descargando datos desde la nube...", { id: "pairing-sync-toast" });
        try {
          const syncRes = await fetch("/api/sync?force=true");
          if (syncRes.ok) {
            toast.success("¡Datos descargados! El local está listo.", { id: "pairing-sync-toast" });
          } else {
            toast.error("Los datos se descargarán automáticamente. Revisá Configuración → Sucursales.", { id: "pairing-sync-toast" });
          }
        } catch {
          toast.error("No se pudo sincronizar automáticamente.", { id: "pairing-sync-toast" });
        }
      }

      await refreshModules();
    } catch (err: any) {
      toast.error(err.message || "No se pudo conectar la sucursal.");
    } finally {
      setConnectingSucursal(false);
    }
  };

  const handleActivateLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseKeyInput.trim()) {
      toast.error("Por favor ingresá una clave de licencia.");
      return;
    }

    setActivatingLicense(true);
    try {
      const res = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey: licenseKeyInput.trim() }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message || "¡Licencia activada con éxito!");
        const activePlan = data.plan || data.plan_type || "pro";
        handleChange("license_key", licenseKeyInput.trim());
        handleChange("plan_type", activePlan);
        handleChange("app_plan", activePlan);
        handleChange(
          "unlocked_plan_pro",
          activePlan === "pro" ? "true" : "false",
        );
        handleChange("storage_mode", activePlan === "pro" ? "seguro" : "local");
        setLicenseKeyInput("");
        await handleSave();

        if (cloudSyncEnabled) {
          toast.loading("Descargando sucursales y productos desde la nube...", { id: "sync-toast" });
          try {
            const syncRes = await fetch("/api/sync?force=true");
            if (syncRes.ok) {
              toast.success("¡Datos descargados con éxito! El local está listo.", { id: "sync-toast" });
            } else {
              toast.error("Hubo un problema al sincronizar los datos. Intentá desde Configuración -> Sucursales.", { id: "sync-toast" });
            }
          } catch (e) {
            toast.error("No se pudo conectar para sincronizar automáticamente.", { id: "sync-toast" });
          }
        }

        await refreshModules();
      } else {
        toast.error(data.message || "La clave de licencia no es válida.");
      }
    } catch {
      toast.error("Error al conectar con el servidor de licencias.");
    } finally {
      setActivatingLicense(false);
    }
  };

  // const currentProfileKey = form.business_profile || 'general';
  const currentPlan =
    form.plan_type ||
    form.app_plan ||
    (form.unlocked_plan_pro === "true" ? "pro" : "basico");

  return (
    <div className="space-y-8">
      {/* SECCIÓN 2: Plan de Suscripción */}
      <section className="bg-muted p-6 rounded-xl shadow space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <ShieldCheck size={20} className="text-primary" /> Plan de
            Suscripción ClinPOS
          </h2>
          <p className="text-xs text-foreground-muted mt-1">
            Compará y seleccioná la modalidad de servicio adecuada para tu
            negocio.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
          {/* Tarjeta Plan Básico */}
          <div
            className={`p-6 rounded-2xl border flex flex-col justify-between space-y-6 ${
              currentPlan === "basico"
                ? "border-primary bg-background shadow-md ring-1 ring-primary"
                : "border-border bg-background/60"
            }`}
          >
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs font-extrabold uppercase tracking-wider text-foreground-muted bg-muted px-2.5 py-1 rounded-lg">
                  Plan Básico
                </span>
                {currentPlan === "basico" && (
                  <span className="text-xs font-bold text-primary flex items-center gap-1">
                    <CheckCircle2 size={14} /> Plan Actual
                  </span>
                )}
              </div>
              <h3 className="text-xl font-bold text-foreground">
                Básico & Facturación ARCA
              </h3>
              <p className="text-xs text-foreground-muted">
                Ideal para comercios que buscan control total de caja, productos
                e inventario local y facturación AFIP sin ataduras.
              </p>

              <div className="pt-2">
                <span className="text-2xl font-black text-foreground">
                  $9.900
                </span>
                <span className="text-xs text-foreground-muted">
                  {" "}
                  ARS / mes
                </span>
                <p className="text-[11px] text-primary font-semibold mt-0.5">
                  O opción de Pago Único de $40.000 ARS
                </p>
              </div>

              <ul className="text-xs space-y-2 text-foreground-muted pt-3 border-t border-border/60">
                <li className="flex items-center gap-2 text-foreground font-medium">
                  ✓ Ventas y Caja Diaria
                </li>
                <li className="flex items-center gap-2 text-foreground font-medium">
                  ✓ Productos, Stock y Alertas
                </li>
                <li className="flex items-center gap-2 text-foreground font-medium">
                  ✓ Facturación Electrónica ARCA (AFIP)
                </li>
                <li className="flex items-center gap-2 text-foreground font-medium">
                  ✓ Gastos y Proveedores
                </li>
                <li className="flex items-center gap-2 text-foreground font-medium">
                  ✓ Venta Fraccionada y Combos
                </li>
              </ul>
            </div>

            <div className="pt-4">
              <a
                href="https://mpago.la/1V3hSPq"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-muted hover:bg-muted/80 text-foreground font-bold text-xs rounded-xl border border-border transition"
              >
                Suscribirme al Plan Básico <ExternalLink size={14} />
              </a>
            </div>
          </div>

          {/* Tarjeta Plan Pro ⭐ */}
          <div
            className={`p-6 rounded-2xl border flex flex-col justify-between space-y-6 relative overflow-hidden ${
              currentPlan === "pro"
                ? "border-amber-500 bg-background shadow-lg ring-2 ring-amber-500/30"
                : "border-amber-400/60 bg-amber-500/5"
            }`}
          >
            <div className="absolute top-0 right-0 bg-amber-500 text-slate-950 text-[10px] font-black uppercase px-3 py-1 rounded-bl-xl tracking-widest shadow-xs">
              Recomendado ⭐
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs font-black uppercase tracking-wider text-amber-600 bg-amber-100 dark:bg-amber-950 dark:text-amber-300 px-2.5 py-1 rounded-lg">
                  Plan Pro
                </span>
                {currentPlan === "pro" && (
                  <span className="text-xs font-bold text-amber-600 flex items-center gap-1">
                    <CheckCircle2 size={14} /> Plan Activo
                  </span>
                )}
              </div>
              <h3 className="text-xl font-bold text-foreground">
                Pro & Módulos Avanzados
              </h3>
              <p className="text-xs text-foreground-muted">
                Para negocios que necesitan cobro a crédito/fiado, analíticas
                financieras profundas y herramientas avanzadas de gestión.
              </p>

              <div className="pt-2">
                <span className="text-2xl font-black text-foreground">
                  $30.000
                </span>
                <span className="text-xs text-foreground-muted">
                  {" "}
                  ARS / mes
                </span>
                <p className="text-[11px] text-amber-600 font-bold mt-0.5">
                  Acceso completo a todos los módulos Pro
                </p>
              </div>

              <ul className="text-xs space-y-2 text-foreground-muted pt-3 border-t border-border/60">
                <li className="flex items-center gap-2 text-foreground font-semibold">
                  ✓ Todo lo del Plan Básico
                </li>
                <li className="flex items-center gap-2 font-bold text-amber-600">
                  ⭐ Cuenta Corriente / Fiado
                </li>
                <li className="flex items-center gap-2 font-bold text-amber-600">
                  ⭐ Copia de Seguridad Automática Local
                </li>
                <li className="flex items-center gap-2 font-bold text-amber-600">
                  ⭐ Analíticas Avanzadas
                </li>
                <li className="flex items-center gap-2 font-bold text-amber-600">
                  ⭐ Roles y Permisos por PIN
                </li>
              </ul>
            </div>

            <div className="pt-4">
              <a
                href="https://mpago.la/1BG9zyU"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl shadow-md transition"
              >
                Obtener Plan Pro <ArrowRight size={14} />
              </a>
            </div>
          </div>
        </div>

        {/* Formulario de Activación de Licencia */}
        <div className="mt-6 p-5 bg-background border border-border rounded-xl space-y-3">
          <div className="flex items-center gap-2">
            <Key size={18} className="text-primary" />
            <h3 className="text-sm font-bold text-foreground">
              Activar Clave de Licencia
            </h3>
          </div>
          <p className="text-xs text-foreground-muted">
            Si ya contrataste o compraste tu licencia, ingresá tu clave a
            continuación para activar tu plan correspondiente.
          </p>

          <form
            onSubmit={handleActivateLicense}
            className="flex flex-col sm:flex-row gap-3 pt-2"
          >
            <div className="flex-1">
              <Input
                placeholder="Ej: CRM-PRO-ABCD-1234-EF56"
                value={licenseKeyInput}
                onChange={(e) => setLicenseKeyInput(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              disabled={activatingLicense}
              className="shrink-0 font-bold"
            >
              {activatingLicense ? "Verificando..." : "Activar Licencia"}
            </Button>
          </form>
        </div>

        {/* Conectar Sucursal con Código de Emparejamiento (requiere nube) */}
        {cloudSyncEnabled && (
        <div className="p-5 bg-background border border-emerald-500/40 rounded-xl space-y-3">
          <div className="flex items-center gap-2">
            <Key size={18} className="text-emerald-600" />
            <h3 className="text-sm font-bold text-foreground">
              Conectar sucursal con código
            </h3>
          </div>
          <p className="text-xs text-foreground-muted">
            Si sos un local nuevo y la Casa Central te dio un código de
            emparejamiento (ej. PKG-AB12CD34), ingresalo acá para conectarte a
            tu negocio sin necesidad de la clave de licencia.
          </p>

          <form
            onSubmit={handleConnectSucursal}
            className="flex flex-col sm:flex-row gap-3 pt-2"
          >
            <div className="flex-1">
              <Input
                placeholder="Ej: PKG-AB12CD34"
                value={pairingCodeInput}
                onChange={(e) => setPairingCodeInput(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={connectingSucursal}
              className="shrink-0 font-bold"
            >
              {connectingSucursal ? "Conectando..." : "Conectar Sucursal"}
            </Button>
          </form>
        </div>
        )}
      </section>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Guardando..." : "Guardar Cambios de Rubro"}
        </Button>
      </div>
    </div>
  );
}
