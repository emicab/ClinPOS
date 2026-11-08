"use client";

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Brand, Category, Supplier, Product } from '@/types';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import { Loader2, AlertCircle, Upload, Search, Image as ImageIcon, Check, X, ChefHat, Globe, EyeOff, Lock, XCircle, Calculator } from 'lucide-react';
import { useQuickCreate } from '@/hooks/useQuickCreate';
import QuickCreateModal from './QuickCreateModal';
import RecipeEditor, { RecipeIngredientForm } from '@/components/recetario/RecipeEditor';
import { useModules } from '@/hooks/useModules';
import toast from 'react-hot-toast';
import { optimizeImage } from '@/lib/imageOptimizer';
import { calcSalePrice, marginOnSale, markupOnCost, type MarginMode } from '@/lib/priceAdjuster';

interface ProductFormData {
  name: string;
  sku: string;
  description: string;
  imageUrl: string;
  pricePurchase: string;
  priceSale: string;
  quantityStock: string;
  stockMinAlert: string;
  brandId: string;
  categoryId: string;
  supplierId: string;
  unitType: string;
  isPublicWeb: boolean;
  webUnavailable: boolean;
}

interface ProductFormProps {
  initialProductData?: Product | null;
}

const ProductForm: React.FC<ProductFormProps> = ({ initialProductData }) => {
  const router = useRouter();
  const { plan } = useModules();
  const isPro = plan === "pro";

  // Calcular el stock inicial correcto para la sucursal activa antes de inicializar el estado
  let initialFormStock = initialProductData ? String(initialProductData.quantityStock) : '';
  if (initialProductData && typeof window !== "undefined") {
    const activeBranchId = localStorage.getItem("clinpos_active_branch_id");
    if (activeBranchId && (initialProductData as any).branchStocks) {
      const bs = (initialProductData as any).branchStocks.find((b: any) => b.branchId === Number(activeBranchId));
      initialFormStock = bs ? String(bs.quantityStock) : '0';
    }
  }

  const [formData, setFormData] = useState<ProductFormData>({
    name: initialProductData?.name || '',
    sku: initialProductData?.sku || '',
    description: initialProductData?.description || '',
    imageUrl: initialProductData?.imageUrl || '',
    pricePurchase: initialProductData?.pricePurchase !== null && initialProductData?.pricePurchase !== undefined ? String(initialProductData.pricePurchase) : '',
    priceSale: initialProductData ? String(initialProductData.priceSale) : '',
    quantityStock: initialFormStock,
    stockMinAlert: initialProductData?.stockMinAlert !== null && initialProductData?.stockMinAlert !== undefined ? String(initialProductData.stockMinAlert) : '',
    brandId: initialProductData ? String(initialProductData.brandId ?? '') : '',
    categoryId: initialProductData ? String(initialProductData.categoryId ?? '') : '',
    supplierId: initialProductData?.supplierId ? String(initialProductData.supplierId) : '',
    unitType: initialProductData?.unitType || '',
    isPublicWeb: !!initialProductData?.isPublicWeb,
    webUnavailable: !!initialProductData?.webUnavailable,
  });
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingDropdowns, setIsFetchingDropdowns] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSearchingML, setIsSearchingML] = useState(false);
  const [mlCandidates, setMlCandidates] = useState<Array<{ id: string; title: string; imageUrl: string; thumbnail: string }>>([]);
  const [isMLModalOpen, setIsMLModalOpen] = useState(false);

  // ── Calculadora de precio de venta ─────────────────────────────────────
  const [marginPct, setMarginPct] = useState<string>('');
  const [marginMode, setMarginMode] = useState<MarginMode>('markup');

  // Preview en vivo: se recalcula sola al cambiar costo o %.
  const costNum = parseFloat(formData.pricePurchase);
  let marginSuggested: number | null = null;
  let marginCounterpart = '';
  let marginCalcError: string | null = null;
  if (marginPct.trim() !== '') {
    try {
      marginSuggested = calcSalePrice(costNum, parseFloat(marginPct), marginMode);
      marginCounterpart = marginMode === 'markup'
        ? `Margen s/venta: ${marginOnSale(costNum, marginSuggested)}%`
        : `Recargo s/costo: ${markupOnCost(costNum, marginSuggested)}%`;
    } catch (e: any) {
      marginCalcError = e?.message || 'Revisá los valores.';
    }
  }

  const applyMarginPrice = () => {
    if (marginSuggested === null) return;
    setFormData((prev) => ({ ...prev, priceSale: String(marginSuggested) }));
  };

  // ── Recetario ────────────────────────────────────────────────────────────
  const [isRecipe, setIsRecipe] = useState<boolean>(!!initialProductData?.isRecipe);
  const [recipeItems, setRecipeItems] = useState<RecipeIngredientForm[]>([]);
  const [isLoadingRecipe, setIsLoadingRecipe] = useState(false);

  const loadRecipeItems = async (productId: number) => {
    setIsLoadingRecipe(true);
    try {
      const res = await fetch(`/api/recipes/${productId}`);
      if (res.ok) {
        const data = await res.json();
        setIsRecipe(!!data.isRecipe);
        setRecipeItems(
          (data.items || []).map((i: any) => ({
            ingredientId: i.ingredientId,
            name: i.name,
            unitType: i.unitType || 'UNIT',
            quantity: i.quantity,
          })),
        );
      }
    } catch {
      // silencioso
    } finally {
      setIsLoadingRecipe(false);
    }
  };

  useEffect(() => {
    // Cargar la receta al editar un producto elaborado.
    if (initialProductData?.id && initialProductData.isRecipe) {
      loadRecipeItems(initialProductData.id);
    }
    // Clonar receta: /productos/nuevo?clonarReceta=<id> copia ingredientes y datos.
    if (!initialProductData && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const clonarId = params.get('clonarReceta');
      if (clonarId && !isNaN(parseInt(clonarId))) {
        (async () => {
          try {
            const res = await fetch(`/api/recipes/${clonarId}`);
            if (res.ok) {
              const data = await res.json();
              setRecipeItems(
                (data.items || []).map((i: any) => ({
                  ingredientId: i.ingredientId,
                  name: i.name,
                  unitType: i.unitType || 'UNIT',
                  quantity: i.quantity,
                })),
              );
              if (params.get('nombre')) {
                setFormData((prev) => ({ ...prev, name: params.get('nombre')! }));
              }
              if (params.get('precio')) {
                setFormData((prev) => ({ ...prev, priceSale: params.get('precio')! }));
              }
              setIsRecipe(true);
            }
          } catch {
            // silencioso
          }
        })();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProductData]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Por favor selecciona un archivo de imagen válido.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('La imagen no debe superar los 10MB.');
      return;
    }

    e.target.value = '';

    const toastId = toast.loading('Procesando imagen...');
    try {
      const optimized = await optimizeImage(file);
      const cloudRes = await fetch('/api/upload/cloudinary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: optimized.dataUrl }),
      });

      const cloudData = await cloudRes.json();
      if (cloudRes.ok && cloudData.url) {
        setFormData(prev => ({ ...prev, imageUrl: cloudData.url }));
        toast.success('Imagen subida a Cloudinary exitosamente.', { id: toastId });
      } else {
        toast.error(`No se pudo subir la imagen: ${cloudData.message || 'error de Cloudinary'}. Intentá de nuevo.`, { id: toastId });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'error desconocido';
      toast.error(`No se pudo procesar la imagen: ${msg}. Intentá de nuevo.`, { id: toastId });
    }
  };

  const handleSearchMLImage = async () => {
    const searchQuery = formData.name || formData.sku;
    if (!searchQuery.trim()) {
      toast.error('Ingresa el Nombre del producto para buscar su foto.');
      return;
    }

    setIsSearchingML(true);
    try {
      const res = await fetch(`/api/products/search-image?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'No se encontraron imágenes.');
      }

      if (data.candidates && data.candidates.length > 0) {
        setMlCandidates(data.candidates);
        setIsMLModalOpen(true);
        toast.success(`Se encontraron ${data.candidates.length} fotos en Mercado Libre.`);
      }
    } catch (err: any) {
      toast.error(err.message || 'Error al buscar foto.');
    } finally {
      setIsSearchingML(false);
    }
  };

  const brandQuickCreate = useQuickCreate({
    apiEndpoint: '/api/brands',
    label: 'marca',
    onCreated: (created) => setBrands(prev => [...prev, created as Brand].sort((a, b) => a.name.localeCompare(b.name))),
    onFieldSelect: (id) => setFormData(prev => ({ ...prev, brandId: id })),
  });

  const categoryQuickCreate = useQuickCreate({
    apiEndpoint: '/api/categories',
    label: 'categoría',
    onCreated: (created) => setCategories(prev => [...prev, created as Category].sort((a, b) => a.name.localeCompare(b.name))),
    onFieldSelect: (id) => setFormData(prev => ({ ...prev, categoryId: id })),
  });

  useEffect(() => {
    const fetchData = async () => {
      setIsFetchingDropdowns(true);
      try {
        const [brandsRes, categoriesRes, suppliersRes] = await Promise.all([
          fetch('/api/brands'),
          fetch('/api/categories'),
          fetch('/api/proveedores'),
        ]);
        if (!brandsRes.ok || !categoriesRes.ok || !suppliersRes.ok) {
          throw new Error('Error al cargar datos para el formulario.');
        }
        const brandsData = await brandsRes.json();
        const categoriesData = await categoriesRes.json();
        const suppliersData = await suppliersRes.json();
        setBrands(brandsData);
        setCategories(categoriesData);
        setSuppliers(suppliersData);
      } catch (err: any) {
        setError(err.message || 'Error cargando datos.');
      } finally {
        setIsFetchingDropdowns(false);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (initialProductData) {
      const refreshAndLoad = async () => {
        // Modo local: siempre se usan los datos locales (sin pull a la nube).
        const dataToUse = initialProductData;

        let initialStock = dataToUse.quantityStock;
        if (typeof window !== "undefined") {
          const activeBranchId = localStorage.getItem("clinpos_active_branch_id");
          if (activeBranchId && (dataToUse as any).branchStocks) {
            const bs = (dataToUse as any).branchStocks.find((b: any) => b.branchId === Number(activeBranchId));
            initialStock = bs ? bs.quantityStock : 0;
          }
        }

        setFormData({
          name: dataToUse.name || '',
          sku: dataToUse.sku || '',
          description: dataToUse.description || '',
          imageUrl: dataToUse.imageUrl || '',
          pricePurchase: dataToUse.pricePurchase !== null && dataToUse.pricePurchase !== undefined ? String(dataToUse.pricePurchase) : '',
          priceSale: String(dataToUse.priceSale) || '',
          quantityStock: String(initialStock),
          stockMinAlert: dataToUse.stockMinAlert !== null && dataToUse.stockMinAlert !== undefined ? String(dataToUse.stockMinAlert) : '',
          brandId: dataToUse.brandId ? String(dataToUse.brandId) : '',
          categoryId: dataToUse.categoryId ? String(dataToUse.categoryId) : '',
          supplierId: dataToUse.supplierId ? String(dataToUse.supplierId) : '',
          unitType: dataToUse.unitType || '',
          isPublicWeb: !!dataToUse.isPublicWeb,
          webUnavailable: !!dataToUse.webUnavailable,
        });
      };
      refreshAndLoad();
    }
  }, [initialProductData]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccessMessage(null);

    // La marca es opcional; la categoría es obligatoria para productos vendibles.
    if (!formData.name || !formData.categoryId || !formData.priceSale || (!isRecipe && !formData.quantityStock) || !formData.unitType) {
      setError('Por favor, completa los campos obligatorios (Nombre, Categoría, Tipo de Unidad, Precio Venta, Stock).');
      setIsLoading(false);
      return;
    }

    const method = initialProductData ? 'PUT' : 'POST';
    const apiUrl = initialProductData
      ? `/api/products/${initialProductData.id}`
      : '/api/products';

    const activeBranchIdStr = typeof window !== 'undefined' ? localStorage.getItem("clinpos_active_branch_id") : null;
    const activeBranchId = activeBranchIdStr ? parseInt(activeBranchIdStr) : null;

    // Editar un producto no debe tocar el stock salvo que el usuario lo cambie.
    const currentStock = isRecipe ? 0 : parseFloat(formData.quantityStock);
    let stockChanged = !initialProductData;
    if (initialProductData) {
      let originalStock = Number(initialProductData.quantityStock) || 0;
      if (activeBranchIdStr && (initialProductData as any).branchStocks) {
        const bs = (initialProductData as any).branchStocks.find(
          (b: any) => b.branchId === Number(activeBranchIdStr),
        );
        originalStock = bs ? Number(bs.quantityStock) || 0 : 0;
      }
      stockChanged = !isRecipe && Math.abs(currentStock - originalStock) > 0.0001;
    }

    const dataToSend = {
        branchId: activeBranchId,
        name: formData.name,
        sku: formData.sku || null,
        description: formData.description || null,
        imageUrl: formData.imageUrl || null,
        pricePurchase: formData.pricePurchase ? parseFloat(formData.pricePurchase) : null,
        priceSale: parseFloat(formData.priceSale),
        ...(stockChanged ? { quantityStock: currentStock } : {}),
        stockMinAlert: formData.stockMinAlert ? parseFloat(formData.stockMinAlert) : null,
        brandId: formData.brandId ? parseInt(formData.brandId) : null,
        categoryId: parseInt(formData.categoryId),
        supplierId: formData.supplierId ? parseInt(formData.supplierId) : null,
        unitType: formData.unitType || null,
        isPublicWeb: isPro ? formData.isPublicWeb : false,
        webUnavailable: isPro ? formData.isPublicWeb && formData.webUnavailable : false,
        isIngredient: false,
        isRecipe,
        recipeItems: isRecipe
          ? recipeItems.map((i) => ({
              ingredientId: i.ingredientId,
              quantity: i.quantity,
              unitType: i.unitType,
            }))
          : undefined,
    };
    try {
      const response = await fetch(apiUrl, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataToSend),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error HTTP: ${response.status}`);
      }

      setSuccessMessage(initialProductData ? '¡Producto actualizado exitosamente!' : '¡Producto creado exitosamente!');

      if (!initialProductData) {
        setFormData({
            name: '', sku: '', description: '', imageUrl: '', pricePurchase: '', priceSale: '',
            quantityStock: '', stockMinAlert: '', brandId: '', categoryId: '', supplierId: '',
            unitType: '', isPublicWeb: false, webUnavailable: false,
        });
      }

      setTimeout(() => {
        router.push('/productos');
        router.refresh();
      }, 1500);

    } catch (err: any) {
      setError(err.message || `Ocurrió un error al ${initialProductData ? 'actualizar' : 'crear'} el producto.`);
    } finally {
      setIsLoading(false);
    }
  };

  if (isFetchingDropdowns && !initialProductData) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 size={24} className="animate-spin text-primary mr-2" />
        Cargando datos del formulario...
      </div>
    );
  }

  const submitButtonText = initialProductData ? 'Actualizar Producto' : 'Guardar Producto';
  const loadingButtonText = initialProductData ? 'Actualizando...' : 'Guardando...';

  return (
    <>
    <form onSubmit={handleSubmit} className="bg-muted p-6 sm:p-8 rounded-lg shadow space-y-6 max-w-2xl mx-auto">
      {error && (
        <div className="flex items-center bg-destructive/10 text-destructive text-sm p-3 rounded-md">
          <AlertCircle size={18} className="mr-2" /> {error}
        </div>
      )}
      {successMessage && (
        <div className="flex items-center bg-success/10 text-success text-sm p-3 rounded-md">
          <AlertCircle size={18} className="mr-2" /> {successMessage}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Input label="Nombre del Producto *" name="name" value={formData.name} onChange={handleChange} required />
        <Input label="SKU (Opcional)" name="sku" value={formData.sku} onChange={handleChange} />
      </div>

      <div>
        <label htmlFor="description" className="block text-sm font-medium text-foreground-muted mb-1.5">Descripción (Opcional)</label>
        <textarea
          id="description" name="description" rows={3} value={formData.description} onChange={handleChange}
          className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {/* Sección de Imagen de Producto */}
      <div className="space-y-3 p-4 bg-muted/30 rounded-xl border border-border">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <label className="block text-sm font-semibold text-foreground">
            Imagen del Producto (para Tienda Web)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept="image/*"
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              title="Cargar una foto guardada en tu computadora"
              className="text-xs flex items-center gap-1.5"
            >
              <Upload size={14} /> Subir desde PC
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSearchMLImage}
              disabled={isSearchingML || (!formData.name && !formData.sku)}
              title="Buscar foto oficial automáticamente en Mercado Libre por nombre"
              className="text-xs flex items-center gap-1.5 border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
            >
              {isSearchingML ? (
                <Loader2 size={14} className="animate-spin text-amber-700" />
              ) : (
                <Search size={14} className="text-amber-700" />
              )}
              {isSearchingML ? "Buscando..." : "🔍 Buscar Foto en Mercado Libre"}
            </Button>
          </div>
        </div>

        <Input
          label=""
          name="imageUrl"
          placeholder="O pega directamente la URL de la imagen (https://...)"
          value={formData.imageUrl}
          onChange={handleChange}
        />

        {formData.imageUrl && (
          <div className="flex items-center justify-between gap-3 bg-background p-3 rounded-lg border border-border">
            <div className="flex items-center gap-3">
              <img
                src={formData.imageUrl}
                alt="Vista previa del producto"
                className="w-16 h-16 object-cover rounded-md border border-border"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
              <div>
                <p className="text-xs font-semibold text-foreground">Vista previa lista</p>
                <p className="text-[11px] text-foreground-muted truncate max-w-xs">
                  {formData.imageUrl.startsWith("data:")
                    ? "Imagen cargada desde tu PC"
                    : formData.imageUrl}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setFormData((prev) => ({ ...prev, imageUrl: "" }))}
              className="text-xs text-destructive hover:bg-destructive/10"
              title="Quitar foto"
            >
              <X size={16} /> Quitar
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <Select label="Marca (Opcional)" name="brandId" value={formData.brandId} onChange={handleChange} disabled={isFetchingDropdowns}>
            <option value="">{isFetchingDropdowns ? 'Cargando...' : 'Sin marca'}</option>
            {brands.map(brand => <option key={brand.id} value={String(brand.id)}>{brand.name}</option>)}
          </Select>
          <button type="button" onClick={() => brandQuickCreate.setIsOpen(true)} className="mt-1 text-xs text-primary hover:underline flex items-center">
            + Nueva Marca
          </button>
        </div>
        <div>
          <Select label="Categoría *" name="categoryId" value={formData.categoryId} onChange={handleChange} required disabled={isFetchingDropdowns}>
            <option value="">{isFetchingDropdowns ? 'Cargando...' : 'Selecciona una categoría'}</option>
            {categories.map(category => <option key={category.id} value={String(category.id)}>{category.name}</option>)}
          </Select>
          <button type="button" onClick={() => categoryQuickCreate.setIsOpen(true)} className="mt-1 text-xs text-primary hover:underline flex items-center">
            + Nueva Categoría
          </button>
        </div>
      </div>

      <Select label="Proveedor (Opcional)" name="supplierId" value={formData.supplierId} onChange={handleChange} disabled={isFetchingDropdowns}>
        <option value="">{isFetchingDropdowns ? 'Cargando...' : 'Sin proveedor'}</option>
        {suppliers.map(supplier => <option key={supplier.id} value={String(supplier.id)}>{supplier.name}</option>)}
      </Select>

      {/* Visibilidad en la tienda web (solo Plan Pro) */}
      {isPro ? (
        <label className="flex items-center gap-3 cursor-pointer select-none p-4 bg-muted/30 rounded-xl border border-border">
          <input
            type="checkbox"
            checked={formData.isPublicWeb}
            onChange={(e) => setFormData((prev) => ({ ...prev, isPublicWeb: e.target.checked }))}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          <span>
            <span className="block text-sm font-medium text-foreground flex items-center gap-1.5">
              {formData.isPublicWeb ? <Globe size={15} className="text-emerald-600" /> : <EyeOff size={15} className="text-foreground-muted" />}
              {formData.isPublicWeb ? "Visible en la tienda web" : "Oculto de la tienda web"}
            </span>
            <span className="block text-xs text-foreground-muted mt-0.5">
              Por defecto los productos se crean ocultos. Activá esta opción para publicarlo en ClinStore.
            </span>
          </span>
        </label>
      ) : (
        <div className="flex items-center gap-3 p-4 bg-muted/30 rounded-xl border border-border opacity-70">
          <Lock size={15} className="text-foreground-muted" />
          <p className="text-xs text-foreground-muted">
            La publicación en la tienda web (ClinStore) está disponible en el Plan Pro.
          </p>
        </div>
      )}

      {/* Marcar como agotado / no disponible en la tienda web (solo si es visible) */}
      {isPro && formData.isPublicWeb && (
        <label className="flex items-center gap-3 cursor-pointer select-none p-4 bg-rose-50/50 dark:bg-rose-950/20 rounded-xl border border-rose-200 dark:border-rose-800/50">
          <input
            type="checkbox"
            checked={formData.webUnavailable}
            onChange={(e) => setFormData((prev) => ({ ...prev, webUnavailable: e.target.checked }))}
            className="h-4 w-4 rounded border-border text-rose-600 focus:ring-rose-500"
          />
          <span>
            <span className="block text-sm font-medium text-foreground flex items-center gap-1.5">
              <XCircle size={15} className="text-rose-600" />
              {formData.webUnavailable ? "Agotado en la tienda web" : "Disponible en la tienda web"}
            </span>
            <span className="block text-xs text-foreground-muted mt-0.5">
              Marcalo como agotado para mostrarlo sin botón de compra en ClinStore (sin usar el stock).
            </span>
          </span>
        </label>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Input label="Precio de Compra" name="pricePurchase" type="number" step="0.01" value={formData.pricePurchase} onChange={handleChange} />
        <Input label="Precio de Venta *" name="priceSale" type="number" step="0.01" value={formData.priceSale} onChange={handleChange} required />
      </div>

      {/* Calculadora de precio de venta por porcentaje */}
      <div className="p-4 bg-emerald-50/50 dark:bg-emerald-950/20 rounded-xl border border-emerald-200 dark:border-emerald-800 space-y-3">
        <span className="block text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Calculator size={16} className="text-emerald-600" /> Calcular venta por porcentaje
        </span>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <Input label="% deseado" name="marginPct" type="number" step="0.1" value={marginPct} onChange={(e) => setMarginPct(e.target.value)} placeholder="Ej. 50" />
          <Select label="Modo" name="marginMode" value={marginMode} onChange={(e) => setMarginMode(e.target.value as MarginMode)}>
            <option value="markup">Recargo s/costo</option>
            <option value="margin">Margen s/venta</option>
          </Select>
          <Button type="button" variant="secondary" onClick={applyMarginPrice} disabled={marginSuggested === null}>
            {marginSuggested !== null ? `Aplicar $${marginSuggested}` : 'Aplicar'}
          </Button>
        </div>
        {marginSuggested !== null && (
          <p className="text-xs text-foreground-muted">
            Precio sugerido: <strong className="text-foreground">${marginSuggested}</strong>
            {' · '}{marginCounterpart}
            {marginMode === 'markup' ? ' (venta = costo × (1 + %))' : ' (venta = costo ÷ (1 − %))'}
          </p>
        )}
        {marginCalcError && (
          <p className="text-xs text-rose-600">{marginCalcError}</p>
        )}
        {marginPct.trim() === '' && (
          <p className="text-xs text-foreground-muted">Ingresá un % para ver el precio sugerido desde el costo.</p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Select label="Tipo de Unidad *" name="unitType" value={formData.unitType} onChange={handleChange} required>
          <option value="">Seleccionar...</option>
          <option value="UNIT">Unidad</option>
          <option value="WEIGHT">Peso (kg)</option>
          <option value="VOLUME">Volumen (L)</option>
        </Select>
      </div>

      {/* Recetario: producto elaborado */}
      <div className="space-y-4 p-4 bg-amber-50/50 dark:bg-amber-950/20 rounded-xl border border-amber-200 dark:border-amber-800">
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isRecipe}
            onChange={(e) => setIsRecipe(e.target.checked)}
            className="h-4 w-4 rounded border-border text-amber-600 focus:ring-amber-500"
          />
          <span>
            <span className="block text-sm font-semibold text-foreground flex items-center gap-1.5">
              <ChefHat size={16} className="text-amber-600" /> Producto elaborado (Recetario 🧾)
            </span>
            <span className="block text-xs text-foreground-muted mt-0.5">
              Ej. Lomo XL = 3 bifes, 2 huevos, 300g queso. El stock se calcula desde los ingredientes y al
              venderlo se descuentan los ingredientes.
            </span>
          </span>
        </label>

        {isRecipe && (
          <div className="space-y-3">
            {isLoadingRecipe ? (
              <div className="flex items-center gap-2 text-sm text-foreground-muted">
                <Loader2 size={15} className="animate-spin text-amber-600" /> Cargando receta...
              </div>
            ) : (
              <RecipeEditor items={recipeItems} onChange={setRecipeItems} excludeProductId={initialProductData?.id} />
            )}
            <div className="bg-background border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-foreground-muted">
              💡 El campo de stock no aplica para un producto elaborado: su disponibilidad se calcula
              automáticamente en base al stock de los ingredientes. Cargá stock a los ingredientes desde
              "Carga de Stock" o "Compras".
            </div>
          </div>
        )}
      </div>

      {!isRecipe && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Input label={`Cantidad en Stock * ${formData.unitType === 'WEIGHT' ? '(kg)' : formData.unitType === 'VOLUME' ? '(L)' : ''}`} name="quantityStock" type="number" step="0.001" value={formData.quantityStock} onChange={handleChange} required />
          <Input label={`Alerta Stock Mínimo ${formData.unitType === 'WEIGHT' ? '(kg)' : formData.unitType === 'VOLUME' ? '(L)' : '(Opcional)'}`} name="stockMinAlert" type="number" step="0.001" value={formData.stockMinAlert} onChange={handleChange} />
        </div>
      )}

      {isRecipe && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Input label={`Alerta Stock Mínimo (unidades elaboradas)`} name="stockMinAlert" type="number" step="1" value={formData.stockMinAlert} onChange={handleChange} />
          <div className="flex items-end">
            <p className="text-xs text-foreground-muted pb-2.5">Se alerta cuando la disponibilidad derivada (cuántos podés preparar) baja de este mínimo.</p>
          </div>
        </div>
      )}

      <div className="flex justify-end pt-4">
        <Button type="button" variant="outline" onClick={() => router.push('/productos')} className="mr-3" disabled={isLoading}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={isLoading}>
          {isLoading ? <Loader2 size={18} className="animate-spin mr-2" /> : null}
          {isLoading ? loadingButtonText : submitButtonText}
        </Button>
      </div>
    </form>

      <QuickCreateModal
        isOpen={brandQuickCreate.isOpen}
        title="Nueva Marca"
        value={brandQuickCreate.name}
        isLoading={brandQuickCreate.isCreating}
        onChange={brandQuickCreate.setName}
        onSubmit={brandQuickCreate.handleCreate}
        onClose={() => brandQuickCreate.setIsOpen(false)}
      />

      <QuickCreateModal
        isOpen={categoryQuickCreate.isOpen}
        title="Nueva Categoría"
        value={categoryQuickCreate.name}
        isLoading={categoryQuickCreate.isCreating}
        onChange={categoryQuickCreate.setName}
        onSubmit={categoryQuickCreate.handleCreate}
        onClose={() => categoryQuickCreate.setIsOpen(false)}
      />

      {/* Modal Selector de Fotos de Mercado Libre */}
      {isMLModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-background border border-border rounded-xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="font-bold text-base text-foreground flex items-center gap-2">
                🔍 Imágenes Encontradas en Mercado Libre
              </h3>
              <button
                type="button"
                onClick={() => setIsMLModalOpen(false)}
                className="text-foreground-muted hover:text-foreground p-1"
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-foreground-muted">
              Selecciona la foto oficial que quieras usar para <strong className="text-foreground">&quot;{formData.name}&quot;</strong>:
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-80 overflow-y-auto p-1">
              {mlCandidates.map((candidate) => (
                <div
                  key={candidate.id}
                  onClick={() => {
                    setFormData((prev) => ({ ...prev, imageUrl: candidate.imageUrl }));
                    setIsMLModalOpen(false);
                    toast.success("Foto oficial asignada al producto.");
                  }}
                  className="group relative bg-muted/40 border border-border hover:border-primary rounded-lg p-2 flex flex-col items-center justify-between text-center cursor-pointer transition-all hover:shadow-md"
                >
                  <img
                    src={candidate.imageUrl || candidate.thumbnail}
                    alt={candidate.title}
                    className="w-20 h-20 object-contain rounded mb-2 group-hover:scale-105 transition-transform"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).src = candidate.thumbnail;
                    }}
                  />
                  <p className="text-[11px] font-medium text-foreground line-clamp-2 leading-tight">
                    {candidate.title}
                  </p>
                  <span className="mt-2 w-full py-1 text-[10px] font-bold bg-primary/10 text-primary group-hover:bg-primary group-hover:text-white rounded transition-colors">
                    Usar esta foto
                  </span>
                </div>
              ))}
            </div>

            <div className="border-t border-border pt-3 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsMLModalOpen(false)}
              >
                Cancelar
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ProductForm;
