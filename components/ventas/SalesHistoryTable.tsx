"use client";

import React, { useEffect, useState, useCallback } from "react";
import type { Sale } from "@/types";
import Button from "@/components/ui/Button";
import ConfirmationModal from "@/components/ui/ConfirmationModal";
import { Loader2, AlertCircle, Eye, Trash2, Download, FileText, CheckCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import { getPaymentTypeDisplay } from "@/lib/displayTexts";
import { exportToCSV } from "@/lib/csv";
import { formatCurrency } from "@/lib/formatCurrency";
import { formatDate } from "@/lib/formatDate";
import { generateSalesPdf, type PdfSaleRowInput } from "@/lib/pdfSalesReport";
import { saveFile } from "@/lib/saveFile";

const SalesHistoryTable = () => {
  const router = useRouter();
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- Estados para el modal de confirmación ---
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<Sale | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<'COMPLETED' | 'PENDING'>('COMPLETED');

  const fetchSales = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/ventas");
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error HTTP: ${response.status}`);
      }
      const data: any[] = await response.json();
      const typedSales: Sale[] = data.map((sale) => ({
        ...sale,
        totalAmount: parseFloat(String(sale.totalAmount)),
        items: sale.items.map((item: any) => ({
          ...item,
          priceAtSale: parseFloat(String(item.priceAtSale)),
        })),
      }));
      setSales(typedSales);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : "Error al cargar el historial de ventas.";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSales();
  }, [fetchSales]);

  const handleExportCSV = async () => {
    try {
      const headers = [
        { key: 'id', label: 'ID Venta' },
        { key: 'saleDate', label: 'Fecha' },
        { key: 'clientName', label: 'Cliente' },
        { key: 'sellerName', label: 'Vendedor' },
        { key: 'totalAmount', label: 'Monto Total' },
        { key: 'paymentType', label: 'Tipo Pago' },
        { key: 'itemCount', label: 'Nº Ítems' },
        { key: 'discountCode', label: 'Cód. Desc.' },
        { key: 'cajaId', label: 'Caja' },
      ];
      const dataToExport = sales.map(sale => ({
        id: sale.id,
        saleDate: formatDate(sale.saleDate),
        clientName: sale.client ? `${sale.client.firstName} ${sale.client.lastName || ''}`.trim() : 'N/A',
        sellerName: sale.seller?.name || 'N/A',
        totalAmount: formatCurrency(sale.totalAmount),
        paymentType: getPaymentTypeDisplay(sale.paymentType),
        itemCount: sale.items.length,
        discountCode: sale.discountCodeApplied || '-',
        cajaId: sale.cashRegister ? `#${sale.cashRegister.id}` : '-',
      }));
      const result = await exportToCSV('historial_ventas', dataToExport, headers);
      if (result.success) {
        toast.success('Historial exportado a CSV.');
      } else if (!result.canceled) {
        toast.error(`No se pudo exportar el CSV${result.error ? `: ${result.error}` : '.'}`);
      }
    } catch (err: any) {
      toast.error(`No se pudo exportar el CSV: ${err?.message || 'error desconocido'}`);
    }
  };

  const handleExportPdf = async () => {
    const visibleSales = sales.filter((s) => (s.status || 'COMPLETED') === activeTab);
    if (visibleSales.length === 0) {
      toast('No hay ventas para exportar en esta pestaña.', { icon: 'ℹ️' });
      return;
    }

    try {
      const rows: PdfSaleRowInput[] = visibleSales.map((sale) => ({
        id: sale.id,
        saleDate: sale.saleDate,
        clientName: sale.client
          ? `${sale.client.firstName} ${sale.client.lastName || ''}`.trim()
          : 'N/A',
        sellerName: sale.seller?.name || 'N/A',
        paymentTypeDisplay: getPaymentTypeDisplay(sale.paymentType),
        itemCount: sale.items.length,
        totalAmount: sale.totalAmount,
      }));

      const configRes = await fetch('/api/config');
      const config = configRes.ok ? await configRes.json() : {};

      const pdfBytes = await generateSalesPdf({
        sales: rows,
        rangeLabel: activeTab === 'PENDING' ? 'Pedidos Pendientes' : 'Historial de Ventas',
        businessName: config.businessName || '',
      });

      const tabLabel = activeTab === 'PENDING' ? 'Pendientes' : 'Completadas';
      const result = await saveFile(pdfBytes, `Historial_Ventas_${tabLabel}.pdf`, 'application/pdf');
      if (result.success) {
        toast.success('Historial exportado a PDF.');
      } else if (!result.canceled) {
        toast.error(result.error || 'No se pudo exportar el PDF.');
      }
    } catch {
      toast.error('No se pudo exportar el PDF.');
    }
  };

  const handleViewDetails = (saleId: number) => {
    router.push(`/ventas/${saleId}`);
  };

  // Función para abrir el modal de confirmación de eliminación
  const handleOpenDeleteModal = (sale: Sale) => {
    setItemToDelete(sale);
    setIsModalOpen(true);
  };

  // Función que se ejecuta al confirmar la eliminación en el modal
  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;
    setIsDeleting(true);

    try {
      const response = await fetch(`/api/ventas/${itemToDelete.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || "No se pudo eliminar la venta.");
      }

      setSales((prevSales) =>
        prevSales.filter((sale) => sale.id !== itemToDelete.id)
      );
      toast.success(`Venta #${itemToDelete.id} eliminada y stock repuesto.`);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : "Ocurrió un error inesperado.";
      toast.error(errorMessage);
    } finally {
      setIsModalOpen(false);
      setIsDeleting(false);
      setItemToDelete(null);
    }
  };



  const handleCompleteOrder = async (sale: Sale) => {
    try {
      const response = await fetch(`/api/ventas/${sale.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentType: sale.paymentType })
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || "No se pudo completar el pedido.");
      }
      toast.success(`Pedido #${sale.id} completado con éxito.`);
      fetchSales();
    } catch (error: any) {
      toast.error(error.message || "Ocurrió un error al completar el pedido.");
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 size={32} className="animate-spin text-primary" />
        <p className="ml-2 text-foreground-muted">
          Cargando historial de ventas...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center text-destructive p-4 bg-destructive/10 rounded-md">
        <AlertCircle size={20} className="inline-block mr-2" />
        {error}
      </div>
    );
  }

  return (
    <>
      <ConfirmationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={handleConfirmDelete}
        title="Eliminar Venta"
        confirmText="Sí, Eliminar Venta"
        isLoading={isDeleting}
      >
        ¿Estás seguro de que quieres eliminar la venta{" "}
        <strong className="text-foreground">#{itemToDelete?.id}</strong>?
        <br />
        <span className="font-semibold text-destructive">
          Esta acción repondrá el stock de los productos vendidos y no se puede
          deshacer.
        </span>
      </ConfirmationModal>

      <div className="bg-muted p-4 sm:p-6 rounded-lg shadow">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
          <div className="flex gap-4 border-b border-border w-full sm:w-auto">
            <button
              className={`pb-2 px-2 text-sm font-semibold transition-colors ${
                activeTab === 'COMPLETED'
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
              onClick={() => setActiveTab('COMPLETED')}
            >
              Completadas
            </button>
            <button
              className={`pb-2 px-2 text-sm font-semibold transition-colors ${
                activeTab === 'PENDING'
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
              onClick={() => setActiveTab('PENDING')}
            >
              Pedidos Pendientes
            </button>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExportCSV}>
              <Download size={14} className="mr-1.5" /> Exportar CSV
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportPdf}>
              <FileText size={14} className="mr-1.5" /> Exportar PDF
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left">
            <thead className="border-b border-border">
              <tr>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground">
                  ID Venta
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground">
                  Fecha
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground">
                  Cliente
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground">
                  Vendedor
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground">
                  Caja
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground text-right">
                  Monto Total
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground">
                  Tipo Pago
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground text-center">
                  Nº Ítems
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground">
                  Cód. Desc.
                </th>
                <th className="p-3 sm:p-4 text-sm font-semibold text-foreground text-center">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody>
              {!loading && sales.filter((s: any) => (s.status || 'COMPLETED') === activeTab).length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="text-center text-foreground-muted py-8"
                  >
                    No hay ventas registradas todavía.
                  </td>
                </tr>
              ) : (
                sales.filter((s: any) => (s.status || 'COMPLETED') === activeTab).map((sale) => (
                  <tr
                    key={sale.id}
                    className="border-b border-border last:border-b-0 hover:bg-background transition-colors"
                  >
                    <td className="p-3 sm:p-4 text-sm text-foreground font-medium">
                      #{sale.id}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-foreground-muted">
                      {formatDate(sale.saleDate)}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-foreground-muted">
                      {sale.client
                        ? `${sale.client.firstName} ${
                            sale.client.lastName || ""
                          }`.trim()
                        : "N/A"}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-foreground-muted">
                      {sale.seller?.name || "N/A"}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-foreground-muted">
                      {sale.cashRegister ? `#${sale.cashRegister.id}` : '-'}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-foreground font-semibold text-right">
                      {formatCurrency(sale.totalAmount)}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-foreground-muted">
                      {getPaymentTypeDisplay(sale.paymentType)}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-foreground-muted text-center">
                      {sale.items.length}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-foreground-muted">
                      {sale.discountCodeApplied || "-"}
                    </td>
                    <td className="p-3 sm:p-4 text-sm text-center">
                      <div className="flex justify-center items-center space-x-1">
                        {activeTab === 'PENDING' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleCompleteOrder(sale)}
                            title="Completar pedido"
                          >
                            <CheckCircle size={16} className="text-green-500" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleViewDetails(sale.id)}
                          title="Ver detalles"
                        >
                          <Eye size={16} className="text-primary" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleOpenDeleteModal(sale)}
                          title="Eliminar venta"
                        >
                          <Trash2 size={16} className="text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

export default SalesHistoryTable;
