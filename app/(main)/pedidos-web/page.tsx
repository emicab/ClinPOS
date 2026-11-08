"use client";

import React from "react";
import ManualOrderModal from "@/components/web-orders/ManualOrderModal";
import { useWebOrdersController } from "@/hooks/useWebOrdersController";
import { WebOrdersHeader } from "@/components/pedidos-web/WebOrdersHeader";
import { WebOrdersFilterBar } from "@/components/pedidos-web/WebOrdersFilterBar";
import { ComandaGrid } from "@/components/pedidos-web/ComandaGrid";
import { OrdersTable } from "@/components/pedidos-web/OrdersTable";
import { OrderDetailModal } from "@/components/pedidos-web/OrderDetailModal";
import { useModules } from "@/hooks/useModules";

export default function PedidosWebPage() {
  const {
    orders,
    branches,
    loading,
    error,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    paymentStatusFilter,
    setPaymentStatusFilter,
    selectedOrder,
    setSelectedOrder,
    selectedIds,
    setSelectedIds,
    isManualModalOpen,
    setIsManualModalOpen,
    autoRefresh,
    setAutoRefresh,
    isPulling,
    requireMpForDelivery,
    storeSlug,
    platformDomain,
    viewMode,
    toggleViewMode,
    fetchOrders,
    handleStatusChange,
    handleBranchChange,
    filteredOrders,
  } = useWebOrdersController();

  const { cloudSyncEnabled } = useModules();
  if (!cloudSyncEnabled) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 py-24 text-center">
        <h1 className="text-xl font-bold text-foreground">
          Pedidos web no disponible
        </h1>
        <p className="max-w-md text-sm text-foreground-muted">
          La tienda web y los pedidos web están desactivados porque ClinPOS está
          funcionando en modo local. Las ventas, el stock y los datos se guardan
          en esta computadora.
        </p>
      </div>
    );
  }

  const activeOrdersCount = orders.filter(
    (o) => o.status !== "DELIVERED" && o.status !== "CANCELLED",
  ).length;

  const handleSelectAll = () => {
    if (filteredOrders.length > 0 && selectedIds.size === filteredOrders.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredOrders.map((o) => o.id)));
    }
  };

  const handleToggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <WebOrdersHeader
        totalOrders={orders.length}
        activeOrdersCount={activeOrdersCount}
        viewMode={viewMode}
        autoRefresh={autoRefresh}
        isPulling={isPulling}
        onToggleViewMode={toggleViewMode}
        onToggleAutoRefresh={() => setAutoRefresh((prev) => !prev)}
        onPullOrders={() => fetchOrders(true)}
        onOpenManualModal={() => setIsManualModalOpen(true)}
      />

      <WebOrdersFilterBar
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        paymentStatusFilter={paymentStatusFilter}
        onPaymentStatusFilterChange={setPaymentStatusFilter}
        totalFiltered={filteredOrders.length}
      />

      {error && (
        <div className="p-3 bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-2xl text-xs font-semibold border border-rose-500/20">
          {error}
        </div>
      )}

      {viewMode === "comanda" ? (
        <ComandaGrid
          orders={filteredOrders}
          onOpenDetail={(order) => setSelectedOrder(order)}
          onStatusChange={handleStatusChange}
          requireMpForDelivery={requireMpForDelivery}
        />
      ) : (
        <OrdersTable
          orders={filteredOrders}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onSelectAll={handleSelectAll}
          onOpenDetail={(order) => setSelectedOrder(order)}
          onStatusChange={handleStatusChange}
          requireMpForDelivery={requireMpForDelivery}
        />
      )}

      <OrderDetailModal
        order={selectedOrder}
        branches={branches}
        storeSlug={storeSlug}
        platformDomain={platformDomain}
        requireMpForDelivery={requireMpForDelivery}
        onClose={() => setSelectedOrder(null)}
        onStatusChange={handleStatusChange}
        onBranchChange={handleBranchChange}
      />

      {isManualModalOpen && (
        <ManualOrderModal
          isOpen={isManualModalOpen}
          onClose={() => setIsManualModalOpen(false)}
          onCreated={() => fetchOrders()}
        />
      )}
    </div>
  );
}
