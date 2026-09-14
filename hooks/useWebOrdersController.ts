"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import toast from "react-hot-toast";
import { playOrderChimeSound } from "@/lib/audio";

export interface WebOrderItem {
  id: number;
  productId: number;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  modifiers?: string | null;
  product?: {
    name: string;
    sku?: string | null;
  };
}

export interface WebOrder {
  id: number;
  webOrderNumber: string;
  clientName: string;
  clientEmail?: string | null;
  clientPhone: string;
  shippingAddress?: string | null;
  deliveryType: "PICKUP" | "DELIVERY";
  paymentMethod: string;
  paymentStatus: string;
  status:
    | "PENDING_PREPARATION"
    | "READY_FOR_PICKUP"
    | "SHIPPED"
    | "DELIVERED"
    | "CANCELLED"
    | "PENDING_REVIEW";
  totalAmount: string;
  subtotalAmount?: string;
  discountAmount?: string;
  deliveryFee?: string;
  couponCode?: string | null;
  discountBreakdown?: string | null;
  deliveryZone?: string | null;
  trackingCode?: string | null;
  scheduledFor?: string | null;
  stockReviewNote?: string | null;
  stockReviewAt?: string | null;
  mpPaymentId?: string | null;
  origin?: string | null;
  notes?: string | null;
  branchId?: number | null;
  createdAt: string;
  items: WebOrderItem[];
}

export interface Branch {
  id: number;
  name: string;
  address?: string | null;
  phone?: string | null;
  isMain: boolean;
}

export function useWebOrdersController() {
  const [orders, setOrders] = useState<WebOrder[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>("ALL");
  const [selectedOrder, setSelectedOrder] = useState<WebOrder | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isPulling, setIsPulling] = useState(false);
  const [businessSector, setBusinessSector] = useState("GASTRONOMIA");
  const [requireMpForDelivery, setRequireMpForDelivery] = useState(true);
  const [storeSlug, setStoreSlug] = useState("");
  const [platformDomain, setPlatformDomain] = useState("");
  const [viewMode, setViewMode] = useState<"table" | "comanda">(() => {
    if (typeof window !== "undefined" && localStorage.getItem("clinpos_orders_view_mode")) {
      return localStorage.getItem("clinpos_orders_view_mode") as "table" | "comanda";
    }
    return "comanda";
  });

  const lastOrderCountRef = useRef(0);
  const isInitialLoadRef = useRef(true);

  const fetchOrders = useCallback(async (isManualPull = false) => {
    if (isManualPull) setIsPulling(true);
    try {
      const res = await fetch("/api/web-orders");
      if (!res.ok) throw new Error("Error al cargar pedidos.");
      const data: WebOrder[] = await res.json();

      if (!isInitialLoadRef.current && data.length > lastOrderCountRef.current) {
        playOrderChimeSound();
        toast.success("¡Nuevo pedido web recibido!", { icon: "🔔" });
      }
      isInitialLoadRef.current = false;
      lastOrderCountRef.current = data.length;

      setOrders(data);
      setError(null);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Error al cargar pedidos.");
    } finally {
      setLoading(false);
      if (isManualPull) setIsPulling(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    fetch("/api/branches")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setBranches(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetch("/api/store-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg?.businessSector) {
          setBusinessSector(cfg.businessSector);
          if (cfg.businessSector === "GASTRONOMIA") setViewMode("comanda");
          else setViewMode("table");
        }
        if (cfg?.requireMpForDelivery !== undefined) {
          setRequireMpForDelivery(Boolean(cfg.requireMpForDelivery));
        }
        if (cfg?.slug) setStoreSlug(cfg.slug);
        if (cfg?.customDomain) setPlatformDomain(cfg.customDomain);
      })
      .catch(() => {});
  }, [fetchOrders]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchOrders();
    }, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchOrders]);

  const toggleViewMode = (mode: "table" | "comanda") => {
    setViewMode(mode);
    if (typeof window !== "undefined") {
      localStorage.setItem("clinpos_orders_view_mode", mode);
    }
  };

  const handleStatusChange = async (
    orderId: number,
    newStatus: WebOrder["status"],
  ) => {
    try {
      const res = await fetch(`/api/web-orders/${orderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          errData?.message || "No se pudo actualizar el estado.",
        );
      }
      toast.success("Estado actualizado.");
      fetchOrders();
      if (selectedOrder && selectedOrder.id === orderId) {
        setSelectedOrder((prev) => (prev ? { ...prev, status: newStatus } : null));
      }
    } catch (err: any) {
      toast.error(err.message || "Error al actualizar estado.");
    }
  };

  const handleBranchChange = async (orderId: number, branchId: number | null) => {
    try {
      const res = await fetch(`/api/web-orders/${orderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "No se pudo asignar la sucursal.");
      }
      toast.success("Sucursal asignada al pedido.");
      fetchOrders();
    } catch (err: any) {
      toast.error(err.message || "Error al reasignar sucursal.");
    }
  };

  const filteredOrders = orders.filter((o) => {
    const matchSearch =
      !searchTerm.trim() ||
      o.webOrderNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      o.clientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      o.clientPhone.includes(searchTerm) ||
      (o.shippingAddress &&
        o.shippingAddress.toLowerCase().includes(searchTerm.toLowerCase()));

    const matchStatus =
      statusFilter === "ALL" ||
      (statusFilter === "ACTIVE"
        ? o.status !== "DELIVERED" && o.status !== "CANCELLED"
        : o.status === statusFilter);

    const matchPayment =
      paymentStatusFilter === "ALL" || o.paymentStatus === paymentStatusFilter;

    return matchSearch && matchStatus && matchPayment;
  });

  return {
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
    activeOrderId,
    setActiveOrderId,
    isManualModalOpen,
    setIsManualModalOpen,
    autoRefresh,
    setAutoRefresh,
    isPulling,
    businessSector,
    requireMpForDelivery,
    storeSlug,
    platformDomain,
    viewMode,
    toggleViewMode,
    fetchOrders,
    handleStatusChange,
    handleBranchChange,
    filteredOrders,
  };
}
