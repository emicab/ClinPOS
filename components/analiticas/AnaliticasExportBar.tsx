"use client";

import React, { useState } from "react";
import { toast } from "react-hot-toast";
import { FileText, Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import { getPaymentTypeDisplay } from "@/lib/displayTexts";
import { generateSalesPdf, type PdfSaleRowInput } from "@/lib/pdfSalesReport";
import { saveFile } from "@/lib/saveFile";

type Preset = "TODO" | "HOY" | "DIAS7" | "DIAS30" | "CUSTOM";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "TODO", label: "Todo" },
  { value: "HOY", label: "Hoy" },
  { value: "DIAS7", label: "7 días" },
  { value: "DIAS30", label: "30 días" },
  { value: "CUSTOM", label: "Personalizado" },
];

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

function formatLabelDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export default function AnaliticasExportBar() {
  const [preset, setPreset] = useState<Preset>("TODO");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);

  const getRange = (): { from?: string; to?: string; label: string } => {
    const now = new Date();
    switch (preset) {
      case "HOY":
        return {
          from: toDateInputValue(now),
          to: toDateInputValue(now),
          label: "Hoy",
        };
      case "DIAS7":
        return {
          from: toDateInputValue(addDays(now, -6)),
          to: toDateInputValue(now),
          label: "Últimos 7 días",
        };
      case "DIAS30":
        return {
          from: toDateInputValue(addDays(now, -29)),
          to: toDateInputValue(now),
          label: "Últimos 30 días",
        };
      case "CUSTOM":
        if (!from || !to) return { label: "Personalizado" };
        return {
          from,
          to,
          label: `${formatLabelDate(from)} – ${formatLabelDate(to)}`,
        };
      case "TODO":
      default:
        return { label: "Todo" };
    }
  };

  const handleExport = async () => {
    const range = getRange();
    if (preset === "CUSTOM" && (!from || !to)) {
      toast.error("Seleccioná las fechas desde/hasta para el rango personalizado.");
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams({ sort: "asc", status: "COMPLETED" });
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);

      const [ventasRes, configRes] = await Promise.all([
        fetch(`/api/ventas?${params.toString()}`),
        fetch("/api/config"),
      ]);

      if (!ventasRes.ok) {
        const err = await ventasRes.json().catch(() => ({}));
        throw new Error(err.message || `Error HTTP: ${ventasRes.status}`);
      }

      const salesRaw = await ventasRes.json();
      const config = configRes.ok ? await configRes.json() : {};

      const rows: PdfSaleRowInput[] = (salesRaw as any[]).map((sale: any) => ({
        id: sale.id,
        saleDate: sale.saleDate,
        clientName: sale.client
          ? `${sale.client.firstName} ${sale.client.lastName || ""}`.trim()
          : "N/A",
        sellerName: sale.seller?.name || "N/A",
        paymentTypeDisplay: getPaymentTypeDisplay(sale.paymentType),
        itemCount: sale.items?.length ?? 0,
        totalAmount: parseFloat(String(sale.totalAmount)),
      }));

      if (rows.length === 0) {
        toast("No hay ventas en el período seleccionado.", { icon: "ℹ️" });
        return;
      }

      const pdfBytes = await generateSalesPdf({
        sales: rows,
        rangeLabel: range.label,
        businessName: config.businessName || "",
      });

      const fromPart = (range.from || "todo").replace(/-/g, "");
      const toPart = (range.to || "hoy").replace(/-/g, "");
      const filename = `Reporte_Ventas_${fromPart}_al_${toPart}.pdf`;

      const result = await saveFile(pdfBytes, filename, "application/pdf");
      if (result.success) {
        toast.success(`Reporte generado: ${filename}`);
      } else if (!result.canceled) {
        toast.error(result.error || "No se pudo guardar el reporte.");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Error al generar el reporte.";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-muted p-4 sm:p-5 rounded-xl shadow mb-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setPreset(p.value)}
            className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors ${
              preset === p.value
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground-muted hover:text-foreground border border-border"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preset === "CUSTOM" && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="reporte-desde" className="text-foreground-muted">
            Desde
          </label>
          <input
            id="reporte-desde"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <label htmlFor="reporte-hasta" className="text-foreground-muted">
            Hasta
          </label>
          <input
            id="reporte-hasta"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-foreground-muted">
          Exportá las ventas del período seleccionado a un PDF profesional.
        </p>
        <Button onClick={handleExport} disabled={loading}>
          {loading ? (
            <Loader2 size={16} className="mr-2 animate-spin" />
          ) : (
            <FileText size={16} className="mr-2" />
          )}
          {loading ? "Generando..." : "Exportar PDF"}
        </Button>
      </div>
    </div>
  );
}
