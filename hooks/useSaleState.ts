// hooks/useSaleState.ts
"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Client,
  Seller,
  Product,
  PaymentTypeEnum,
  Combo,
  Promotion,
  SaleItemInCart,
} from "@/types";
import { useModules } from "@/hooks/useModules";
import { toast } from "react-hot-toast";
import { loadCart, clearCart as clearCartPersist } from "@/hooks/useCartPersistence";
import { useSaleTotals } from "@/hooks/useSaleTotals";
import { usePromotionsEngine } from "@/hooks/usePromotionsEngine";

export interface SaleFormData {
  clientId: string;
  sellerId: string;
  paymentType: PaymentTypeEnum | "";
  notes: string;
  items: SaleItemInCart[];
  discountCode: string;
  creditCardPromotionId: number | null;
}

const initialFormData: SaleFormData = {
  clientId: "",
  sellerId: "",
  paymentType: "",
  notes: "",
  items: [],
  discountCode: "",
  creditCardPromotionId: null,
};

export const useSaleState = () => {
  const { isModuleEnabled } = useModules();
  
  // Obtenemos la sucursal activa configurada en esta PC
  const activeBranchIdStr = typeof window !== 'undefined' ? localStorage.getItem("clinpos_active_branch_id") : null;

  // Helper centralizado para extraer el stock de la sucursal activa
  const getLocalStock = useCallback((product: any) => {
    if (!product) return 0;
    if (activeBranchIdStr && product.branchStocks && Array.isArray(product.branchStocks)) {
      const bs = product.branchStocks.find((b: any) => String(b.branchId) === String(activeBranchIdStr));
      if (bs) return parseFloat(String(bs.quantityStock).replace(",", "."));
      // Si la sucursal activa no tiene entrada, caemos al stock global en vez de 0
    }
    // Fallback al global si no hay sucursal activa o la API no devolvió branchStocks
    return parseFloat(String(product.quantityStock || 0).replace(",", "."));
  }, [activeBranchIdStr]);

  const savedCart = useRef<any>(null);
  if (typeof window !== "undefined") {
    savedCart.current = loadCart();
  }

  const [formData, setFormData] = useState<SaleFormData>(() => ({
    clientId: savedCart.current?.clientId || "",
    sellerId: savedCart.current?.sellerId || "",
    paymentType: (savedCart.current?.paymentType as PaymentTypeEnum | "") || "",
    notes: savedCart.current?.notes || "",
    items: savedCart.current?.items || [],
    discountCode: savedCart.current?.discountCode || "",
    creditCardPromotionId: savedCart.current?.creditCardPromotionId || null,
  }));

  const [comboDiscounts, setComboDiscounts] = useState<Record<number, number>>(
    savedCart.current?.comboDiscounts || {},
  );
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [lastCreatedSale, setLastCreatedSale] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingInitialData, setIsFetchingInitialData] = useState(true);
  const [productSearchTerm, setProductSearchTerm] = useState("");
  const [searchedProducts, setSearchedProducts] = useState<Product[]>([]);
  const [clientSearchTerm, setClientSearchTerm] = useState("");
  const [searchedClients, setSearchedClients] = useState<Client[]>([]);
  const [recentProducts, setRecentProducts] = useState<Product[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [hasOpenCaja, setHasOpenCaja] = useState(false);

  const [categoryProducts, setCategoryProducts] = useState<Product[]>([]);
  const [isLoadingCategoryProducts, setIsLoadingCategoryProducts] =
    useState<boolean>(false);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const [showCajaModal, setShowCajaModal] = useState(false);
  const [isOpeningCaja, setIsOpeningCaja] = useState(false);
  const [showUnitTypeModal, setShowUnitTypeModal] = useState(false);
  const [pendingUnitTypeProduct, setPendingUnitTypeProduct] =
    useState<Product | null>(null);
  const [showWeightModal, setShowWeightModal] = useState(false);
  const [weightInputValue, setWeightInputValue] = useState("");
  const [pendingWeightProduct, setPendingWeightProduct] =
    useState<Product | null>(null);
  const [pendingWeightUnitType, setPendingWeightUnitType] = useState("");
  
  const productInputRef = useRef<HTMLInputElement>(null);
  const clientInputRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const weightInputRef = useRef<HTMLInputElement>(null);
  const barcodeTimer = useRef<NodeJS.Timeout | null>(null);
  const barcodeInput = useRef("");

  const [validDiscountCode, setValidDiscountCode] = useState<{
    code: string;
    percent: number;
    discountType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
    discountValue?: number;
    minPurchase?: number;
  } | null>(null);

  const [invoiceType, setInvoiceType] = useState<'A' | 'B' | 'C' | 'NONE'>('NONE');
  const [clientCuit, setClientCuit] = useState('');
  const [clientName, setClientName] = useState('');

  const comboDiscount = useMemo(
    () => Object.values(comboDiscounts).reduce((sum, d) => sum + d, 0),
    [comboDiscounts],
  );

  const subtotal = useMemo(
    () => formData.items.reduce((sum, i) => sum + i.subtotal, 0),
    [formData.items],
  );

  const appliedPromotion = usePromotionsEngine(
    formData.items,
    subtotal,
    comboDiscount,
    promotions,
  );

  const totals = useSaleTotals({
    items: formData.items,
    comboDiscounts,
    appliedPromotion,
    validDiscountCode,
    paymentType: formData.paymentType,
    config,
    discountCode: formData.discountCode,
  });

  const appliedPromotionRef = useRef(appliedPromotion);
  appliedPromotionRef.current = appliedPromotion;

  useEffect(() => {
    const fetchData = async () => {
      try {
        const configRes = await fetch("/api/config");
        const configData = configRes.ok ? await configRes.json() : {};
        setConfig(configData);

        // El vendedor es obligatorio para registrar una venta; cargarlo aun
        // cuando falle la configuración de módulos evita que producción oculte
        // el selector por un error de sincronización/configuración.
        const showVendedores = true;
        const showCombos = isModuleEnabled("combos_promociones");

        const [sellersData, cajaData, combosData, promosData] =
          await Promise.all([
            showVendedores
              ? fetch("/api/vendedores")
                  .then((r) => (r.ok ? r.json() : []))
                  .catch(() => [])
              : Promise.resolve([]),
            fetch("/api/caja")
              .then((r) => (r.ok ? r.json() : {}))
              .catch(() => ({})) as Promise<any>,
            showCombos
              ? fetch("/api/combos")
                  .then((r) => (r.ok ? r.json() : []))
                  .catch(() => [])
              : Promise.resolve([]),
            showCombos
              ? fetch("/api/promotions")
                  .then((r) => (r.ok ? r.json() : []))
                  .catch(() => [])
              : Promise.resolve([]),
          ]);

        const normalizedSellers: Seller[] = Array.isArray(sellersData)
          ? sellersData
          : (sellersData as any)?.data || [];
        setSellers(normalizedSellers);
        setHasOpenCaja(!!cajaData.open);

        const currentSellerIsValid = normalizedSellers.some(
          (seller) => String(seller.id) === String(formData.sellerId),
        );
        const defaultSellerId = cajaData.open?.seller?.id && normalizedSellers.some(
          (seller) => String(seller.id) === String(cajaData.open.seller.id),
        )
          ? String(cajaData.open.seller.id)
          : normalizedSellers.length > 0
          ? String(normalizedSellers[0].id)
          : "";

        if (defaultSellerId && !currentSellerIsValid) {
          setFormData((prev) => ({
            ...prev,
            sellerId: defaultSellerId,
          }));
        }

        const defaultPT = configData.defaultPaymentType;
        if (defaultPT) {
          setFormData((prev) => ({
            ...prev,
            paymentType: prev.paymentType || (defaultPT as PaymentTypeEnum),
          }));
        }

        if (showCombos) {
          setCombos(
            combosData
              .filter((c: any) => c.active)
              .map((c: any) => ({
                ...c,
                price: parseFloat(c.price),
                items: c.items.map((i: any) => ({
                  ...i,
                  customPrice: i.customPrice ? parseFloat(i.customPrice) : null,
                })),
              })),
          );

          setPromotions(
            promosData
              .filter((p: any) => {
                if (p.status !== "ACTIVE") return false;
                const now = new Date();
                if (p.startDate && new Date(p.startDate) > now) return false;
                if (p.endDate && new Date(p.endDate) < now) return false;
                return true;
              })
              .map((p: any) => ({
                ...p,
                discountValue: parseFloat(p.discountValue),
              })),
          );
        }
      } catch (err: unknown) {
        toast.error(
          err instanceof Error ? err.message : "Error cargando datos.",
        );
      } finally {
        setIsFetchingInitialData(false);
      }
    };
    fetchData();
  }, []);

  // Refresco centralizado del catálogo rápido y últimos vendidos (inyectando sucursal)
  const refreshCatalogs = useCallback(() => {
    setIsLoadingCategoryProducts(true);
    fetch(`/api/products?limit=24${activeBranchIdStr ? `&branchId=${activeBranchIdStr}` : ''}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setCategoryProducts(
            data.map((p: any) => ({
              ...p,
              priceSale: parseFloat(p.priceSale),
              // PISAMOS quantityStock con el valor local
              quantityStock: getLocalStock(p),
            })),
          );
        }
      })
      .catch(() => {})
      .finally(() => setIsLoadingCategoryProducts(false));

    fetch(`/api/ventas/recent-products${activeBranchIdStr ? `&branchId=${activeBranchIdStr}` : ''}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setRecentProducts(
            data.map((p: any) => ({
              ...p,
              priceSale: parseFloat(p.priceSale),
              // PISAMOS quantityStock con el valor local
              quantityStock: getLocalStock(p),
            })),
          );
        }
      })
      .catch(() => {});
  }, [activeBranchIdStr, getLocalStock]);

  // Carga inicial de catálogos
  useEffect(() => {
    refreshCatalogs();
  }, [refreshCatalogs]);

  // Refrescar en tiempo real cuando el sync trae stock nuevo (multi-sucursal, sin F5)
  useEffect(() => {
    const handleSync = () => refreshCatalogs();
    window.addEventListener("sync-completed", handleSync);
    return () => window.removeEventListener("sync-completed", handleSync);
  }, [refreshCatalogs]);

  useEffect(() => {
    if (formData.clientId && !selectedClient) {
      fetch(`/api/clients/${formData.clientId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) {
            setSelectedClient(data);
            setClientSearchTerm(
              `${data.firstName} ${data.lastName || ""}`.trim(),
            );
          }
        })
        .catch(() => {});
    }
  }, [formData.clientId, selectedClient]);

  useEffect(() => {
    if (!isFetchingInitialData) {
      setTimeout(() => productInputRef.current?.focus(), 150);
    }
  }, [isFetchingInitialData]);

  useEffect(() => {
    if (clientSearchTerm.trim() === "" || selectedClient) {
      setSearchedClients([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/clients?search=${encodeURIComponent(clientSearchTerm)}`,
        );
        if (res.ok) setSearchedClients(await res.json());
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [clientSearchTerm, selectedClient]);

  // Buscador de productos INYECTANDO SUCURSAL
  useEffect(() => {
    if (!productSearchTerm.trim()) {
      setSearchedProducts([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/products?search=${encodeURIComponent(productSearchTerm)}${activeBranchIdStr ? `&branchId=${activeBranchIdStr}` : ''}`,
        );
        if (res.ok) {
          const data = await res.json();
          const itemsInCartIds = formData.items.map((i) =>
            parseInt(i.productId),
          );
          setSearchedProducts(
            data
              .filter((p: any) => !itemsInCartIds.includes(p.id))
              .map((p: any) => ({
                ...p,
                priceSale: parseFloat(p.priceSale),
                // PISAMOS quantityStock con el valor local
                quantityStock: getLocalStock(p),
              }))
              .slice(0, 5),
          );
        }
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [productSearchTerm, formData.items, activeBranchIdStr, getLocalStock]);

  useEffect(() => {
    const code = formData.discountCode.trim().toUpperCase();
    if (!code) {
      setValidDiscountCode(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/discount-codes?code=${encodeURIComponent(code)}`,
        );
        if (res.ok) {
          const data = await res.json();
          const exact = (Array.isArray(data) ? data : data.data)?.find(
            (c: any) => c.code === code && c.isActive,
          );
          setValidDiscountCode(
            exact
              ? {
                  code: exact.code,
                  percent: parseFloat(exact.discountPercent),
                  discountType: (exact.discountType || 'PERCENTAGE') as 'PERCENTAGE' | 'FIXED_AMOUNT',
                  discountValue: exact.discountValue !== null && exact.discountValue !== undefined
                    ? parseFloat(exact.discountValue)
                    : parseFloat(exact.discountPercent),
                  minPurchase: exact.minPurchase ? parseFloat(exact.minPurchase) : 0,
                }
              : null,
          );
        }
      } catch {}
    }, 500);
    return () => clearTimeout(timer);
  }, [formData.discountCode]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "sale_cart",
        JSON.stringify({
          items: formData.items,
          clientId: formData.clientId,
          sellerId: formData.sellerId,
          paymentType: formData.paymentType,
          notes: formData.notes,
          discountCode: formData.discountCode,
          comboDiscounts,
        }),
      );
    } catch {}
  }, [
    formData.items,
    formData.clientId,
    formData.sellerId,
    formData.paymentType,
    formData.notes,
    formData.discountCode,
    comboDiscounts,
  ]);

  const clearCart = useCallback(() => {
    clearCartPersist();
    setFormData((prev) => ({
      ...initialFormData,
      sellerId: prev.sellerId || (sellers.length > 0 ? String(sellers[0].id) : ""),
    }));
    setSelectedClient(null);
    setClientSearchTerm("");
    setComboDiscounts({});
    setInvoiceType('NONE');
    setClientCuit('');
    setClientName('');
    setTimeout(() => productInputRef.current?.focus(), 50);
  }, [sellers]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F8" || (e.ctrlKey && e.key === "k")) {
        e.preventDefault();
        productInputRef.current?.focus();
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        submitButtonRef.current?.click();
        return;
      }
      if (e.key === "F4") {
        e.preventDefault();
        if (formData.items.length === 0) return;
        const confirmClear = confirm(
          "¿Estás seguro de que deseas vaciar el carrito actual?",
        );
        if (confirmClear) {
          clearCart();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [formData.items.length, clearCart]);

  const handleClientSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const searchTerm = e.target.value;
    setClientSearchTerm(searchTerm);
    if (searchTerm.trim() === "") {
      setFormData((prev) => ({ ...prev, clientId: "" }));
      setSelectedClient(null);
    }
  };

  const handleSelectClient = (client: Client) => {
    const fullName = `${client.firstName} ${client.lastName || ""}`.trim();
    setSelectedClient(client);
    setClientSearchTerm(fullName);
    setFormData((prev) => ({ ...prev, clientId: String(client.id) }));
    setSearchedClients([]);
    
    if (client.cuit) {
      setClientCuit(client.cuit);
    }
    if (client.businessName) {
      setClientName(client.businessName);
    } else {
      setClientName(fullName);
    }
  };

  const handleClearClientSelection = () => {
    setClientSearchTerm("");
    setSelectedClient(null);
    setFormData((prev) => ({
      ...prev,
      clientId: "",
      paymentType:
        prev.paymentType === PaymentTypeEnum.ON_ACCOUNT ? "" : prev.paymentType,
    }));
    setSearchedClients([]);
    setClientCuit("");
    setClientName("");
  };

  const handleProductSearchChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const value = e.target.value;
    setProductSearchTerm(value);
    if (barcodeTimer.current) clearTimeout(barcodeTimer.current);
    if (value.length > barcodeInput.current.length) {
      barcodeInput.current = value;
      barcodeTimer.current = setTimeout(() => {
        barcodeInput.current = "";
      }, 100);
    } else barcodeInput.current = "";
  };

  // Escaneo de código de barras INYECTANDO SUCURSAL
  const handleProductKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" && e.code !== "NumpadEnter") return;

    // Nunca enviar la venta desde el buscador: Enter pertenece al lector o a
    // la selección del producto, incluso si el campo quedó momentáneamente
    // vacío entre dos escaneos.
    e.preventDefault();

    // Leer el input directamente evita usar un estado un render atrasado
    // cuando el lector envía el último carácter y Enter casi juntos.
    const term = e.currentTarget.value.trim();
    if (!term) return;

    // Enter en el buscador siempre selecciona un producto. Esto permite que
    // el lector de barras (que normalmente envía código + Enter) y la
    // búsqueda por nombre compartan exactamente el mismo flujo.
    barcodeInput.current = "";

    const normalizedTerm = term.toLocaleLowerCase();
    const exactVisible = searchedProducts.find(
      (product) => product.sku?.trim().toLocaleLowerCase() === normalizedTerm,
    );
    const visibleProduct = exactVisible || searchedProducts[0];

    if (visibleProduct) {
      handleSelectProduct(visibleProduct);
      return;
    }

    // Si se presiona Enter antes de que termine la búsqueda (común con un
    // escáner), hacemos una última consulta y solo agregamos una coincidencia
    // exacta por SKU o un único resultado.
    fetch(`/api/products?search=${encodeURIComponent(term)}${activeBranchIdStr ? `&branchId=${activeBranchIdStr}` : ''}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        const products = Array.isArray(data) ? data : [];
        const exact = products.find(
          (product: any) => product.sku?.trim().toLocaleLowerCase() === normalizedTerm,
        );
        const product = exact || (products.length === 1 ? products[0] : null);

        if (product) {
          handleSelectProduct({
            ...product,
            priceSale: parseFloat(product.priceSale),
            // PISAMOS quantityStock con el valor local
            quantityStock: getLocalStock(product),
          });
        } else if (products.length === 0) {
          toast.error(`No se encontró un producto para "${term}".`);
        } else {
          toast.error("Hay varios productos. Elegí uno de la lista.");
        }
      })
      .catch(() => toast.error("Error al buscar el producto."));
  };

  const addProductToCart = (product: Product, unitType: string) => {
    const qty = 1;
    const tempId = Date.now();
    const newItem: SaleItemInCart = {
      productId: String(product.id),
      productName: product.name,
      availableStock: product.quantityStock,
      quantity: qty,
      priceAtSale: product.priceSale,
      tempId,
      subtotal: qty * product.priceSale,
      unitType,
    };
    setFormData((prev) => ({ ...prev, items: [...prev.items, newItem] }));
    setProductSearchTerm("");
    setSearchedProducts([]);
  };

  const handleSelectProduct = (product: Product) => {
    if (product.quantityStock <= 0) {
      toast.error(`"${product.name}" no tiene stock disponible en este local.`);
      setProductSearchTerm("");
      setSearchedProducts([]);
      productInputRef.current?.focus();
      return;
    }
    const existing = formData.items.find(
      (i) => i.productId === String(product.id),
    );
    const showFraccionada = isModuleEnabled("venta_fraccionada");
    const unitType = showFraccionada ? product.unitType || "UNIT" : "UNIT";
    if (showFraccionada && (unitType === "WEIGHT" || unitType === "VOLUME")) {
      setPendingWeightProduct(product);
      setPendingWeightUnitType(unitType);
      setWeightInputValue(existing ? String(existing.quantity * 1000) : "");
      setShowWeightModal(true);
      setProductSearchTerm("");
      setSearchedProducts([]);
      setTimeout(() => weightInputRef.current?.focus(), 100);
      return;
    }
    if (existing) {
      const newQty = existing.quantity + 1;
      setFormData((prev) => ({
        ...prev,
        items: prev.items.map((i) =>
          i.tempId === existing.tempId
            ? { ...i, quantity: newQty, subtotal: newQty * i.priceAtSale }
            : i,
        ),
      }));
      toast.success(`${product.name}: cantidad incrementada a ${newQty}`);
      setProductSearchTerm("");
      setSearchedProducts([]);
      setTimeout(() => productInputRef.current?.focus(), 50);
      return;
    }
    if (showFraccionada && !product.unitType) {
      setPendingUnitTypeProduct(product);
      setShowUnitTypeModal(true);
      setProductSearchTerm("");
      setSearchedProducts([]);
      return;
    }
    addProductToCart(product, unitType);
    setTimeout(() => productInputRef.current?.focus(), 50);
  };

  const handleWeightConfirm = (qtyInKgOrL: number) => {
    if (!pendingWeightProduct) return;
    const product = pendingWeightProduct;
    let finalQty = qtyInKgOrL;

    if (finalQty > product.quantityStock + 0.0001) {
      toast.error(`Stock máximo para ${product.name} es ${product.quantityStock}.`);
      finalQty = product.quantityStock;
    }

    const unitType = pendingWeightUnitType;
    const existing = formData.items.find(
      (i) => i.productId === String(product.id),
    );
    if (existing) {
      setFormData((prev) => ({
        ...prev,
        items: prev.items.map((i) =>
          i.tempId === existing.tempId
            ? {
                ...i,
                quantity: finalQty,
                subtotal: finalQty * i.priceAtSale,
              }
            : i,
        ),
      }));
    } else {
      addProductToCart(product, unitType);
      setFormData((prev) => ({
        ...prev,
        items: prev.items.map((item, idx, arr) =>
          idx === arr.length - 1
            ? {
                ...item,
                quantity: finalQty,
                subtotal: finalQty * item.priceAtSale,
              }
            : item,
        ),
      }));
    }
    setShowWeightModal(false);
    setPendingWeightProduct(null);
    setTimeout(() => productInputRef.current?.focus(), 50);
  };

  const handleConfirmUnitType = (unitType: string) => {
    if (!pendingUnitTypeProduct) return;
    addProductToCart(pendingUnitTypeProduct, unitType);
    setShowUnitTypeModal(false);
    setPendingUnitTypeProduct(null);
    fetch(`/api/products/${pendingUnitTypeProduct.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitType }),
    }).catch(() => {});
    setTimeout(() => productInputRef.current?.focus(), 50);
  };

  const handleItemDetailChange = (
    tempIdToUpdate: number,
    field: "quantity" | "priceAtSale",
    value: string,
  ) => {
    const normalizedValue = value.replace(",", ".");
    const numericValue =
      normalizedValue === "" ? 0 : parseFloat(normalizedValue);
    if (isNaN(numericValue)) return;

    let showStockError: string | null = null;

    setFormData((prev) => ({
      ...prev,
      items: prev.items.map((item) => {
        if (item.tempId !== tempIdToUpdate) return item;
        const updatedItem = { ...item };
        if (field === "quantity") {
          let finalQty = numericValue;
          const isFraccionado =
            item.unitType === "WEIGHT" ||
            item.unitType === "VOLUME" ||
            isModuleEnabled("venta_fraccionada");
          if (!isFraccionado) {
            finalQty = Math.round(finalQty);
          }
          if (finalQty > item.availableStock + 0.0001) {
            showStockError = `Stock máximo para ${item.productName} es ${item.availableStock}.`;
            updatedItem.quantity = item.availableStock;
          } else updatedItem.quantity = finalQty < 0 ? 0 : finalQty;
        } else updatedItem.priceAtSale = numericValue < 0 ? 0 : numericValue;
        updatedItem.subtotal = updatedItem.quantity * updatedItem.priceAtSale;
        return updatedItem;
      }),
    }));

    if (showStockError) {
      toast.error(showStockError);
    }
  };

  const handleRemoveItem = (tempIdToRemove: number) => {
    setFormData((prev) => {
      const removedItem = prev.items.find((i) => i.tempId === tempIdToRemove);
      const remaining = prev.items.filter(
        (item) => item.tempId !== tempIdToRemove,
      );
      if (removedItem?.comboBatchId) {
        const batchStillPresent = remaining.some(
          (i) => i.comboBatchId === removedItem.comboBatchId,
        );
        if (!batchStillPresent)
          setComboDiscounts((prevDiscounts) => {
            const next = { ...prevDiscounts };
            delete next[removedItem.comboBatchId!];
            return next;
          });
      }
      return { ...prev, items: remaining };
    });
  };

  const handleFormChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSelectCombo = (combo: Combo) => {
    if (!combo.items || combo.items.length === 0) {
      toast.error("El combo no tiene productos.");
      return;
    }
    const batchId = Date.now();
    const newItems: SaleItemInCart[] = combo.items.map((item) => ({
      productId: String(item.productId),
      productName: `${item.product?.name || `#${item.productId}`} (Combo: ${combo.name})`,
      // PISAMOS availableStock del combo con el valor local
      availableStock: item.product ? getLocalStock(item.product) : 999,
      quantity: item.quantity,
      priceAtSale: item.customPrice ?? item.product?.priceSale ?? 0,
      tempId: batchId + item.productId,
      subtotal:
        (item.customPrice ?? item.product?.priceSale ?? 0) * item.quantity,
      comboBatchId: batchId,
    }));
    const fullSum = newItems.reduce((sum, item) => sum + item.subtotal, 0);
    const discount = Math.max(0, fullSum - combo.price);
    setFormData((prev) => ({ ...prev, items: [...prev.items, ...newItems] }));
    setComboDiscounts((prev) => ({ ...prev, [batchId]: discount }));
    setProductSearchTerm("");
    setSearchedProducts([]);
    toast.success(
      `Combo "${combo.name}" agregado ($${combo.price}, ahorro $${discount}).`,
    );
    setTimeout(() => productInputRef.current?.focus(), 50);
  };

  const executeSale = async (e?: React.FormEvent<HTMLFormElement>, isOrder: boolean = false) => {
    if (e) e.preventDefault();
    setIsLoading(true);

    if (!hasOpenCaja && !isOrder) {
      toast.error("Debes tener una caja abierta para registrar una venta.");
      setShowCajaModal(true);
      setIsLoading(false);
      return;
    }

    if (!formData.paymentType) {
      toast.error("Seleccioná un tipo de pago.");
      setIsLoading(false);
      return;
    }
    if (formData.items.length === 0) {
      toast.error("Añadí al menos un producto a la venta.");
      setIsLoading(false);
      return;
    }

    const activeSellerId = formData.sellerId;

    if (!activeSellerId) {
      toast.error("Debes seleccionar un vendedor.");
      setIsLoading(false);
      return;
    }

    if (config.arcaEnabled === 'true' && invoiceType === 'A') {
      if (!clientCuit.trim() || clientCuit.replace(/\D/g, '').length !== 11) {
        toast.error("El CUIT del cliente es requerido y debe tener 11 dígitos para Factura A.");
        setIsLoading(false);
        return;
      }
      if (!clientName.trim()) {
        toast.error("La Razón Social del cliente es requerida para Factura A.");
        setIsLoading(false);
        return;
      }
    }

    const promo = appliedPromotionRef.current;
    
    // Convertimos la sucursal activa a número para la DB
    const activeBranchId = activeBranchIdStr ? parseInt(activeBranchIdStr) : null;

    const dataToSend = {
      branchId: activeBranchId,
      clientId: formData.clientId ? parseInt(formData.clientId) : null,
      sellerId: parseInt(activeSellerId),
      paymentType: formData.paymentType as PaymentTypeEnum,
      notes: formData.notes.trim() || null,
      items: formData.items.map((item) => ({
        productId: parseInt(item.productId),
        quantity: item.quantity,
        priceAtSale: item.priceAtSale,
      })),
      discountCodeApplied: formData.discountCode.trim() || null,
      paymentMethodDiscount: totals.paymentMethodDiscount,
      promotionsApplied: [
        ...(comboDiscount > 0
          ? [
              {
                promotionId: 0,
                name: "Descuento combo",
                type: "COMBO",
                discountAmount: comboDiscount,
              },
            ]
          : []),
        ...(promo
          ? [
              {
                promotionId: promo.promotionId,
                name: promo.name,
                type: promo.type,
                discountAmount: promo.discountAmount,
              },
            ]
          : []),
      ],
      invoiceType,
      ...(invoiceType === 'A' && { clientCuit: clientCuit.trim(), clientName: clientName.trim() }),
      status: isOrder ? 'PENDING' : 'COMPLETED',
      creditCardPromotionId: formData.creditCardPromotionId,
    };
    try {
      const response = await fetch("/api/ventas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dataToSend),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error HTTP: ${response.status}`);
      }
      const data = await response.json();
      setLastCreatedSale(data);
      
      if (data.arcaError) {
        toast.error(`Venta registrada pero falló la facturación: ${data.arcaError}`, { duration: 6000 });
      } else if (data.invoice) {
        toast.success(`¡Venta y Factura ${data.invoice.invoiceType} #${data.invoice.invoiceNumber} registradas!`);
      } else if (isOrder) {
        toast.success("¡Pedido guardado exitosamente!");
      } else {
        toast.success("¡Venta registrada exitosamente!");
      }

      clearCart();

      // Refresco post-venta (catálogo rápido + recientes, con inyección de sucursal)
      refreshCatalogs();

      setTimeout(() => productInputRef.current?.focus(), 50);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Ocurrió un error al procesar la operación.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    await executeSale(e, false);
  };

  const handleSaveOrder = async () => {
    await executeSale(undefined, true);
  };

  const handlePrintLastSale = async () => { };

  const handleOpenCajaFromSale = async (
    sellerId: string,
    initialBalance: string,
  ) => {
    setIsOpeningCaja(true);
    const activeSellerId = isModuleEnabled("vendedores") ? sellerId : "1";
    try {
      const res = await fetch("/api/caja", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initialBalance: parseFloat(initialBalance) || 0,
          sellerId: activeSellerId,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      toast.success("Caja abierta exitosamente.");
      setShowCajaModal(false);
      setHasOpenCaja(true);
      setFormData((prev) => ({ ...prev, sellerId: activeSellerId }));
      setTimeout(() => productInputRef.current?.focus(), 50);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Error al abrir la caja.",
      );
    } finally {
      setIsOpeningCaja(false);
    }
  };

  return {
    isModuleEnabled,
    formData,
    setFormData,
    clientSearchTerm,
    setClientSearchTerm,
    searchedClients,
    productSearchTerm,
    setProductSearchTerm,
    searchedProducts,
    recentProducts,
    categoryProducts,
    isLoadingCategoryProducts,
    selectedClient,
    sellers,
    combos,
    promotions,
    isLoading,
    isFetchingInitialData,
    lastCreatedSale,
    setLastCreatedSale,
    hasOpenCaja,
    setHasOpenCaja,
    showCajaModal,
    setShowCajaModal,
    isOpeningCaja,
    setIsOpeningCaja,
    showUnitTypeModal,
    setShowUnitTypeModal,
    pendingUnitTypeProduct,
    setPendingUnitTypeProduct,
    showWeightModal,
    setShowWeightModal,
    weightInputValue,
    pendingWeightProduct,
    setPendingWeightProduct,
    pendingWeightUnitType,
    productInputRef,
    clientInputRef,
    submitButtonRef,
    weightInputRef,
    validDiscountCode,
    comboDiscount,
    totals,
    appliedPromotion,
    clearCart,
    handleClientSearchChange,
    handleSelectClient,
    handleClearClientSelection,
    handleProductSearchChange,
    handleProductKeyDown,
    handleSelectProduct,
    handleWeightConfirm,
    handleConfirmUnitType,
    handleItemDetailChange,
    handleRemoveItem,
    handleFormChange,
    handleSubmit,
    handleSaveOrder,
    handlePrintLastSale,
    handleSelectCombo,
    handleOpenCajaFromSale,
    config,
    invoiceType,
    setInvoiceType,
    clientCuit,
    setClientCuit,
    clientName,
    setClientName,
  };
};
