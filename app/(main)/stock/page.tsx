"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Barcode, Search, Save, Package } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatCurrency } from '@/lib/formatCurrency';

export default function StockPage() {
  const [barcode, setBarcode] = useState('');
  const [product, setProduct] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [newStock, setNewStock] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [found, setFound] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sucursal activa de este equipo (la misma que usa la pantalla de venta).
  const activeBranchId =
    typeof window !== 'undefined' ? localStorage.getItem('clinpos_active_branch_id') : null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSearch = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;

    setLoading(true);
    setFound(null);
    setProduct(null);
    setNewStock('');

    try {
      const res = await fetch(
        `/api/products?kind=all&search=${encodeURIComponent(trimmed)}${activeBranchId ? `&branchId=${activeBranchId}` : ''}`,
      );
      if (!res.ok) throw new Error('Error al buscar');

      const data = await res.json();
      const items = Array.isArray(data) ? data : data.data || [];
      const p = items.find((x: any) => x.sku === trimmed) || items[0];

      if (p) {
        // Stock de la sucursal activa (si existe); si no, el global.
        const branchRow = activeBranchId && Array.isArray(p.branchStocks)
          ? p.branchStocks.find((b: any) => String(b.branchId) === String(activeBranchId))
          : null;
        const parsed = {
          ...p,
          priceSale: parseFloat(p.priceSale),
          pricePurchase: p.pricePurchase ? parseFloat(p.pricePurchase) : null,
          // parseFloat: productos por kg/litro tienen decimales (parseInt los truncaba).
          quantityStock: parseFloat(String(branchRow ? branchRow.quantityStock : p.quantityStock)) || 0,
        };
        setProduct(parsed);
        setNewStock(parsed.quantityStock);
        setFound(true);
        toast.success(`Producto encontrado: ${parsed.name}`);
      } else {
        setFound(false);
        toast.error('Producto no encontrado.');
      }
    } catch {
      setFound(false);
      toast.error('Error al buscar producto.');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch(barcode);
    }
  };

  const handleSave = async () => {
    if (!product || newStock === '' || isNaN(Number(newStock))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantityStock: Number(newStock),
          ...(activeBranchId ? { branchId: Number(activeBranchId) } : {}),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Error al guardar');
      }
      toast.success(`Stock de "${product.name}" actualizado a ${newStock}`);
      setProduct(null);
      setBarcode('');
      setFound(null);
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (err: any) {
      toast.error(err?.message || 'Error al guardar el stock.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      <div className="text-center mb-6">
        <Package size={40} className="mx-auto text-primary mb-2" />
        <h1 className="text-2xl font-bold text-foreground">Carga de Stock</h1>
        <p className="text-sm text-foreground-muted mt-1">
          Escaneá el código de barras o ingresá el SKU
        </p>
      </div>

      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          autoComplete="off"
          placeholder="Escanear código de barras..."
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full h-14 text-xl text-center bg-background border-2 border-primary/50 rounded-xl px-4 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-foreground-muted/40"
        />
        {loading && (
          <Loader2 size={24} className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-primary" />
        )}
        {!loading && barcode && (
          <button
            onClick={() => handleSearch(barcode)}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-primary hover:text-primary/80"
          >
            <Search size={22} />
          </button>
        )}
      </div>

      <p className="text-xs text-foreground-muted/60 mt-2 text-center">
        Presioná <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono text-[10px]">Enter</kbd> para buscar
      </p>

      {found === false && (
        <div className="mt-6 p-4 bg-destructive/5 border border-destructive/30 rounded-xl text-center">
          <p className="text-destructive font-medium">Producto no encontrado</p>
          <p className="text-sm text-foreground-muted mt-1">Verificá que el código sea correcto.</p>
        </div>
      )}

      {product && (
        <div className="mt-6 bg-muted border border-border rounded-xl p-5 space-y-4">
          <div>
            <h2 className="text-xl font-bold text-foreground">{product.name}</h2>
            {product.sku && <p className="text-sm text-foreground-muted">SKU: {product.sku}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-background rounded-lg p-3">
              <p className="text-foreground-muted text-xs">Precio Venta</p>
              <p className="font-bold text-lg text-primary">{formatCurrency(product.priceSale)}</p>
            </div>
            <div className="bg-background rounded-lg p-3">
              <p className="text-foreground-muted text-xs">Stock Actual</p>
              <p className={`font-bold text-lg ${product.quantityStock <= 0 ? 'text-destructive' : 'text-success'}`}>
                {product.quantityStock}
              </p>
            </div>
          </div>

          {product.brand && (
            <div className="flex gap-2 text-xs text-foreground-muted flex-wrap">
              <span className="px-2 py-0.5 bg-background rounded">{product.brand?.name}</span>
              {product.category && <span className="px-2 py-0.5 bg-background rounded">{product.category.name}</span>}
              {product.supplier && <span className="px-2 py-0.5 bg-background rounded">{product.supplier.name}</span>}
              {product.stockMinAlert !== null && product.stockMinAlert !== undefined && (
                <span className="px-2 py-0.5 bg-background rounded border border-warning/30 text-warning">
                  Mín: {product.stockMinAlert}
                </span>
              )}
            </div>
          )}

          {product.isRecipe ? (
            <div className="p-4 bg-amber-50/60 dark:bg-amber-950/20 border border-amber-300/50 dark:border-amber-800 rounded-xl">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                🧾 Producto elaborado (Recetario)
              </p>
              <p className="text-xs text-foreground-muted mt-1">
                El stock se calcula automáticamente desde los ingredientes. Para aumentar la
                disponibilidad, cargá stock a los ingredientes (este producto o vía Compras).
              </p>
              <p className="text-xs font-semibold text-foreground mt-2">
                Disponibilidad actual: {product.quantityStock} por tipo (según ingredientes)
              </p>
              {Array.isArray(product.recipeAvailability?.limiting) &&
                product.recipeAvailability.limiting.length > 0 && (
                  <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mt-1">
                    Limitado por:{" "}
                    {product.recipeAvailability.limiting
                      .map((l: any) => `${l.name}: ${l.availableDisplay}`)
                      .join(", ")}
                    . El número no se suma entre variantes que comparten ingredientes.
                  </p>
                )}
            </div>
          ) : (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">Nuevo Stock</label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setNewStock(prev => Math.max(0, (prev === '' ? 0 : prev) - 1))}
                  className="w-14 h-14 bg-background border-2 border-border rounded-xl text-2xl font-bold text-foreground hover:bg-muted transition-colors flex items-center justify-center"
                >
                  −
                </button>
                <input
                  type="tel"
                  inputMode="numeric"
                  min="0"
                  value={newStock}
                  onChange={(e) => setNewStock(e.target.value === '' ? '' : parseInt(e.target.value))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } }}
                  autoFocus
                  className="flex-1 h-14 text-2xl text-center bg-background border-2 border-border rounded-xl px-4 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setNewStock(prev => (prev === '' ? 1 : prev + 1))}
                  className="w-14 h-14 bg-background border-2 border-border rounded-xl text-2xl font-bold text-foreground hover:bg-muted transition-colors flex items-center justify-center"
                >
                  +
                </button>
              </div>
            </div>
          )}

          {!product.isRecipe && (
            <button
              onClick={handleSave}
              disabled={saving || newStock === ''}
              className="w-full h-12 bg-primary text-primary-foreground font-semibold rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-primary/90 transition-colors"
            >
              {saving ? <Loader2 size={20} className="animate-spin" /> : <Save size={20} />}
              {saving ? 'Guardando...' : 'Guardar Stock'}
            </button>
          )}

          {!product.isRecipe && (
            <p className="text-[10px] text-foreground-muted/60 text-center">
              <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono text-[9px]">Enter</kbd> en el campo de stock para guardar rápido
            </p>
          )}
        </div>
      )}

      {!product && found !== false && (
        <div className="mt-12 text-center">
          <Barcode size={48} className="mx-auto text-foreground-muted/30 mb-3" />
          <p className="text-foreground-muted/50 text-sm">
            Escaneá o escribí un código de barras para empezar
          </p>
        </div>
      )}
    </div>
  );
}
