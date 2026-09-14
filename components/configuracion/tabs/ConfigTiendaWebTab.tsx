"use client";

import React, { useState, useEffect } from "react";
import Button from "@/components/ui/Button";
import {
  Loader2,
  Globe,
  ShoppingBag,
  ExternalLink,
  CheckCircle2,
  ShieldCheck,
  RefreshCw,
  AlertTriangle,
  Clock,
  MapPin,
  Plus,
  Trash2,
  Search,
} from "lucide-react";
import toast from "react-hot-toast";
import { StorePublicInfoSection } from "../tienda-web/StorePublicInfoSection";
import { MercadoPagoConnectSection } from "../tienda-web/MercadoPagoConnectSection";
import { StockDeliveryRulesSection } from "../tienda-web/StockDeliveryRulesSection";
import { DeliveryAppsConfigSection } from "../tienda-web/DeliveryAppsConfigSection";

type DaySchedule = {
  day: number; // 0 = Lunes ... 6 = Domingo
  enabled: boolean;
  open: string;
  close: string;
  breaks: { start: string; end: string }[];
};

type DeliveryZone = {
  name: string;
  fromKm: number;
  toKm: number;
  fee: number;
  minAmount: number;
};

const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

const defaultSchedules = (): DaySchedule[] =>
  DAY_NAMES.map((_, day) => ({
    day,
    enabled: true,
    open: "09:00",
    close: "18:00",
    breaks: [],
  }));

export default function ConfigTiendaWebTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isMainDevice, setIsMainDevice] = useState(true);
  const [platformDomain, setPlatformDomain] = useState("");
  const [showMpChangeModal, setShowMpChangeModal] = useState(false);
  const [formData, setFormData] = useState({
    slug: "",
    businessName: "",
    description: "",
    logoUrl: "",
    bannerUrl: "",
    primaryColor: "#2563eb",
    isWebActive: false,
    mpAccessToken: "",
    mpPublicKey: "",
    mpFeePercent: 0,
    whatsappPhone: "",
    minStockBuffer: 1,
    allowPickup: true,
    allowDelivery: true,
    requireMpForDelivery: true,
    deliveryFee: 0,
    minDeliveryAmount: 0,
    businessSector: "GASTRONOMIA",
  });
  const [schedules, setSchedules] = useState<DaySchedule[]>(defaultSchedules);
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [storeAddress, setStoreAddress] = useState("");
  const [storeLat, setStoreLat] = useState("");
  const [storeLng, setStoreLng] = useState("");
  const [geocodingStore, setGeocodingStore] = useState(false);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/store-config");
      if (res.ok) {
        const data = await res.json();
        setPlatformDomain(data.customDomain || "");
        setFormData({
          slug: data.slug || "",
          businessName: data.businessName || "",
          description: data.description || "",
          logoUrl: data.logoUrl || "",
          bannerUrl: data.bannerUrl || "",
          primaryColor: data.primaryColor || "#2563eb",
          isWebActive: Boolean(data.isWebActive),
          mpAccessToken: data.mpAccessToken || "",
          mpPublicKey: data.mpPublicKey || "",
          mpFeePercent: parseFloat(data.mpFeePercent) || 0,
          whatsappPhone: data.whatsappPhone || "",
          minStockBuffer:
            data.minStockBuffer !== undefined &&
            data.minStockBuffer !== null &&
            data.minStockBuffer !== ""
              ? Number(data.minStockBuffer)
              : 1,
          allowPickup:
            data.allowPickup !== undefined ? Boolean(data.allowPickup) : true,
          allowDelivery:
            data.allowDelivery !== undefined
              ? Boolean(data.allowDelivery)
              : true,
          requireMpForDelivery:
            data.requireMpForDelivery !== undefined
              ? Boolean(data.requireMpForDelivery)
              : true,
          deliveryFee: parseFloat(data.deliveryFee) || 0,
          minDeliveryAmount: parseFloat(data.minDeliveryAmount) || 0,
          businessSector: data.businessSector || "GASTRONOMIA",
        });
        try {
          const parsedSchedules: DaySchedule[] = data.openingHours
            ? JSON.parse(data.openingHours)
            : [];
          setSchedules(
            parsedSchedules.length === 7 ? parsedSchedules : defaultSchedules(),
          );
        } catch {
          setSchedules(defaultSchedules());
        }
        try {
          const parsedZones: DeliveryZone[] = data.deliveryZones
            ? JSON.parse(data.deliveryZones)
            : [];
          setZones(Array.isArray(parsedZones) ? parsedZones : []);
        } catch {
          setZones([]);
        }
        setStoreLat(
          data.lat !== undefined && data.lat !== null ? String(data.lat) : "",
        );
        setStoreLng(
          data.lng !== undefined && data.lng !== null ? String(data.lng) : "",
        );
      }
    } catch (err) {
      console.error(err);
      toast.error("Error al cargar la configuración de la tienda web.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setIsMainDevice(data.is_main_device !== "false");
      })
      .catch(() => {});
  }, []);

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => {
    const { name, value, type } = e.target;
    if (type === "checkbox") {
      const checked = (e.target as HTMLInputElement).checked;
      setFormData((prev) => ({ ...prev, [name]: checked }));
    } else {
      setFormData((prev) => ({ ...prev, [name]: value }));
    }
  };

  const updateSchedule = (day: number, patch: Partial<DaySchedule>) => {
    setSchedules((prev) =>
      prev.map((s) => (s.day === day ? { ...s, ...patch } : s)),
    );
  };

  const updateBreak = (
    day: number,
    index: number,
    field: "start" | "end",
    value: string,
  ) => {
    setSchedules((prev) =>
      prev.map((s) =>
        s.day === day
          ? {
              ...s,
              breaks: s.breaks.map((b, i) =>
                i === index ? { ...b, [field]: value } : b,
              ),
            }
          : s,
      ),
    );
  };

  const addBreak = (day: number) => {
    setSchedules((prev) =>
      prev.map((s) =>
        s.day === day
          ? { ...s, breaks: [...s.breaks, { start: "13:00", end: "14:00" }] }
          : s,
      ),
    );
  };

  const removeBreak = (day: number, index: number) => {
    setSchedules((prev) =>
      prev.map((s) =>
        s.day === day
          ? { ...s, breaks: s.breaks.filter((_, i) => i !== index) }
          : s,
      ),
    );
  };

  const updateZone = (index: number, patch: Partial<DeliveryZone>) => {
    setZones((prev) => prev.map((z, i) => (i === index ? { ...z, ...patch } : z)));
  };

  const addZone = () => {
    setZones((prev) => {
      const last = prev[prev.length - 1];
      return [
        ...prev,
        {
          name: `Zona ${prev.length + 1}`,
          fromKm: last ? last.toKm : 0,
          toKm: last ? last.toKm + 2 : 2,
          fee: 0,
          minAmount: 0,
        },
      ];
    });
  };

  const removeZone = (index: number) => {
    setZones((prev) => prev.filter((_, i) => i !== index));
  };

  const geocodeStoreAddress = async () => {
    if (!storeAddress.trim()) {
      toast.error("Ingresá la dirección del local.");
      return;
    }
    setGeocodingStore(true);
    try {
      const res = await fetch(
        `/api/geocode?q=${encodeURIComponent(storeAddress.trim())}`,
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "No se pudo geolocalizar la dirección.");
      }
      const data = await res.json();
      if (!data.lat || !data.lng) {
        throw new Error("No se encontró la dirección. Revisá el texto.");
      }
      setStoreLat(String(data.lat));
      setStoreLng(String(data.lng));
      toast.success(`Ubicación guardada: ${data.display_name || "ok"}`);
    } catch (err: any) {
      toast.error(err.message || "Error al geolocalizar.");
    } finally {
      setGeocodingStore(false);
    }
  };

  const buildSaveBody = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      ...formData,
      lat: storeLat ? Number(storeLat) : null,
      lng: storeLng ? Number(storeLng) : null,
      deliveryZones: zones.length ? zones : null,
      openingHours: schedules.length === 7 ? schedules : null,
      ...overrides,
    });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.slug.trim()) {
      toast.error("Ingresá un subdominio/slug válido para la tienda.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/store-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: buildSaveBody(),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          errData.message || "Error al guardar la configuración.",
        );
      }

      toast.success("¡Configuración de ClinStore guardada con éxito!");
      fetchConfig();
    } catch (err: any) {
      toast.error(err.message || "Ocurrió un error al guardar.");
    } finally {
      setSaving(false);
    }
  };

  const disconnectMp = async () => {
    if (!formData.slug.trim()) {
      toast.error("Guardá primero el subdominio de la tienda.");
      return;
    }
    if (!formData.mpAccessToken) {
      toast.error("No hay una cuenta de Mercado Pago conectada.");
      return;
    }
    if (
      !window.confirm(
        "¿Desconectar la cuenta de Mercado Pago? Los cobros online quedarán desactivados.",
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/store-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: buildSaveBody({ mpAccessToken: "", mpPublicKey: "" }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          errData.message || "Error al desconectar Mercado Pago.",
        );
      }
      toast.success("Mercado Pago desconectado.");
      fetchConfig();
    } catch (err: any) {
      toast.error(err.message || "Ocurrió un error al desconectar.");
    } finally {
      setSaving(false);
    }
  };

  const storeBase = (platformDomain || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase() || "clinstore.vercel.app";
  const storeUrl = formData.slug
    ? `https://${storeBase}/${formData.slug.toLowerCase()}`
    : "";

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <Loader2 size={32} className="animate-spin text-primary" />
        <span className="ml-3 text-foreground-muted">
          Cargando datos de ClinStore...
        </span>
      </div>
    );
  }

  if (!isMainDevice) {
    return (
      <div className="bg-muted p-6 rounded-2xl border border-border space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-primary shrink-0" size={22} />
          <h3 className="text-lg font-bold text-foreground">
            Tienda Web administrada por la Casa Central
          </h3>
        </div>
        <p className="text-sm text-foreground-muted">
          Esta computadora opera como sucursal. La configuración de ClinStore
          (subdominio, datos públicos, Mercado Pago) solo se administra desde
          la Casa Central.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      {/* Header Info */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-6 rounded-2xl shadow-lg flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShoppingBag size={28} />
            <h2 className="text-2xl font-bold">Módulo ClinStore E-Commerce</h2>
          </div>
          <p className="text-blue-100 text-sm max-w-xl">
            Publicá tu catálogo de productos, precios y stock en tiempo real en
            tu tienda online propia conectada a ClinPOS.
          </p>
        </div>
        <div className="flex items-center gap-3 bg-white/10 backdrop-blur-md p-3 rounded-xl border border-white/20">
          <span className="text-xs font-semibold">Estado de la tienda:</span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              name="isWebActive"
              checked={formData.isWebActive}
              onChange={handleChange}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-white/30 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
          </label>
          <span
            className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${formData.isWebActive ? "bg-emerald-500 text-white" : "bg-white/20 text-white"}`}
          >
            {formData.isWebActive ? "Activa" : "Inactiva"}
          </span>
        </div>
      </div>

      {/* URL de la tienda */}
      {formData.slug && (
        <div className="bg-muted p-4 rounded-xl border border-border flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 truncate">
            <Globe className="text-primary shrink-0" size={20} />
            <span className="text-sm font-semibold text-foreground truncate">
              Tu enlace público:
            </span>
            <a
              href={storeUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-blue-600 hover:underline font-mono truncate flex items-center gap-1"
            >
              {storeUrl} <ExternalLink size={14} />
            </a>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.clipboard.writeText(storeUrl);
              toast.success("Enlace copiado al portapapeles");
            }}
          >
            Copiar Enlace
          </Button>
        </div>
      )}

      <StorePublicInfoSection formData={formData} onChange={handleChange} />

      <MercadoPagoConnectSection
        formData={formData}
        onChange={handleChange}
        saving={saving}
        storeBase={storeBase}
        onOpenChangeModal={() => setShowMpChangeModal(true)}
        onDisconnectMp={disconnectMp}
      />

      <StockDeliveryRulesSection formData={formData} onChange={handleChange} />

      {/* Horarios de Atención */}
      <div className="bg-muted p-6 rounded-xl border border-border space-y-4">
        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Clock size={18} className="text-violet-600" /> Horarios de Atención
        </h3>
        <p className="text-xs text-foreground-muted">
          Si la tienda está cerrada, el cliente no podrá pagar: se le mostrará
          la próxima apertura y podrá agendar su pedido para esa fecha/hora.
        </p>
        <div className="space-y-2">
          {schedules.map((s) => (
            <div
              key={s.day}
              className="p-3 rounded-xl border border-border bg-background space-y-2"
            >
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm font-semibold text-foreground w-32 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) =>
                      updateSchedule(s.day, { enabled: e.target.checked })
                    }
                    className="rounded border-border"
                  />
                  {DAY_NAMES[s.day]}
                </label>
                {s.enabled ? (
                  <>
                    <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
                      Apertura
                      <input
                        type="time"
                        value={s.open}
                        onChange={(e) =>
                          updateSchedule(s.day, { open: e.target.value })
                        }
                        className="px-2 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
                      Cierre
                      <input
                        type="time"
                        value={s.close}
                        onChange={(e) =>
                          updateSchedule(s.day, { close: e.target.value })
                        }
                        className="px-2 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => addBreak(s.day)}
                      className="ml-auto text-xs font-semibold text-violet-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Plus size={14} /> Receso
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-foreground-muted italic">
                    Cerrado
                  </span>
                )}
              </div>
              {s.enabled &&
                s.breaks.map((b, bi) => (
                  <div
                    key={bi}
                    className="flex flex-wrap items-center gap-2 pl-10"
                  >
                    <span className="text-[11px] text-foreground-muted uppercase tracking-wider">
                      Receso {bi + 1}
                    </span>
                    <input
                      type="time"
                      value={b.start}
                      onChange={(e) =>
                        updateBreak(s.day, bi, "start", e.target.value)
                      }
                      className="px-2 py-1 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <span className="text-xs text-foreground-muted">a</span>
                    <input
                      type="time"
                      value={b.end}
                      onChange={(e) =>
                        updateBreak(s.day, bi, "end", e.target.value)
                      }
                      className="px-2 py-1 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <button
                      type="button"
                      onClick={() => removeBreak(s.day, bi)}
                      className="text-rose-500 hover:text-rose-600 cursor-pointer"
                      aria-label="Quitar receso"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Ubicación y Zonas de Envío */}
      <div className="bg-muted p-6 rounded-xl border border-border space-y-4">
        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
          <MapPin size={18} className="text-rose-600" /> Ubicación y Zonas de
          Envío
        </h3>

        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-foreground-muted mb-1">
              Dirección del local (para calcular zonas de envío)
            </label>
            <input
              type="text"
              value={storeAddress}
              onChange={(e) => setStoreAddress(e.target.value)}
              placeholder="ej. Av. Corrientes 1200, CABA"
              className="w-full p-2.5 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={geocodeStoreAddress}
            disabled={geocodingStore}
          >
            {geocodingStore ? (
              <Loader2 size={14} className="animate-spin mr-2" />
            ) : (
              <Search size={14} className="mr-2" />
            )}
            {geocodingStore ? "Buscando..." : "Geolocalizar"}
          </Button>
        </div>

        {(storeLat || storeLng) && (
          <p className="text-xs text-foreground-muted">
            📍 Coordenadas del local:{" "}
            <span className="font-mono">{storeLat}, {storeLng}</span>
          </p>
        )}

        <div className="border-t border-border pt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-foreground">
              Zonas de envío (por radio)
            </p>
            <Button type="button" variant="outline" size="sm" onClick={addZone}>
              <Plus size={14} className="mr-1.5" /> Agregar Zona
            </Button>
          </div>
          <p className="text-xs text-foreground-muted mb-3">
            El cliente escribe su dirección y el sistema calcula a qué anillo
            pertenece. Fuera del último anillo no se realiza envío (solo retiro).
          </p>
          {zones.length === 0 ? (
            <p className="text-xs text-foreground-muted italic">
              Sin zonas configuradas: se usará el costo de envío único.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="hidden md:grid grid-cols-[1fr_70px_70px_90px_90px_36px] gap-2 text-[11px] uppercase tracking-wider text-foreground-muted font-semibold px-1">
                <span>Nombre</span>
                <span>Desde km</span>
                <span>Hasta km</span>
                <span>Envío $</span>
                <span>Mínimo $</span>
                <span></span>
              </div>
              {zones.map((z, i) => (
                <div
                  key={i}
                  className="grid grid-cols-2 md:grid-cols-[1fr_70px_70px_90px_90px_36px] gap-2 items-center"
                >
                  <input
                    type="text"
                    value={z.name}
                    onChange={(e) => updateZone(i, { name: e.target.value })}
                    placeholder="ej. Centro"
                    className="px-2.5 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={String(z.fromKm)}
                    onChange={(e) =>
                      updateZone(i, { fromKm: Number(e.target.value) || 0 })
                    }
                    className="px-2.5 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={String(z.toKm)}
                    onChange={(e) =>
                      updateZone(i, { toKm: Number(e.target.value) || 0 })
                    }
                    className="px-2.5 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={String(z.fee)}
                    onChange={(e) =>
                      updateZone(i, { fee: Number(e.target.value) || 0 })
                    }
                    className="px-2.5 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={String(z.minAmount)}
                    onChange={(e) =>
                      updateZone(i, { minAmount: Number(e.target.value) || 0 })
                    }
                    className="px-2.5 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <button
                    type="button"
                    onClick={() => removeZone(i)}
                    className="text-rose-500 hover:text-rose-600 cursor-pointer justify-self-center"
                    aria-label="Quitar zona"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Integraciones de Delivery (PedidosYa & Rappi) */}
      <DeliveryAppsConfigSection />

      {/* Botón Guardar */}
      <div className="flex justify-end gap-3 pt-4 border-t border-border">
        <Button
          type="button"
          variant="outline"
          onClick={fetchConfig}
          disabled={saving}
        >
          <RefreshCw size={16} className="mr-2" /> Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? (
            <Loader2 className="animate-spin mr-2" size={16} />
          ) : (
            <CheckCircle2 size={16} className="mr-2" />
          )}
          {saving ? "Guardando..." : "Guardar Cambios"}
        </Button>
      </div>

      {/* Modal de confirmación para cambiar cuenta MP */}
      {showMpChangeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-muted border border-border rounded-2xl p-6 max-w-md mx-4 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-500 shrink-0">
                <AlertTriangle size={24} />
              </div>
              <h3 className="text-lg font-bold text-foreground">
                Cambiar Cuenta de Mercado Pago
              </h3>
            </div>
            <p className="text-sm text-foreground-muted leading-relaxed">
              Para vincular una cuenta diferente, se abrirá una ventana donde
              primero se cerrará tu sesión actual en Mercado Pago y luego
              podrás iniciar sesión con la nueva cuenta.
            </p>
            <div className="flex items-center gap-3 justify-end pt-2">
              <button
                type="button"
                onClick={() => setShowMpChangeModal(false)}
                className="px-4 py-2 text-sm font-medium text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMpChangeModal(false);
                  const url = `https://${storeBase}/api/mercadopago/connect?tenant_id=${encodeURIComponent(formData.slug || "mi-tienda")}&change_account=true`;
                  import("@tauri-apps/plugin-shell")
                    .then(({ open }) => open(url))
                    .catch(() => window.open(url, "_blank"));
                }}
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition-colors inline-flex items-center gap-1.5 cursor-pointer"
              >
                Continuar
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
