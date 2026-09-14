"use client";

import React from "react";
import type { Product } from "@/types";
import { Loader2, AlertCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useModules } from "@/hooks/useModules";
import ConfirmationModal from "../ui/ConfirmationModal";
import Pagination from "@/components/ui/Pagination";
import { useProductCSV } from "@/hooks/useProductCSV";
import BatchSupplierModal from "./BatchSupplierModal";
import ProductMobileCard from "./ProductMobileCard";
import ProductFilters from "./ProductFilters";
import SelectedBar from "./SelectedBar";
import CSVImportModal from "./CSVImportModal";
import { TransferStockModal, type TransferItem } from "./TransferStockModal";
import { BatchPriceModal } from "./BatchPriceModal";
import ProductModifiersModal from "./ProductModifiersModal";
import { useProductTableState } from "@/hooks/useProductTableState";
import { ProductTableRow } from "./ProductTableRow";

const ProductTable = () => {
  const router = useRouter();
  const { plan } = useModules();
  const isPro = plan === "pro";

  const {
    products,
    loading,
    error,
    isModalOpen,
    setIsModalOpen,
    itemToDelete,
    setItemToDelete,
    isDeleting,
    setIsDeleting,
    isBatchDeleteOpen,
    setIsBatchDeleteOpen,
    isBatchDeleting,
    setIsBatchDeleting,
    isSyncing,
    setIsSyncing,
    selectedIds,
    setSelectedIds,
    isAllPagesSelected,
    setIsAllPagesSelected,
    isBatchSupplierModalOpen,
    setIsBatchSupplierModalOpen,
    isBatchPriceModalOpen,
    setIsBatchPriceModalOpen,
    isSavingBatch,
    setIsSavingBatch,
    brands,
    setBrands,
    categories,
    setCategories,
    suppliers,
    setSuppliers,
    branches,
    filters,
    setFilters,
    page,
    totalPages,
    totalProducts,
    fetchProducts,
    isCSVModalOpen,
    setIsCSVModalOpen,
    isTransferModalOpen,
    setIsTransferModalOpen,
    transferInitialItems,
    setTransferInitialItems,
    selectedProductForModifiers,
    setSelectedProductForModifiers,
    isModifiersModalOpen,
    setIsModifiersModalOpen,
    businessSector,
  } = useProductTableState();

  const { handleExportCSV } = useProductCSV(() => fetchProducts(page));

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > totalPages) return;
    fetchProducts(newPage);
  };

  const handleOpenDeleteModal = (product: Product) => {
    setItemToDelete(product);
    setIsModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/products/${itemToDelete.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message || `Error HTTP: ${response.status}`,
        );
      }
      toast.success("Producto eliminado correctamente");
      setIsModalOpen(false);
      setItemToDelete(null);
      fetchProducts(page);
    } catch (err: any) {
      toast.error(err.message || "Error al eliminar el producto.");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEdit = (id: number) => {
    router.push(`/productos/${id}/editar`);
  };

  const handleFilterChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    const { name, value } = e.target;
    setFilters((prev) => ({ ...prev, [name]: value }));
    setSelectedIds(new Set());
    setIsAllPagesSelected(false);
  };

  const handleClearFilters = () => {
    setFilters({
      search: "",
      brandId: "",
      categoryId: "",
      supplierId: "",
      branchId: "",
    });
    setSelectedIds(new Set());
    setIsAllPagesSelected(false);
  };

  const handleToggleSelect = (id: number) => {
    if (isAllPagesSelected) {
      setIsAllPagesSelected(false);
      setSelectedIds(new Set([id]));
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (isAllPagesSelected || selectedIds.size === products.length) {
      setSelectedIds(new Set());
      setIsAllPagesSelected(false);
    } else {
      setSelectedIds(new Set(products.map((p) => p.id)));
      setIsAllPagesSelected(false);
    }
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setIsAllPagesSelected(false);
  };

  const handleBatchDelete = async () => {
    setIsBatchDeleting(true);
    try {
      const res = await fetch("/api/products/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          isAllPagesSelected,
          filters: isAllPagesSelected ? filters : undefined,
        }),
      });
      if (!res.ok) throw new Error("Error al eliminar los productos.");
      const data = await res.json();
      toast.success(
        `Se eliminaron ${data.deletedCount || selectedIds.size} productos.`,
      );
      setIsBatchDeleteOpen(false);
      handleClearSelection();
      fetchProducts(page);
    } catch (err: any) {
      toast.error(err.message || "Error al eliminar en lote.");
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const handleBatchWebStatus = async (isPublicWeb: boolean) => {
    try {
      const res = await fetch("/api/products/batch-web-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          isAllPagesSelected,
          filters: isAllPagesSelected ? filters : undefined,
          isPublicWeb,
        }),
      });
      if (!res.ok) throw new Error("Error al actualizar estado en tienda web.");
      const data = await res.json();
      toast.success(
        `Se actualizaron ${data.updatedCount || selectedIds.size} productos.`,
      );
      handleClearSelection();
      fetchProducts(page);
    } catch (err: any) {
      toast.error(err.message || "Error al actualizar la visibilidad web.");
    }
  };

  const handleToggleWebPublic = async (id: number, isPublicWeb: boolean) => {
    try {
      const res = await fetch(`/api/products/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublicWeb }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "No se pudo actualizar visibilidad.");
      }
      fetchProducts(page);
      toast.success(
        isPublicWeb ? "Publicado en ClinStore" : "Oculto de ClinStore",
      );
    } catch (err: any) {
      toast.error(err.message || "Error al cambiar visibilidad.");
    }
  };

  const handleOpenTransferForSelected = () => {
    const selectedProds = products.filter((p) => selectedIds.has(p.id));
    const items: TransferItem[] = selectedProds.map((p) => ({
      product: p,
      quantity: 1,
    }));
    setTransferInitialItems(items);
    setIsTransferModalOpen(true);
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          data.message || "No se pudo iniciar la sincronización.",
        );
      toast.success(data.message || "Sincronización realizada con éxito.");
      fetchProducts(page);
    } catch (err: any) {
      toast.error(err.message || "Error al sincronizar.");
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <>
      <ConfirmationModal
        isOpen={isModalOpen}
        title="Confirmar Eliminación"
        confirmText="Eliminar"
        cancelText="Cancelar"
        onConfirm={handleConfirmDelete}
        onClose={() => {
          setIsModalOpen(false);
          setItemToDelete(null);
        }}
        isLoading={isDeleting}
      >
        {`¿Estás seguro de que deseas eliminar el producto "${itemToDelete?.name}"? Esta acción no se puede deshacer.`}
      </ConfirmationModal>

      <ConfirmationModal
        isOpen={isBatchDeleteOpen}
        title="Confirmar Eliminación Masiva"
        confirmText="Eliminar Todo"
        cancelText="Cancelar"
        onConfirm={handleBatchDelete}
        onClose={() => setIsBatchDeleteOpen(false)}
        isLoading={isBatchDeleting}
      >
        {`¿Eliminar los ${isAllPagesSelected ? totalProducts : selectedIds.size} productos seleccionados?`}
      </ConfirmationModal>

      <CSVImportModal
        isOpen={isCSVModalOpen}
        onClose={() => setIsCSVModalOpen(false)}
        onSuccess={() => fetchProducts(1)}
      />

      <TransferStockModal
        isOpen={isTransferModalOpen}
        onClose={() => {
          setIsTransferModalOpen(false);
          setTransferInitialItems([]);
        }}
        products={products}
        initialItems={transferInitialItems}
        onTransferCompleted={() => fetchProducts(page)}
      />

      <BatchSupplierModal
        isOpen={isBatchSupplierModalOpen}
        onClose={() => setIsBatchSupplierModalOpen(false)}
        selectedCount={selectedIds.size}
        brands={brands}
        categories={categories}
        suppliers={suppliers}
        isSaving={isSavingBatch}
        onSave={async (data) => {
          setIsSavingBatch(true);
          try {
            const res = await fetch("/api/products/batch-update", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ids: Array.from(selectedIds),
                isAllPagesSelected,
                filters: isAllPagesSelected ? filters : undefined,
                ...data,
              }),
            });
            if (!res.ok) throw new Error("Error al actualizar productos.");
            toast.success("Productos actualizados.");
            setIsBatchSupplierModalOpen(false);
            handleClearSelection();
            fetchProducts(page);
          } catch (err: any) {
            toast.error(err.message || "Error en actualización masiva.");
          } finally {
            setIsSavingBatch(false);
          }
        }}
        onBrandCreated={(b) => setBrands((prev) => [...prev, b])}
        onCategoryCreated={(c) => setCategories((prev) => [...prev, c])}
        onSupplierCreated={(s) => setSuppliers((prev) => [...prev, s])}
      />

      <BatchPriceModal
        isOpen={isBatchPriceModalOpen}
        onClose={() => setIsBatchPriceModalOpen(false)}
        selectedCount={selectedIds.size}
        isAllPagesSelected={isAllPagesSelected}
        totalCount={totalProducts}
        selectedIds={selectedIds}
        filters={filters}
        onSuccess={() => fetchProducts(page)}
      />

      <div className="bg-muted p-4 sm:p-6 rounded-lg shadow">
        <ProductFilters
          filters={filters}
          brands={brands}
          categories={categories}
          suppliers={suppliers}
          branches={branches}
          onChange={handleFilterChange}
          onClear={handleClearFilters}
          onExportCSV={() => handleExportCSV(products)}
          onImportCSV={() => setIsCSVModalOpen(true)}
          onTransferStock={() => setIsTransferModalOpen(true)}
          onSync={handleManualSync}
          isSyncing={isSyncing}
        />
        {error && (
          <div className="text-center text-destructive p-4 bg-destructive/10 rounded-md my-4">
            <AlertCircle size={20} className="inline-block mr-2" />
            {error}
          </div>
        )}
        {loading && (
          <div className="text-center py-4">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        )}
        <SelectedBar
          count={selectedIds.size}
          totalCount={totalProducts}
          isAllPagesSelected={isAllPagesSelected}
          onSelectAllPages={() => setIsAllPagesSelected(true)}
          onClear={handleClearSelection}
          onBatchUpdate={() => setIsBatchSupplierModalOpen(true)}
          onAdjustPrices={() => setIsBatchPriceModalOpen(true)}
          {...(isPro
            ? {
                onPublishWeb: () => handleBatchWebStatus(true),
                onHideWeb: () => handleBatchWebStatus(false),
              }
            : {})}
          onTransferStock={handleOpenTransferForSelected}
          onDelete={() => setIsBatchDeleteOpen(true)}
        />
        <div className="overflow-x-auto">
          <table className="hidden md:table w-full text-left table-auto">
            <thead className="border-b border-border">
              <tr>
                <th className="py-3 px-2 text-sm font-semibold text-foreground w-8 text-center">
                  <input
                    type="checkbox"
                    checked={
                      isAllPagesSelected ||
                      (products.length > 0 &&
                        selectedIds.size === products.length)
                    }
                    onChange={handleSelectAll}
                    className="rounded border-border cursor-pointer"
                  />
                </th>
                <th className="py-3 px-2 text-sm font-semibold text-foreground">
                  Nombre
                </th>
                <th className="py-3 px-2 text-sm font-semibold text-foreground w-28">
                  SKU
                </th>
                <th className="py-3 px-2 text-sm font-semibold text-foreground w-28">
                  Marca
                </th>
                <th className="py-3 px-2 text-sm font-semibold text-foreground w-28">
                  Categoría
                </th>
                <th className="py-3 px-2 text-sm font-semibold text-foreground w-28">
                  Proveedor
                </th>
                <th className="py-3 px-2 text-sm font-semibold text-foreground text-right w-28">
                  P. Compra
                </th>
                <th className="py-3 px-2 text-sm font-semibold text-foreground text-right w-28">
                  P. Venta
                </th>
                <th className="py-3 px-2 text-sm font-semibold text-foreground text-center w-20">
                  Stock
                </th>
                {isPro && (
                  <th className="py-3 px-2 text-sm font-semibold text-foreground text-center w-28">
                    Tienda Web
                  </th>
                )}
                <th className="py-3 px-2 text-sm font-semibold text-foreground text-center w-20">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody>
              {!loading && products.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    className="text-center text-foreground-muted py-8"
                  >
                    No se encontraron productos.
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <ProductTableRow
                    key={product.id}
                    product={product}
                    selected={selectedIds.has(product.id)}
                    isPro={isPro}
                    activeBranchId={filters.branchId}
                    onToggleSelect={handleToggleSelect}
                    onToggleWebPublic={handleToggleWebPublic}
                    onOpenModifiers={(p) => {
                      setSelectedProductForModifiers(p);
                      setIsModifiersModalOpen(true);
                    }}
                    onEdit={handleEdit}
                    onOpenDelete={handleOpenDeleteModal}
                  />
                ))
              )}
            </tbody>
          </table>
          <div className="md:hidden space-y-2">
            {!loading && products.length === 0 ? (
              <div className="text-center text-foreground-muted py-8">
                No se encontraron productos.
              </div>
            ) : (
              products.map((product) => (
                <ProductMobileCard
                  key={product.id}
                  product={product}
                  onEdit={handleEdit}
                  onOpenDelete={handleOpenDeleteModal}
                />
              ))
            )}
          </div>
        </div>
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={totalProducts}
          itemLabel="productos"
          onPageChange={handlePageChange}
        />
      </div>

      <ProductModifiersModal
        isOpen={isModifiersModalOpen}
        onClose={() => setIsModifiersModalOpen(false)}
        productId={selectedProductForModifiers?.id || 0}
        productName={selectedProductForModifiers?.name || ""}
        businessSector={businessSector}
        onSuccess={() => fetchProducts(page)}
      />
    </>
  );
};

export default ProductTable;
