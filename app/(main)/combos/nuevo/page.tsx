"use client";

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Product } from '@/types';
import { Loader2, ArrowLeft, X, Search, Info } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { debounce } from '@/lib/utils';
import { formatCurrency } from '@/lib/formatCurrency';
import { optimizeImage } from '@/lib/imageOptimizer';
import toast from 'react-hot-toast';

const unitLabel = (unitType?: Product['unitType']) =>
  unitType === 'WEIGHT' ? 'kg' : unitType === 'VOLUME' ? 'L' : 'unidad';

const NuevoComboPage = () => {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [pricingMode, setPricingMode] = useState<'fixed' | 'percentage'>('fixed');
  const [fixedPrice, setFixedPrice] = useState('');
  const [discountPercent, setDiscountPercent] = useState('');
  const [items, setItems] = useState<{ productId: number; productName: string; unitType?: Product['unitType']; quantity: number; defaultPrice: number; customPrice: string }[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const searchProducts = useMemo(
    () =>
      debounce(async (term: string) => {
        if (!term.trim()) { setSearchResults([]); return; }
        setSearching(true);
        try {
          const res = await fetch(`/api/products?search=${encodeURIComponent(term)}&limit=10`);
          if (res.ok) {
            const data = await res.json();
            setSearchResults((data.products || data).map((p: any) => ({
              ...p,
              priceSale: parseFloat(p.priceSale),
            })).slice(0, 10));
          }
        } catch { /* ignore */ }
        finally { setSearching(false); }
      }, 300),
    []
  );

  useEffect(() => { searchProducts(searchTerm); }, [searchTerm, searchProducts]);

  const handleLocalImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
        setImageUrl(cloudData.url);
        toast.success('Imagen subida a Cloudinary exitosamente.', { id: toastId });
      } else {
        toast.error(`No se pudo subir la imagen: ${cloudData.message || 'error de Cloudinary'}. Intentá de nuevo.`, { id: toastId });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'error desconocido';
      toast.error(`No se pudo procesar la imagen: ${msg}. Intentá de nuevo.`, { id: toastId });
    }
  };

  const addItem = (product: Product) => {
    if (items.some(i => i.productId === product.id)) {
      toast.error(`"${product.name}" ya está incluido en el combo.`);
      return;
    }
    setItems([...items, {
      productId: product.id,
      productName: product.name,
      unitType: product.unitType,
      quantity: product.unitType === 'UNIT' || !product.unitType ? 1 : 0.1,
      defaultPrice: product.priceSale,
      customPrice: '',
    }]);
    setSearchTerm('');
    setSearchResults([]);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const handleProductSearchKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.code !== 'NumpadEnter') return;
    e.preventDefault();
    const term = e.currentTarget.value.trim();
    if (!term) return;

    const normalized = term.toLocaleLowerCase();
    const exact = searchResults.find(p => p.sku?.trim().toLocaleLowerCase() === normalized);
    const visible = exact || searchResults[0];
    if (visible) {
      addItem(visible);
      return;
    }

    setSearching(true);
    try {
      const res = await fetch(`/api/products?search=${encodeURIComponent(term)}&limit=10`);
      const data = res.ok ? await res.json() : [];
      const products: Product[] = (data.products || data).map((p: any) => ({ ...p, priceSale: parseFloat(p.priceSale) })).slice(0, 10);
      const exactProduct = products.find(p => p.sku?.trim().toLocaleLowerCase() === normalized);
      if (exactProduct || products.length === 1) addItem(exactProduct || products[0]);
      else if (products.length === 0) toast.error(`No se encontró un producto para "${term}".`);
      else toast.error('Hay varios resultados. Elegí un producto de la lista.');
    } catch {
      toast.error('No se pudo buscar el producto.');
    } finally {
      setSearching(false);
    }
  };

  const removeItem = (productId: number) => setItems(items.filter(i => i.productId !== productId));

  const updateItem = (productId: number, field: 'quantity' | 'customPrice', value: string) => {
    setItems(items.map(i => i.productId === productId ? { ...i, [field]: value } : i));
  };

  const totalFullPrice = items.reduce((sum, i) => {
    const unitPrice = i.customPrice ? parseFloat(i.customPrice) : i.defaultPrice;
    return sum + (unitPrice || 0) * (Number(i.quantity) || 0);
  }, 0);

  const effectivePrice = pricingMode === 'fixed'
    ? (parseFloat(fixedPrice) || 0)
    : totalFullPrice * (1 - (parseFloat(discountPercent) || 0) / 100);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) { setError('El nombre es obligatorio.'); return; }
    if (items.length === 0) { setError('Agregá al menos un producto.'); return; }
    if (effectivePrice <= 0) { setError('El precio del combo debe ser un número positivo.'); return; }

    setSaving(true);
    try {
      const res = await fetch('/api/combos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          price: effectivePrice,
          imageUrl: imageUrl || null,
          items: items.map(i => ({
            productId: i.productId,
            quantity: Number(i.quantity) || 1,
            customPrice: i.customPrice ? parseFloat(i.customPrice) : null,
          })),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Error al crear combo');
      }
      router.push('/combos');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <Button variant="outline" size="sm" onClick={() => router.back()} className="mb-4">
        <ArrowLeft size={16} className="mr-2" /> Volver
      </Button>

      <h1 className="text-2xl font-bold text-foreground mb-6">Nuevo Combo</h1>

      <form onSubmit={handleSubmit} className="bg-muted p-6 rounded-xl shadow-lg space-y-4">
        {error && <p className="text-sm text-destructive bg-destructive/10 p-3 rounded">{error}</p>}

        <Input label="Nombre del Combo *" placeholder="Ej. Promo Hamburguesa + Bebida" value={name} onChange={e => setName(e.target.value)} required />
        <Input label="Descripción (Opcional)" placeholder="Detalle extra que verá el cliente..." value={description} onChange={e => setDescription(e.target.value)} />

        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground">Imagen del Combo</label>
          <div className="flex items-center gap-3">
            {imageUrl && (
              <img src={imageUrl} alt="Preview" className="w-16 h-16 object-cover rounded-md border border-border bg-background" />
            )}
            <div className="flex-1 space-y-2">
              <Input
                placeholder="Pegar URL de la imagen o subir archivo..."
                value={imageUrl}
                onChange={e => setImageUrl(e.target.value)}
              />
              <label className="cursor-pointer inline-flex items-center text-sm text-primary hover:underline">
                <input type="file" accept="image/*" className="hidden" onChange={handleLocalImageUpload} />
                O subir desde tu PC
              </label>
            </div>
          </div>
        </div>

        <div className="border border-border rounded-md p-4 space-y-3">
          <label className="text-sm font-medium text-foreground">Precio del Combo</label>

          <div className="flex gap-2">
            <button type="button" onClick={() => setPricingMode('fixed')}
              className={`flex-1 py-2 text-sm rounded-md font-medium transition-colors ${pricingMode === 'fixed' ? 'bg-primary text-primary-foreground' : 'bg-background border border-border text-foreground-muted'}`}>
              Precio fijo
            </button>
            <button type="button" onClick={() => setPricingMode('percentage')}
              className={`flex-1 py-2 text-sm rounded-md font-medium transition-colors ${pricingMode === 'percentage' ? 'bg-primary text-primary-foreground' : 'bg-background border border-border text-foreground-muted'}`}>
              % de descuento
            </button>
          </div>

          {pricingMode === 'fixed' ? (
            <Input type="number" step="0.01" min="0" value={fixedPrice} onChange={e => setFixedPrice(e.target.value)}
              placeholder="Ej: 500" />
          ) : (
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Input type="number" step="0.1" min="0" max="100" value={discountPercent} onChange={e => setDiscountPercent(e.target.value)}
                  placeholder="Ej: 20" />
              </div>
              {totalFullPrice > 0 && (
                <p className="text-sm text-foreground-muted pb-2">
                  = {formatCurrency(effectivePrice)}
                </p>
              )}
            </div>
          )}

          {items.length > 0 && (
            <div className="flex items-center gap-2 text-sm bg-background p-2 rounded border border-border">
              <Info size={14} className="text-primary" />
              <span className="text-foreground-muted">Suma de productos:</span>
              <span className="font-semibold text-foreground">{formatCurrency(totalFullPrice)}</span>
              {effectivePrice > 0 && effectivePrice < totalFullPrice && (
                <span className="text-success text-xs">({Math.round((1 - effectivePrice / totalFullPrice) * 100)}% ahorro)</span>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Productos</label>
          <div className="relative mb-3">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Escaneá un SKU o buscá por nombre..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onKeyDown={handleProductSearchKeyDown}
              autoComplete="off"
              className="w-full pl-10 pr-4 py-2 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {searching && <Loader2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-foreground-muted" />}
          </div>

          {searchResults.length > 0 && (
            <div className="mb-3 border border-border rounded-md bg-background max-h-40 overflow-y-auto">
              {searchResults.map(p => (
                <button key={p.id} type="button" onClick={() => addItem(p)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex justify-between">
                  <span>{p.name} <small className="text-foreground-muted">({unitLabel(p.unitType)}{p.sku ? ` · SKU ${p.sku}` : ''})</small></span>
                  <span className="text-foreground-muted">{formatCurrency(p.priceSale)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {items.length === 0 && <p className="text-sm text-foreground-muted">No hay productos agregados.</p>}
            {items.map(item => (
              <div key={item.productId} className="flex items-center gap-2 bg-background p-2 rounded-md border border-border">
                <span className="flex-1 text-sm font-medium">
                  {item.productName}
                  <span className="text-foreground-muted text-xs ml-1">({formatCurrency(item.defaultPrice)} / {unitLabel(item.unitType)})</span>
                </span>
                <span className="text-[10px] font-semibold text-primary bg-primary/10 rounded px-1.5 py-1">{unitLabel(item.unitType)}</span>
                <input type="number" min={item.unitType === 'UNIT' || !item.unitType ? '1' : '0.001'} step={item.unitType === 'UNIT' || !item.unitType ? '1' : '0.001'} value={item.quantity} onChange={e => updateItem(item.productId, 'quantity', e.target.value)}
                  className="w-16 text-center text-sm rounded border border-border bg-background p-1" title="Cantidad" />
                <input type="number" step="0.01" min="0" value={item.customPrice}
                  onChange={e => updateItem(item.productId, 'customPrice', e.target.value)}
                  className="w-24 text-sm rounded border border-border bg-background p-1" placeholder="Precio (opc)" title="Precio personalizado en el combo" />
                <button type="button" onClick={() => removeItem(item.productId)} className="text-destructive hover:text-destructive/80">
                  <X size={18} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <Button variant="primary" type="submit" disabled={saving} className="w-full">
          {saving ? 'Guardando...' : `Guardar Combo (${formatCurrency(effectivePrice)})`}
        </Button>
      </form>
    </div>
  );
};

export default NuevoComboPage;
