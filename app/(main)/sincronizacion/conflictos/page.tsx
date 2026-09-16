"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Cloud, Computer, RefreshCw } from "lucide-react";
import Link from "next/link";

type Conflict = {
  id: number;
  entity: string;
  entityKey: string;
  localVersion: string | null;
  remoteVersion: string | null;
  localPayload: string | null;
  remotePayload: string | null;
  createdAt: string;
};

function readPayload(value: string | null): Record<string, any> {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function formatDate(value: string | null) {
  if (!value) return "Fecha no disponible";
  return new Date(value).toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short" });
}

function describeConflict(conflict: Conflict) {
  const remote = readPayload(conflict.remotePayload);
  if (conflict.entity === "Product") {
    return remote.name ? `El producto “${remote.name}” cambió en más de un lugar.` : "Un producto cambió en más de un lugar.";
  }
  if (conflict.entity === "ProductBranchStock") return "El stock de un producto cambió en más de un lugar.";
  return "Un dato cambió en más de un lugar antes de sincronizarse.";
}

export default function SyncConflictsPage() {
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [resolving, setResolving] = useState<number | null>(null);

  const loadConflicts = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/sync/conflicts");
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "No se pudieron cargar los cambios.");
      setConflicts(data.conflicts || []);
    } catch (err: any) {
      setError(err.message || "No se pudieron cargar los cambios.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConflicts();
  }, []);

  const resolveConflict = async (id: number, resolution: "LOCAL" | "CLOUD" | "LATER") => {
    setResolving(id);
    try {
      const response = await fetch("/api/sync/conflicts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, resolution }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "No se pudo resolver el cambio.");
      if (resolution !== "LATER") setConflicts((current) => current.filter((item) => item.id !== id));
    } catch (err: any) {
      setError(err.message || "No se pudo resolver el cambio.");
    } finally {
      setResolving(null);
    }
  };

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href="/" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-foreground-muted hover:text-foreground">
            <ArrowLeft size={15} /> Volver
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <AlertTriangle className="text-amber-500" size={26} /> Cambios para revisar
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
            Estos datos cambiaron en más de un lugar antes de sincronizarse. No modificamos nada automáticamente para evitar perder información.
          </p>
        </div>
        <button onClick={loadConflicts} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-muted" disabled={loading}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Actualizar
        </button>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">{error}</div>}

      {!loading && !error && conflicts.length === 0 && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center text-emerald-800">
          <p className="text-lg font-bold">Todo está sincronizado</p>
          <p className="mt-1 text-sm">No hay cambios pendientes de revisión.</p>
        </div>
      )}

      <div className="space-y-4">
        {conflicts.map((conflict) => {
          const local = readPayload(conflict.localPayload);
          const remote = readPayload(conflict.remotePayload);
          return (
            <article key={conflict.id} className="rounded-2xl border border-border bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-bold text-foreground">{describeConflict(conflict)}</p>
                  <p className="mt-1 text-xs text-foreground-muted">Detectado el {formatDate(conflict.createdAt)}</p>
                </div>
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800">Para revisar</span>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-bold text-blue-900"><Computer size={17} /> En esta computadora</div>
                  <p className="text-sm text-blue-950">Último cambio: {formatDate(conflict.localVersion)}</p>
                  {local.name && <p className="mt-2 text-sm text-blue-950">Nombre: <strong>{local.name}</strong></p>}
                </div>
                <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-bold text-violet-900"><Cloud size={17} /> En la nube</div>
                  <p className="text-sm text-violet-950">Último cambio: {formatDate(conflict.remoteVersion)}</p>
                  {remote.name && <p className="mt-2 text-sm text-violet-950">Nombre: <strong>{remote.name}</strong></p>}
                </div>
              </div>

              <div className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs text-foreground-muted">
                Elegí qué versión querés conservar. Si no estás seguro, podés dejarlo para después.
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button onClick={() => resolveConflict(conflict.id, "LOCAL")} disabled={resolving === conflict.id} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50">
                  Conservar esta computadora
                </button>
                <button onClick={() => resolveConflict(conflict.id, "CLOUD")} disabled={resolving === conflict.id} className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white hover:bg-violet-700 disabled:opacity-50">
                  Usar la versión de la nube
                </button>
                <button onClick={() => resolveConflict(conflict.id, "LATER")} disabled={resolving === conflict.id} className="rounded-lg border border-border px-3 py-2 text-xs font-bold text-foreground-muted hover:bg-muted disabled:opacity-50">
                  Revisar después
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}
