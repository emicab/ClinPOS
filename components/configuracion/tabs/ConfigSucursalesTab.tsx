"use client";

import React, { useState, useEffect } from "react";
import {
  Loader2,
  Store,
  Plus,
  MapPin,
  Phone,
  Edit3,
  Trash2,
  Key,
  Copy,
  CheckCircle2,
  Laptop,
  Check,
} from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import toast from "react-hot-toast";
import type { Branch } from "@/types";

export default function ConfigSucursalesTab() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);

  // Campos para crear / editar
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [isMain, setIsMain] = useState(false);

  // Sucursal activa en ESTA PC
  const [activeBranchId, setActiveBranchId] = useState<number | null>(null);

  // Identidad server-side de ESTA PC (quién administra)
  const [isMainDevice, setIsMainDevice] = useState(true);

  // Clave de activación / tenant_id
  const [activationKey, setActivationKey] = useState<string>("");
  const [copiedKey, setCopiedKey] = useState(false);

  // Código de emparejamiento
  const [pairingBranchId, setPairingBranchId] = useState<number | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [pairingGenerating, setPairingGenerating] = useState(false);

  const fetchConfigAndBranches = async () => {
    setLoading(true);
    try {
      const [bRes, cRes] = await Promise.all([
        fetch("/api/branches"),
        fetch("/api/config"),
      ]);

      let cData: any = {};
      if (cRes.ok) {
        cData = await cRes.json();
        setActivationKey(
          cData.license_key ||
            cData.tenant_id ||
            cData.slug ||
            "Sin Clave Activada",
        );
      }

      // Identidad server-side de esta PC
      const serverDeviceId = cData.device_branch_id
        ? Number(cData.device_branch_id)
        : null;
      const isThisMainDevice = cData.is_main_device !== "false";
      setIsMainDevice(isThisMainDevice);

      if (bRes.ok) {
        const bData = await bRes.json();
        setBranches(bData);

        // Sucursal activa de esta PC: server-side > localStorage > default
        let chosen: number | null = null;
        if (
          serverDeviceId &&
          bData.some((b: Branch) => b.id === serverDeviceId)
        ) {
          chosen = serverDeviceId;
        } else {
          const storedActive = localStorage.getItem("clinpos_active_branch_id");
          if (
            storedActive &&
            bData.some((b: Branch) => b.id === Number(storedActive))
          ) {
            chosen = Number(storedActive);
          }
        }
        if (chosen === null && bData.length > 0) {
          const defaultBranch = bData.find((b: Branch) => b.isMain) || bData[0];
          chosen = defaultBranch.id;
        }

        // La Casa Central sin local asignado se auto-asigna la Sucursal Principal
        if (serverDeviceId === null && isThisMainDevice && chosen !== null) {
          try {
            await fetch("/api/branches/device", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ branchId: chosen }),
            });
          } catch {
            // Si falla la persistencia, queda la selección local
          }
        }
        setActiveBranchId(chosen);
        if (chosen) {
          localStorage.setItem("clinpos_active_branch_id", String(chosen));
        }
      }
    } catch {
      toast.error("Error al cargar sucursales y clave de activación.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfigAndBranches();
  }, []);

  const handleSelectActiveBranch = async (branchId: number) => {
    const selected = branches.find((b) => b.id === branchId);
    const prev = activeBranchId;
    setActiveBranchId(branchId);
    if (selected) setIsMainDevice(selected.isMain === true);
    try {
      const resDev = await fetch("/api/branches/device", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId }),
      });
      if (!resDev.ok) {
        const data = await resDev.json().catch(() => ({}));
        throw new Error(data.message || "No se pudo guardar el local en el servidor.");
      }
    } catch (err: any) {
      setActiveBranchId(prev);
      if (prev) {
        localStorage.setItem("clinpos_active_branch_id", String(prev));
      } else {
        localStorage.removeItem("clinpos_active_branch_id");
      }
      toast.error(
        err?.message || "No se pudo guardar el local en esta PC. Revisá tu conexión y el plan Pro.",
      );
      return;
    }
    localStorage.setItem("clinpos_active_branch_id", String(branchId));
    toast.success(`Esta PC ahora opera como "${selected?.name || "Sucursal"}"`);
  };

  const handleStartEdit = (b: Branch) => {
    setEditingBranch(b);
    setName(b.name);
    setAddress(b.address || "");
    setPhone(b.phone || "");
    setIsMain(b.isMain || false);
  };

  const handleCancelEdit = () => {
    setEditingBranch(null);
    setName("");
    setAddress("");
    setPhone("");
    setIsMain(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("El nombre de la sucursal es obligatorio.");
      return;
    }

    setCreating(true);
    try {
      const isEdit = Boolean(editingBranch);
      const url = "/api/branches";
      const method = isEdit ? "PUT" : "POST";
      const body = isEdit
        ? { id: editingBranch?.id, name, address, phone, isMain }
        : { name, address, phone, isMain };

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Error al guardar la sucursal.");
      }

      toast.success(isEdit ? "¡Sucursal actualizada!" : "¡Sucursal agregada!");
      handleCancelEdit();
      fetchConfigAndBranches();
    } catch (err: any) {
      toast.error(err.message || "Error al guardar la sucursal.");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (b: Branch) => {
    if (b.isMain) {
      toast.error("No podés eliminar la Sucursal Principal.");
      return;
    }

    if (!confirm(`¿Estás seguro de eliminar la sucursal "${b.name}"?`)) return;

    try {
      const res = await fetch(`/api/branches?id=${b.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Error al eliminar sucursal.");
      }
      toast.success("Sucursal eliminada.");
      fetchConfigAndBranches();
    } catch (err: any) {
      toast.error(err.message || "Error al eliminar.");
    }
  };

  const copyActivationKey = () => {
    if (!activationKey) return;
    navigator.clipboard.writeText(activationKey);
    setCopiedKey(true);
    toast.success("¡Clave de activación copiada al portapapeles!");
    setTimeout(() => setCopiedKey(false), 3000);
  };

  const handleGeneratePairingCode = async () => {
    if (!pairingBranchId) return;
    setPairingGenerating(true);
    try {
      const res = await fetch("/api/pairing/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: pairingBranchId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Error al generar el código.");
      }
      setPairingCode(data.code);
      setPairingExpiresAt(data.expiresAt);
      toast.success("¡Código de emparejamiento generado!");
    } catch (err: any) {
      toast.error(err.message || "No se pudo generar el código.");
    } finally {
      setPairingGenerating(false);
    }
  };

  const copyPairingCode = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode);
    toast.success("¡Código copiado! Compartilo con el local nuevo.");
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <Loader2 size={32} className="animate-spin text-primary" />
        <span className="ml-3 text-foreground-muted">
          Cargando datos de sucursales...
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Encabezado */}
      <div className="bg-gradient-to-r from-cyan-600 to-blue-700 text-white p-6 rounded-2xl shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Store size={26} />
            <h2 className="text-2xl font-bold">Gestión Multi-Sucursal</h2>
          </div>
          <p className="text-cyan-100 text-sm max-w-xl">
            Sincronizá el stock en tiempo real entre tus locales. Podés crear,
            editar y eliminar sucursales, seleccionar cuál es la activa en esta
            computadora y vincular nuevos locales con tu clave de activación.
          </p>
        </div>
        <span className="px-3.5 py-1.5 bg-white/20 backdrop-blur-md rounded-full text-xs font-bold border border-white/30 uppercase tracking-wider">
          {branches.length}{" "}
          {branches.length === 1
            ? "Sucursal Registrada"
            : "Sucursales Registradas"}
        </span>
      </div>

      {/* Tarjeta de Clave de Activación del Plan */}
      <div className="bg-muted p-5 rounded-2xl border border-border space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="text-amber-500 shrink-0" size={20} />
            <h3 className="text-base font-bold text-foreground">
              Clave de Activación del Plan (Licencia de Empresa)
            </h3>
          </div>
          <span className="text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2.5 py-0.5 rounded-full font-bold uppercase">
            Vínculo Multi-Local
          </span>
        </div>
        <p className="text-xs text-foreground-muted">
          Al activar tu otro local en la segunda PC con esta **misma Clave de
          Activación del Plan**, ambas computadoras se conectarán a la misma
          base de datos en tiempo real para compartir productos, ventas y stock.
        </p>
        <div className="flex items-center gap-2 bg-background p-3 rounded-xl border border-border">
          <code className="text-sm font-mono font-bold text-primary flex-1 truncate">
            {activationKey}
          </code>
          <button
            type="button"
            onClick={copyActivationKey}
            className="px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-xs font-bold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            {copiedKey ? <Check size={14} /> : <Copy size={14} />}
            {copiedKey ? "¡Copiada!" : "Copiar Clave"}
          </button>
        </div>
      </div>

      {/* Conectar nueva sucursal (solo Casa Central) */}
      {isMainDevice && (
        <div className="bg-white p-5 rounded-2xl border border-border space-y-3">
          <div className="flex items-center gap-2">
            <Key className="text-emerald-600 shrink-0" size={20} />
            <h3 className="text-base font-bold text-foreground">
              Conectar nueva sucursal (código de emparejamiento)
            </h3>
          </div>
          <p className="text-xs text-foreground-muted">
            Generá un código de un solo uso para que el nuevo local se conecte a
            este negocio sin conocer la clave de licencia. El código expira a
            los 30 minutos.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 pt-1">
            <select
              value={pairingBranchId ?? ""}
              onChange={(e) => {
                setPairingBranchId(e.target.value ? Number(e.target.value) : null);
                setPairingCode(null);
                setPairingExpiresAt(null);
              }}
              className="flex h-10 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Seleccioná la sucursal a conectar...</option>
              {branches
                .filter((b) => !b.isMain)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              variant="primary"
              onClick={handleGeneratePairingCode}
              disabled={pairingGenerating || !pairingBranchId}
              className="shrink-0"
            >
              {pairingGenerating ? (
                <Loader2 size={16} className="animate-spin mr-2" />
              ) : (
                <Key size={16} className="mr-2" />
              )}
              {pairingGenerating ? "Generando..." : "Generar Código"}
            </Button>
          </div>

          {pairingCode && (
            <div className="mt-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
                <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                  Enviale este código al nuevo local para que lo ingrese en
                  Plan de Suscripción → Conectar sucursal:
                </span>
              </div>
              <div className="flex items-center gap-2 bg-background p-3 rounded-lg border border-emerald-500/30">
                <code className="text-lg font-mono font-black tracking-wider text-emerald-600 flex-1">
                  {pairingCode}
                </code>
                <button
                  type="button"
                  onClick={copyPairingCode}
                  className="px-3 py-1.5 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-700 dark:text-emerald-400 text-xs font-bold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Copy size={14} /> Copiar
                </button>
              </div>
              {pairingExpiresAt && (
                <p className="text-[11px] text-foreground-muted">
                  Expira: {new Date(pairingExpiresAt).toLocaleString()}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Seleccionar Sucursal Activa en ESTA PC */}
      <div className="bg-white p-5 rounded-2xl border-2 border-primary/40 shadow-xs space-y-3">
        <div className="flex items-center gap-2">
          <Laptop className="text-primary shrink-0" size={20} />
          <h3 className="text-base font-bold text-foreground">
            Sucursal Activa de esta Computadora / Caja
          </h3>
        </div>
        <p className="text-xs text-foreground-muted">
          Seleccioná a qué local pertenece esta PC. Todas las ventas cobradas y
          el stock operado en esta máquina se registrarán automáticamente bajo
          esta sucursal.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-1">
          {branches.map((b) => {
            const isActive = activeBranchId === b.id;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => handleSelectActiveBranch(b.id)}
                className={`p-3.5 rounded-xl border text-left flex items-center justify-between transition-all cursor-pointer ${
                  isActive
                    ? "border-primary bg-primary/10 text-primary shadow-xs font-bold"
                    : "border-border bg-background hover:bg-muted text-foreground"
                }`}
              >
                <div className="truncate">
                  <span className="text-xs font-bold block truncate">
                    {b.name}
                  </span>
                  {b.isMain && (
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-extrabold uppercase">
                      Casa Central
                    </span>
                  )}
                </div>
                {isActive && (
                  <CheckCircle2
                    size={18}
                    className="text-primary shrink-0 ml-2"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {!isMainDevice && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-600 dark:text-amber-400">
          <p className="font-semibold mb-1">
            Esta PC opera como sucursal. Los locales y la tienda web los
            administra la Casa Central.
          </p>
        </div>
      )}

      {/* Formulario Crear / Editar Sucursal */}
      {isMainDevice && (
      <form
        onSubmit={handleSave}
        className="bg-muted p-6 rounded-xl border border-border space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
            {editingBranch ? (
              <Edit3 size={18} className="text-primary" />
            ) : (
              <Plus size={18} className="text-primary" />
            )}
            {editingBranch
              ? `Editar Sucursal: "${editingBranch.name}"`
              : "Agregar Nueva Sucursal"}
          </h3>
          {editingBranch && (
            <button
              type="button"
              onClick={handleCancelEdit}
              className="text-xs text-foreground-muted hover:text-foreground underline"
            >
              Cancelar Edición
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Input
            label="Nombre del Local / Sucursal *"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ej. Sucursal Shopping"
            required
          />
          <Input
            label="Dirección"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="ej. Av. Corrientes 1234"
          />
          <Input
            label="Teléfono"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="ej. 1198765432"
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={isMain}
              onChange={(e) => setIsMain(e.target.checked)}
              className="rounded text-primary focus:ring-primary accent-primary"
            />
            <span className="font-semibold text-xs sm:text-sm">
              Marcar como Casa Central / Principal
            </span>
          </label>

          <div className="flex gap-2">
            {editingBranch && (
              <Button
                type="button"
                variant="outline"
                onClick={handleCancelEdit}
              >
                Cancelar
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={creating}>
              {creating ? (
                <Loader2 size={16} className="animate-spin mr-2" />
              ) : editingBranch ? (
                <CheckCircle2 size={16} className="mr-2" />
              ) : (
                <Plus size={16} className="mr-2" />
              )}
              {creating
                ? "Guardando..."
                : editingBranch
                  ? "Guardar Cambios"
                  : "Agregar Sucursal"}
            </Button>
          </div>
        </div>
      </form>
      )}

      {/* Lista de Sucursales con Acciones de Edición y Eliminación */}
      <div className="space-y-3">
        <h3 className="text-base font-bold text-foreground flex items-center gap-2">
          <Store size={18} className="text-primary" /> Locales Registrados (
          {branches.length})
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {branches.map((b) => {
            const isThisPcActive = activeBranchId === b.id;
            return (
              <div
                key={b.id}
                className={`p-5 rounded-2xl border transition-all flex flex-col justify-between gap-3 ${
                  isThisPcActive
                    ? "bg-white border-primary shadow-xs"
                    : "bg-white border-border"
                }`}
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-base text-foreground">
                        {b.name}
                      </h4>
                      {b.isMain && (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 text-[10px] font-extrabold uppercase">
                          Casa Central
                        </span>
                      )}
                    </div>
                    {isThisPcActive && (
                      <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30 text-[10px] font-bold">
                        💻 Esta PC
                      </span>
                    )}
                  </div>

                  {b.address && (
                    <p className="text-xs text-foreground-muted flex items-center gap-1.5">
                      <MapPin size={14} className="text-primary shrink-0" />
                      <span>{b.address}</span>
                    </p>
                  )}

                  {b.phone && (
                    <p className="text-xs text-foreground-muted flex items-center gap-1.5">
                      <Phone size={14} className="text-primary shrink-0" />
                      <span>{b.phone}</span>
                    </p>
                  )}
                </div>

                {isMainDevice && (
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(b)}
                      className="px-3 py-1.5 text-xs font-bold text-primary bg-primary/10 hover:bg-primary/20 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <Edit3 size={14} /> Editar
                    </button>

                    {!b.isMain && (
                      <button
                        type="button"
                        onClick={() => handleDelete(b)}
                        className="px-3 py-1.5 text-xs font-bold text-rose-600 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <Trash2 size={14} /> Eliminar
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
