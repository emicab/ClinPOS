"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Loader2,
  Package,
  Edit3,
  PlusCircle,
  RefreshCw,
  X,
  ShoppingCart,
  CheckSquare,
} from "lucide-react";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import CreatePurchaseModal from "@/components/stock/CreatePurchaseModal";
import AddProductToOrderModal from "@/components/stock/AddProductToOrderModal";
import Pagination from "@/components/ui/Pagination";
import type { Supplier } from "@/types";
import { motion, AnimatePresence } from "motion/react";
import toast from "react-hot-toast";

interface AlertProduct {
  id: number;
  name: string;
  sku: string | null;
  quantityStock: number;
  stockMinAlert: number | null;
  pricePurchase: number | null;
  priceSale: number;
  unitType: string | null;
  supplier?: { id: number; name: string } | null;
  isRecipe?: boolean;
  isIngredient?: boolean;
}

function isInStockAlert(p: AlertProduct): boolean {
  // Sin stock físico / derivado (elaborados que no se pueden preparar).
  if (p.quantityStock <= 0) return true;
  const hasMinAlert = p.stockMinAlert !== null && p.stockMinAlert !== undefined;
  if (hasMinAlert && p.quantityStock < p.stockMinAlert!) return true;
  return false;
}

export default function StockAlertasPage() {
  const [allProducts, setAllProducts] = useState<AlertProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [filterSupplierId, setFilterSupplierId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [productsToOrder, setProductsToOrder] = useState<AlertProduct[]>([]);

  // Pestaña activa: 'alerts' (Productos en Alerta) o 'all' (Todos los Productos)
  const [activeTab, setActiveTab] = useState<"alerts" | "all">("alerts");

  // Búsqueda, ordenamiento y paginación
  const [searchQuery, setSearchQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<
    "name" | "sku" | "supplier" | "stock" | "minStock"
  >("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 15;

  // Lógica del carrito de pedido activo
  const [productToAdd, setProductToAdd] = useState<AlertProduct | null>(null);
  const [isAddingProduct, setIsAddingProduct] = useState(false);
  const [activeOrder, setActiveOrder] = useState<{
    id: number;
    supplierId: number;
    supplierName: string;
    itemsCount: number;
    totalAmount: number;
  } | null>(null);

  const fetchAlerts = async () => {
    setLoading(true);
    setIsRefreshing(true);
    try {
      const [productsRes, suppliersRes] = await Promise.all([
        fetch("/api/products?kind=all&limit=1000"), // Incluye productos, ingredientes y elaborados
        fetch("/api/proveedores"),
      ]);
      if (!productsRes.ok) throw new Error("Error al cargar productos");
      if (suppliersRes.ok) setSuppliers(await suppliersRes.json());

      const data = await productsRes.json();
      const items: AlertProduct[] = (
        Array.isArray(data) ? data : data.data || []
      ).map((p: any) => ({
        ...p,
        pricePurchase: p.pricePurchase ? parseFloat(p.pricePurchase) : null,
        priceSale: parseFloat(p.priceSale),
      }));
      setAllProducts(items);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
  }, []);

  // Resetear paginación y selección al cambiar de pestaña o filtros
  useEffect(() => {
    setCurrentPage(1);
    setSelectedIds(new Set());
  }, [activeTab, filterSupplierId, searchQuery]);

  // Filtrar productos según la pestaña activa
  const tabProducts = useMemo(() => {
    if (activeTab === "alerts") {
      return allProducts.filter(isInStockAlert);
    }
    return allProducts;
  }, [allProducts, activeTab]);

  const supplierOptions = useMemo(() => {
    const ids = new Set(
      tabProducts.map((p) => p.supplier?.id).filter(Boolean) as number[],
    );
    return suppliers.filter((s) => ids.has(s.id));
  }, [tabProducts, suppliers]);

  const filteredProducts = useMemo(() => {
    let result = tabProducts;

    // 1. Filtrar por proveedor
    if (filterSupplierId) {
      result = result.filter(
        (p) => p.supplier?.id === parseInt(filterSupplierId),
      );
    }

    // 2. Filtrar por búsqueda de nombre o SKU (insensible a mayúsculas y acentos)
    if (searchQuery.trim()) {
      const q = searchQuery
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      result = result.filter(
        (p) =>
          p.name
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .includes(q) ||
          (p.sku &&
            p.sku
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .includes(q)),
      );
    }

    // 3. Ordenar
    result = [...result].sort((a, b) => {
      let valA: any = "";
      let valB: any = "";

      switch (sortColumn) {
        case "name":
          valA = a.name.toLowerCase();
          valB = b.name.toLowerCase();
          break;
        case "sku":
          valA = (a.sku || "").toLowerCase();
          valB = (b.sku || "").toLowerCase();
          break;
        case "supplier":
          valA = (a.supplier?.name || "").toLowerCase();
          valB = (b.supplier?.name || "").toLowerCase();
          break;
        case "stock":
          valA = a.quantityStock;
          valB = b.quantityStock;
          break;
        case "minStock":
          valA = a.stockMinAlert ?? 0;
          valB = b.stockMinAlert ?? 0;
          break;
      }

      if (valA < valB) return sortDirection === "asc" ? -1 : 1;
      if (valA > valB) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });

    return result;
  }, [tabProducts, filterSupplierId, searchQuery, sortColumn, sortDirection]);

  // Paginación
  const totalPages = Math.ceil(filteredProducts.length / pageSize);

  const paginatedProducts = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return filteredProducts.slice(startIndex, startIndex + pageSize);
  }, [filteredProducts, currentPage]);

  const allSelected =
    paginatedProducts.length > 0 &&
    paginatedProducts.every((p) => selectedIds.has(p.id));

  const handleSelectAll = () => {
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        paginatedProducts.forEach((p) => next.delete(p.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        paginatedProducts.forEach((p) => next.add(p.id));
        return next;
      });
    }
  };

  const handleToggle = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Agregar a la orden activa (o abrir el modal de confirmación individual)
  const handleAddToOrder = (productId: number) => {
    const prod = allProducts.find((p) => p.id === productId);
    if (prod) {
      setProductToAdd(prod);
    }
  };

  const handleConfirmAddProduct = async (data: {
    supplierId: number;
    quantity: number;
    purchasePrice: number;
  }) => {
    if (!productToAdd) return;
    setIsAddingProduct(true);
    try {
      if (!activeOrder || activeOrder.supplierId !== data.supplierId) {
        // --- 1. Crear nueva orden de compra (pedido) ---
        const res = await fetch("/api/compras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supplierId: data.supplierId,
            status: "ORDERED",
            items: [
              {
                productId: productToAdd.id,
                quantity: data.quantity,
                purchasePrice: data.purchasePrice,
              },
            ],
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(
            errData.message || "Error al crear la orden de compra.",
          );
        }

        const newPurchase = await res.json();
        setActiveOrder({
          id: newPurchase.id,
          supplierId: newPurchase.supplierId,
          supplierName:
            newPurchase.supplier?.name ||
            suppliers.find((s) => s.id === newPurchase.supplierId)?.name ||
            "Proveedor",
          itemsCount: 1,
          totalAmount: data.quantity * data.purchasePrice,
        });

        toast.success(
          `Pedido creado con éxito para ${newPurchase.supplier?.name || "el proveedor"}.`,
        );
      } else {
        // --- 2. Agregar a orden de compra existente ---
        const getRes = await fetch(`/api/compras/${activeOrder.id}`);
        if (!getRes.ok) {
          const data = await getRes.json().catch(() => ({}));
          throw new Error(data.message || "No se pudo obtener el pedido activo.");
        }
        const currentPurchase = await getRes.json();

        const existingItems = (currentPurchase.items || []).map(
          (item: any) => ({
            productId: item.productId,
            quantity: parseFloat(item.quantity),
            purchasePrice: parseFloat(item.purchasePrice),
          }),
        );

        const itemIndex = existingItems.findIndex(
          (item: any) => item.productId === productToAdd.id,
        );
        if (itemIndex > -1) {
          existingItems[itemIndex].quantity += data.quantity;
          existingItems[itemIndex].purchasePrice = data.purchasePrice;
        } else {
          existingItems.push({
            productId: productToAdd.id,
            quantity: data.quantity,
            purchasePrice: data.purchasePrice,
          });
        }

        const putRes = await fetch(`/api/compras/${activeOrder.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supplierId: activeOrder.supplierId,
            status: "ORDERED",
            items: existingItems,
          }),
        });

        if (!putRes.ok) {
          const errData = await putRes.json().catch(() => ({}));
          throw new Error(errData.message || "Error al actualizar el pedido.");
        }

        const updatedTotal = existingItems.reduce(
          (sum: number, item: any) => sum + item.quantity * item.purchasePrice,
          0,
        );
        setActiveOrder({
          ...activeOrder,
          itemsCount: existingItems.length,
          totalAmount: updatedTotal,
        });

        toast.success(`¡"${productToAdd.name}" agregado al pedido activo!`);
      }

      setProductToAdd(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(productToAdd.id);
        return next;
      });
      fetchAlerts();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Error inesperado.");
    } finally {
      setIsAddingProduct(false);
    }
  };

  // Abrir modal masivo para los seleccionados en la tabla
  const handleOpenBatchOrder = () => {
    const list = allProducts.filter((p) => selectedIds.has(p.id));
    setProductsToOrder(list);
    setShowCreateModal(true);
  };

  // Abrir modal del pedido activo para ver/editar todos los ítems cargados
  const handleOpenActiveOrderCart = async () => {
    if (!activeOrder) return;
    setLoading(true);
    try {
      const getRes = await fetch(`/api/compras/${activeOrder.id}`);
      if (!getRes.ok) {
        const data = await getRes.json().catch(() => ({}));
        throw new Error(data.message || "No se pudo obtener el pedido activo.");
      }
      const currentPurchase = await getRes.json();

      const itemsList = (currentPurchase.items || []).map((item: any) => ({
        id: item.product.id,
        name: item.product.name,
        sku: item.product.sku,
        quantityStock: parseFloat(item.product.quantityStock),
        stockMinAlert: item.product.stockMinAlert
          ? parseFloat(item.product.stockMinAlert)
          : null,
        pricePurchase: parseFloat(item.purchasePrice),
        priceSale: parseFloat(item.product.priceSale),
        unitType: item.product.unitType,
        supplier: currentPurchase.supplier,
      }));

      setProductsToOrder(itemsList);
      setShowCreateModal(true);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Error inesperado.");
    } finally {
      setLoading(false);
    }
  };

  const handleSuccess = () => {
    setSelectedIds(new Set());
    setActiveOrder(null);
    fetchAlerts();
  };

  const handleSort = (
    column: "name" | "sku" | "supplier" | "stock" | "minStock",
  ) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };

  const renderSortIcon = (
    column: "name" | "sku" | "supplier" | "stock" | "minStock",
  ) => {
    if (sortColumn !== column)
      return (
        <span className="text-foreground-muted/40 text-xs ml-1 select-none">
          ⇅
        </span>
      );
    return sortDirection === "asc" ? (
      <span className="text-primary text-xs ml-1 select-none">▲</span>
    ) : (
      <span className="text-primary text-xs ml-1 select-none">▼</span>
    );
  };

  return (
    <div className="w-full font-sans pb-24">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <AlertTriangle size={28} className="text-red-500 animate-pulse" />
          <h1 className="text-2xl font-bold text-foreground">
            Pedidos y Alertas de Stock
          </h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchAlerts}
            className="flex items-center gap-2 px-3.5 py-2 text-sm bg-muted hover:bg-background border border-border rounded-xl transition-all shadow-sm duration-200"
            disabled={isRefreshing}
          >
            <RefreshCw
              size={16}
              className={isRefreshing ? "animate-spin" : ""}
            />{" "}
            Actualizar
          </button>
          <Link
            href="/compras/nueva"
            className="flex items-center gap-2 px-3.5 py-2 text-sm bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-all shadow-md font-medium"
          >
            <PlusCircle size={16} /> Nueva Compra
          </Link>
        </div>
      </div>

      {/* Tabs superiores de unificación */}
      <div className="flex border-b border-border mb-6">
        <button
          onClick={() => setActiveTab("alerts")}
          className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-all ${
            activeTab === "alerts"
              ? "border-primary text-primary"
              : "border-transparent text-foreground-muted hover:text-foreground"
          }`}
        >
          En Alerta de Stock (
          {
            allProducts.filter(isInStockAlert).length
          }
          )
        </button>
        <button
          onClick={() => setActiveTab("all")}
          className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-all ${
            activeTab === "all"
              ? "border-primary text-primary"
              : "border-transparent text-foreground-muted hover:text-foreground"
          }`}
        >
          Todos los Productos ({allProducts.length})
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 size={32} className="animate-spin text-primary" />
        </div>
      ) : tabProducts.length === 0 ? (
        <div className="text-center py-16 bg-muted rounded-2xl border border-border shadow-inner">
          <Package size={48} className="mx-auto text-success/60 mb-4" />
          <h2 className="text-xl font-semibold text-foreground">
            Todo en orden
          </h2>
          <p className="text-foreground-muted mt-2 text-sm">
            No hay productos en esta sección.
          </p>
        </div>
      ) : (
        <div className="bg-muted rounded-2xl border border-border overflow-hidden shadow-md">
          <div className="p-4 sm:p-5 border-b border-border flex flex-col md:flex-row md:items-center justify-between gap-3 bg-background/40">
            <p className="text-sm text-foreground-muted font-medium whitespace-nowrap">
              {filteredProducts.length} producto
              {filteredProducts.length !== 1 ? "s" : ""} encontrado
              {filteredProducts.length !== 1 ? "s" : ""}
            </p>
            <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
              <input
                type="text"
                placeholder="Buscar por nombre o SKU..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="text-sm px-3.5 py-2 border border-border rounded-xl bg-background text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring w-full sm:w-64"
              />
              <Select
                name="supplierFilter"
                value={filterSupplierId}
                onChange={(e) => {
                  setFilterSupplierId(e.target.value);
                  setSelectedIds(new Set());
                }}
                aria-label="Filtrar por proveedor"
                className="text-sm rounded-xl w-full sm:w-64"
              >
                <option value="">Todos los proveedores</option>
                {supplierOptions.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead className="border-b border-border bg-background/10">
                <tr>
                  <th className="p-3 sm:p-4 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={handleSelectAll}
                      className="rounded border-border bg-background"
                    />
                  </th>
                  <th
                    className="p-3 sm:p-4 text-sm font-bold text-foreground cursor-pointer select-none hover:bg-background/25 transition-colors"
                    onClick={() => handleSort("name")}
                  >
                    Producto {renderSortIcon("name")}
                  </th>
                  <th
                    className="p-3 sm:p-4 text-sm font-bold text-foreground cursor-pointer select-none hover:bg-background/25 transition-colors hidden sm:table-cell"
                    onClick={() => handleSort("sku")}
                  >
                    SKU {renderSortIcon("sku")}
                  </th>
                  <th
                    className="p-3 sm:p-4 text-sm font-bold text-foreground cursor-pointer select-none hover:bg-background/25 transition-colors hidden md:table-cell"
                    onClick={() => handleSort("supplier")}
                  >
                    Proveedor {renderSortIcon("supplier")}
                  </th>
                  <th
                    className="p-3 sm:p-4 text-sm font-bold text-foreground cursor-pointer select-none hover:bg-background/25 transition-colors text-center"
                    onClick={() => handleSort("stock")}
                  >
                    Stock actual {renderSortIcon("stock")}
                  </th>
                  <th
                    className="p-3 sm:p-4 text-sm font-bold text-foreground cursor-pointer select-none hover:bg-background/25 transition-colors text-center"
                    onClick={() => handleSort("minStock")}
                  >
                    Mínimo {renderSortIcon("minStock")}
                  </th>
                  <th className="p-3 sm:p-4 text-sm font-bold text-foreground text-right">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {paginatedProducts.map((product) => {
                  const stockRatio = Math.min(
                    100,
                    Math.max(
                      0,
                      (product.quantityStock / (product.stockMinAlert || 1)) *
                        100,
                    ),
                  );
                  const isBelowMin =
                    product.quantityStock <= 0 ||
                    (product.stockMinAlert !== null &&
                      product.stockMinAlert !== undefined &&
                      product.quantityStock < product.stockMinAlert);

                  return (
                    <tr
                      key={product.id}
                      className="border-b border-border/40 last:border-b-0 hover:bg-background/40 transition-colors"
                    >
                      <td className="p-3 sm:p-4">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(product.id)}
                          onChange={() => handleToggle(product.id)}
                          className="rounded border-border bg-background"
                        />
                      </td>
                      <td className="p-3 sm:p-4 text-sm font-semibold text-foreground">
                        <div className="flex items-center gap-2">
                          {product.name}
                          {product.isRecipe ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800/40 font-bold whitespace-nowrap">
                              🧾 Elaborado
                            </span>
                          ) : product.isIngredient ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40 font-bold whitespace-nowrap">
                              🥫 Ingrediente
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="p-3 sm:p-4 text-sm text-foreground-muted hidden sm:table-cell font-mono">
                        {product.sku || "-"}
                      </td>
                      <td className="p-3 sm:p-4 text-sm text-foreground-muted hidden md:table-cell">
                        {product.supplier?.name || "-"}
                      </td>
                      <td className="p-3 sm:p-4 text-sm text-center">
                        <div className="flex flex-col items-center gap-1.5">
                          {isBelowMin ? (
                            <>
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-red-500/10 text-red-500 text-xs font-bold">
                                <AlertTriangle
                                  size={11}
                                  className="text-red-500 animate-pulse"
                                />
                                {product.quantityStock}{" "}
                                {product.unitType === "WEIGHT"
                                  ? "kg"
                                  : product.unitType === "VOLUME"
                                    ? "L"
                                    : "u"}
                              </span>
                              <div className="w-16 h-1.5 bg-border/80 rounded-full overflow-hidden mt-0.5">
                                <div
                                  className="bg-red-500 h-full rounded-full"
                                  style={{ width: `${stockRatio}%` }}
                                />
                              </div>
                            </>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-success/15 text-success text-xs font-bold">
                              {product.quantityStock}{" "}
                              {product.unitType === "WEIGHT"
                                ? "kg"
                                : product.unitType === "VOLUME"
                                  ? "L"
                                  : "u"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-3 sm:p-4 text-sm text-center text-foreground-muted font-medium">
                        {product.stockMinAlert !== null &&
                        product.stockMinAlert !== undefined
                          ? `${product.stockMinAlert} ${product.unitType === "WEIGHT" ? "kg" : product.unitType === "VOLUME" ? "L" : "u"}`
                          : "-"}
                      </td>
                      <td className="p-3 sm:p-4 text-sm text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleAddToOrder(product.id)}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all font-medium shadow-sm hover:scale-105 active:scale-95"
                            title="Agregar a orden de compra"
                          >
                            <ShoppingCart size={12} />
                            <span>Pedido</span>
                          </button>
                          <Link
                            href={`/productos/${product.id}/editar`}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-accent text-accent-foreground rounded-lg hover:bg-accent/80 transition-all font-medium border border-border/50 hover:scale-105 active:scale-95"
                          >
                            <Edit3 size={12} />
                            <span>Editar</span>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="p-4 border-t border-border bg-background/10">
              <Pagination
                page={currentPage}
                totalPages={totalPages}
                totalItems={filteredProducts.length}
                itemLabel="productos"
                onPageChange={(p) => setCurrentPage(p)}
              />
            </div>
          )}

          {filteredProducts.length === 0 &&
            (filterSupplierId || searchQuery) && (
              <div className="text-center py-8 text-foreground-muted text-sm bg-background/10">
                No se encontraron productos con los filtros ingresados.
              </div>
            )}
        </div>
      )}

      {/* Barra de Selección Masiva (para seleccionar varios y crear una orden nueva) */}
      <AnimatePresence>
        {selectedIds.size > 0 && !activeOrder && (
          <motion.div
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 20 }}
            className="fixed bottom-[20px] left-4 md:left-[272px] right-4 z-40 p-4 bg-muted/95 border border-border shadow-2xl rounded-2xl backdrop-blur-md"
          >
            <div className="max-w-screen-2xl mx-auto flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <CheckSquare size={20} className="text-primary" />
                <span className="text-sm font-semibold text-foreground">
                  {selectedIds.size} producto{selectedIds.size !== 1 ? "s" : ""}{" "}
                  seleccionado{selectedIds.size !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="p-1 rounded-full hover:bg-border transition-colors text-foreground-muted hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </div>
              <Button
                variant="primary"
                onClick={handleOpenBatchOrder}
                className="shadow-lg hover:scale-102 active:scale-98"
              >
                <ShoppingCart size={16} className="mr-1.5" />
                Crear Orden de Compra ({selectedIds.size})
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Barra de Pedido Activo (Carrito de Pedidos) */}
      <AnimatePresence>
        {activeOrder && (
          <motion.div
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 20 }}
            className="fixed bottom-[20px] left-4 md:left-[272px] right-4 z-40 p-4 bg-muted/95 border border-border shadow-2xl rounded-2xl backdrop-blur-md"
          >
            <div className="max-w-screen-2xl mx-auto flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <ShoppingCart
                  size={20}
                  className="text-primary animate-bounce"
                />
                <div>
                  <p className="text-sm font-bold text-foreground">
                    Pedido Activo: {activeOrder.supplierName}
                  </p>
                  <p className="text-xs text-foreground-muted">
                    {activeOrder.itemsCount} producto(s) cargado(s)
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveOrder(null)}
                >
                  <X size={14} className="mr-1" /> Cancelar Pedido
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleOpenActiveOrderCart}
                  className="shadow-md"
                >
                  <ShoppingCart size={14} className="mr-1" /> Ver Carrito de
                  Pedido
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AddProductToOrderModal
        isOpen={!!productToAdd}
        product={productToAdd}
        suppliers={suppliers}
        isSaving={isAddingProduct}
        onConfirm={handleConfirmAddProduct}
        onClose={() => setProductToAdd(null)}
        activeOrderSupplierId={activeOrder?.supplierId}
      />

      <CreatePurchaseModal
        isOpen={showCreateModal}
        products={productsToOrder}
        suppliers={suppliers}
        onClose={() => setShowCreateModal(false)}
        onSuccess={handleSuccess}
        activePurchaseId={activeOrder?.id}
      />
    </div>
  );
}
