"use client";

import React from "react";
import Input from "@/components/ui/Input";
import { CreditCard, ShieldCheck, Loader2 } from "lucide-react";

interface MercadoPagoConnectSectionProps {
  formData: {
    slug: string;
    mpAccessToken: string;
    mpPublicKey: string;
    mpFeePercent: number;
  };
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  saving: boolean;
  storeBase: string;
  // Estado real de vinculación (GET /api/mercadopago/status). null = cargando:
  // se usa el token del form como fallback para no parpadear.
  mpConnected: boolean | null;
  onOpenChangeModal: () => void;
  onDisconnectMp: () => void;
}

export function MercadoPagoConnectSection({
  formData,
  onChange,
  saving,
  storeBase,
  mpConnected,
  onOpenChangeModal,
  onDisconnectMp,
}: MercadoPagoConnectSectionProps) {
  const isConnected =
    mpConnected ?? Boolean(formData.mpAccessToken?.trim());
  return (
    <div className="bg-muted p-6 rounded-xl border border-border space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
          <CreditCard size={18} className="text-blue-600" /> Cobros Online con
          Mercado Pago
        </h3>
        <span className="text-xs bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full font-semibold">
          Integración Directa
        </span>
      </div>
      <p className="text-xs text-foreground-muted">
        Los pagos ingresarán de forma instantánea a tu propia cuenta de Mercado
        Pago cuando tus clientes compren en ClinStore.
      </p>

      {/* OAuth Button */}
      <div className="p-4 bg-background border border-blue-200 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-600 shrink-0">
            <ShieldCheck size={24} />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground">
              Vinculación Oficial 1-Clic (OAuth 2.0)
            </p>
            <p className="text-xs text-foreground-muted">
              Conectá tu cuenta de Mercado Pago con 1 clic sin copiar claves
              secretas.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              if (isConnected) {
                onOpenChangeModal();
              } else {
                const url = `https://${storeBase}/api/mercadopago/connect?tenant_id=${encodeURIComponent(formData.slug || "mi-tienda")}`;
                import("@tauri-apps/plugin-shell")
                  .then(({ open }) => open(url))
                  .catch(() => window.open(url, "_blank"));
              }
            }}
            className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors inline-flex items-center gap-1.5 cursor-pointer"
          >
            {isConnected
              ? "Cambiar cuenta conectada (OAuth 2.0)"
              : "Conectar Mercado Pago (OAuth 2.0) 🔗"}
          </button>
          {isConnected ? (
            <button
              type="button"
              onClick={onDisconnectMp}
              disabled={saving}
              className="px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              Desconectar Mercado Pago
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
        <Input
          label="Access Token de Producción (Opcional)"
          name="mpAccessToken"
          value={formData.mpAccessToken}
          onChange={onChange}
          placeholder="APP_USR-..."
          type="password"
        />
        <Input
          label="Public Key (Opcional)"
          name="mpPublicKey"
          value={formData.mpPublicKey}
          onChange={onChange}
          placeholder="APP_USR-..."
        />
        <Input
          label="Comisión Estimada Mercado Pago (%)"
          name="mpFeePercent"
          type="number"
          step="0.01"
          value={String(formData.mpFeePercent)}
          onChange={onChange}
          placeholder="ej. 6.49"
        />
      </div>
      <p className="text-xs text-foreground-muted italic">
        💡 La comisión estimada (ej. 6.49% en el acto o 3.99% a 14 días) te
        permite visualizar la deducción retenida por MP al evaluar tus ventas
        netas del día.
      </p>
    </div>
  );
}
