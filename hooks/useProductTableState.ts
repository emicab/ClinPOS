"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Product, Brand, Category, Supplier, Branch } from "@/types";
import toast from "react-hot-toast";

export function useProductTableState() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<Product | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isBatchDeleteOpen, setIsBatchDeleteOpen] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isAllPagesSelected, setIsAllPagesSelected] = useState(false);
  const [isBatchSupplierModalOpen, setIsBatchSupplierModalOpen] = useState(false);
  const [isBatchPriceModalOpen, setIsBatchPriceModalOpen] = useState(false);
  const [isSavingBatch, setIsSavingBatch] = useState(false);

  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [filters, setFilters] = useState({
    search: "",
    brandId: "",
    categoryId: "",
    supplierId: "",
    branchId: "",
  });

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const [isCSVModalOpen, setIsCSVModalOpen] = useState(false);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [transferInitialItems, setTransferInitialItems] = useState<any[]>([]);

  const [selectedProductForModifiers, setSelectedProductForModifiers] = useState<Product | null>(null);
  const [isModifiersModalOpen, setIsModifiersModalOpen] = useState(false);
  const [businessSector, setBusinessSector] = useState("GASTRONOMIA");

  useEffect(() => {
    fetch("/api/store-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg?.businessSector) setBusinessSector(cfg.businessSector);
      })
      .catch(() => {});
  }, []);

  // Opciones de los dropdowns de filtro. Se expone como callback para
  // poder refrescarlas tras importar CSV o crear marcas/categorías/
  // proveedores (si no, lo recién creado no aparece hasta recargar).
  const fetchFilterOptions = useCallback(async () => {
    try {
      const [brandsRes, categoriesRes, suppliersRes, branchesRes] = await Promise.all([
        fetch("/api/brands"),
        fetch("/api/categories"),
        fetch("/api/proveedores"),
        fetch("/api/branches"),
      ]);
      if (!brandsRes.ok || !categoriesRes.ok || !suppliersRes.ok)
        throw new Error("Error al cargar opciones de filtro.");

      setBrands(await brandsRes.json());
      setCategories(await categoriesRes.json());
      setSuppliers(await suppliersRes.json());
      if (branchesRes.ok) {
        const list: Branch[] = await branchesRes.json();
        setBranches(list);
        // Validar la sucursal guardada contra la lista real: el localStorage
        // es por PC (no por negocio) y puede traer un id de otro negocio o
        // de una sucursal eliminada → forzar global en ese caso. Con 0-1
        // sucursales el filtro es innecesario: siempre global.
        const stored = localStorage.getItem("clinpos_active_branch_id");
        const valid =
          stored &&
          list.length > 1 &&
          list.some((b) => String(b.id) === String(stored));
        setFilters((prev) => ({ ...prev, branchId: valid ? String(stored) : "" }));
      }
    } catch (err: any) {
      console.error("Filtro-Error:", err);
      setError("No se pudieron cargar las opciones de filtro.");
    }
  }, []);

  useEffect(() => {
    fetchFilterOptions();
  }, [fetchFilterOptions]);

  const fetchProducts = useCallback(
    async (pageNum = 1) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (filters.search) params.append("search", filters.search);
      if (filters.brandId) params.append("brandId", filters.brandId);
      if (filters.categoryId) params.append("categoryId", filters.categoryId);
      if (filters.supplierId) params.append("supplierId", filters.supplierId);
      if (filters.branchId) params.append("branchId", filters.branchId);
      params.append("page", String(pageNum));
      params.append("limit", "20");
      const queryString = params.toString();

      try {
        const response = await fetch(`/api/products?${queryString}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.message || `Error HTTP: ${response.status}`,
          );
        }
        const result = await response.json();
        const items = Array.isArray(result) ? result : result.data;
        setProducts(
          items.map((product: any) => ({
            ...product,
            pricePurchase: product.pricePurchase
              ? parseFloat(product.pricePurchase)
              : null,
            priceSale: parseFloat(product.priceSale),
          })),
        );
        if (!Array.isArray(result)) {
          setTotalPages(result.pagination.totalPages);
          setTotalProducts(result.pagination.total);
          setPage(result.pagination.page);
        } else {
          setTotalPages(1);
          setTotalProducts(items.length);
          setPage(1);
        }
      } catch (err: any) {
        setError(err.message || "Error al cargar los productos.");
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchProducts(1);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [filters, fetchProducts]);

  useEffect(() => {
    const handleSyncCompleted = () => {
      fetchProducts(page);
    };
    window.addEventListener("sync-completed", handleSyncCompleted);
    return () => window.removeEventListener("sync-completed", handleSyncCompleted);
  }, [fetchProducts, page]);

  return {
    products,
    setProducts,
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
    setPage,
    totalPages,
    totalProducts,
    fetchProducts,
    fetchFilterOptions,
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
  };
}
