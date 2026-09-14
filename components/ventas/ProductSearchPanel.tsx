"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { XCircle, Package, ShoppingBag } from "lucide-react";
import { formatCurrency } from "@/lib/formatCurrency";
import type { Product, Combo } from "@/types";

interface ProductSearchPanelProps {
  productSearchTerm: string;
  searchedProducts: Product[];
  combos: Combo[];
  recentProducts: Product[];
  currentItem: {
    productId: string;
    productName: string;
    quantity: number | "";
    priceAtSale: number | "";
    availableStock: number;
    unitType?: string | null;
  };
  productInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSelectProduct: (product: Product) => void;
  onSelectCombo: (combo: Combo) => void;
  onCurrentItemFieldChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAddItem: () => void;
  onClearCurrentItem: () => void;
}

const ProductSearchPanel: React.FC<ProductSearchPanelProps> = ({
  productSearchTerm,
  searchedProducts,
  combos,
  recentProducts,
  currentItem,
  productInputRef,
  onSearchChange,
  onKeyDown,
  onSelectProduct,
  onSelectCombo,
  onCurrentItemFieldChange,
  onAddItem,
  onClearCurrentItem,
}) => {
  const router = useRouter();
  return (
  <fieldset className="border border-border p-4 rounded-md">
    <legend className="text-lg font-medium text-primary px-2">Producto</legend>
    <div className="relative mb-2">
      <Input
        ref={productInputRef}
        type="text"
        placeholder="Buscar producto por nombre o SKU... (código de barras automático)"
        value={productSearchTerm}
        onChange={onSearchChange}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />
      <p className="text-[10px] text-foreground-muted/60 mt-1">
        <kbd className="px-1 py-0.5 rounded bg-background border border-border font-mono text-[9px]">
          F8
        </kbd>{" "}
        buscar &middot;
        <kbd className="px-1 py-0.5 rounded bg-background border border-border font-mono text-[9px] ml-1">
          Esc
        </kbd>{" "}
        limpiar &middot; código de barras automático
      </p>
      {combos.length > 0 &&
        !productSearchTerm &&
        searchedProducts.length === 0 && (
          <div className="mt-2 mb-1">
            <p className="text-[10px] text-foreground-muted/70 mb-1.5 flex items-center gap-1">
              <ShoppingBag size={10} /> Combos disponibles
            </p>
            <div className="flex flex-wrap gap-1.5">
              {combos.map((combo) => (
                <motion.button
                  key={combo.id}
                  type="button"
                  whileHover={{ scale: 1.03, y: -1 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => onSelectCombo(combo)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border border-amber-400/40 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors cursor-pointer"
                >
                  <ShoppingBag size={12} /> {combo.name}{" "}
                  <span className="text-[10px] text-amber-500/70">
                    {formatCurrency(combo.price)}
                  </span>
                </motion.button>
              ))}
            </div>
          </div>
        )}
      {recentProducts.length > 0 &&
        !productSearchTerm &&
        searchedProducts.length === 0 && (
          <div className="mt-2 mb-1">
            <p className="text-[10px] text-foreground-muted/70 mb-1.5 flex items-center gap-1">
              <Package size={10} /> Últimos vendidos
            </p>
            <div className="flex flex-wrap gap-1.5">
              {recentProducts.map((p) => (
                <motion.button
                  key={p.id}
                  type="button"
                  whileHover={{ scale: 1.03, y: -1 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() =>
                    p.quantityStock <= 0
                      ? router.push(`/compras/nueva?productId=${p.id}`)
                      : onSelectProduct(p)
                  }
                  title={p.quantityStock <= 0 ? "Sin stock — click para reponer en Compras" : undefined}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors cursor-pointer ${p.quantityStock <= 0 ? "border-destructive/40 text-destructive hover:bg-destructive/10" : "border-primary/30 text-primary hover:bg-primary/10"}`}
                >
                  {p.isRecipe && (
                    <span title="Producto elaborado" className="text-[10px]">🧾</span>
                  )}
                  {p.name}{" "}
                  <span
                    className={`text-[10px] ${p.quantityStock <= 0 ? "text-destructive/70" : "text-primary/70"}`}
                  >
                    {formatCurrency(p.priceSale)}
                    <span className="text-[9px] opacity-60">
                      /
                      {p.unitType === "WEIGHT"
                        ? "kg"
                        : p.unitType === "VOLUME"
                          ? "L"
                          : "u."}
                    </span>
                  </span>
                </motion.button>
              ))}
            </div>
          </div>
        )}
      {searchedProducts.length > 0 && (
        <ul className="absolute z-10 w-full bg-background border border-border rounded-md shadow-lg max-h-72 overflow-y-auto mt-1">
          {searchedProducts.map((product) => (
            <li
              key={product.id}
              onClick={() => onSelectProduct(product)}
              className="px-4 py-3 hover:bg-muted cursor-pointer border-b border-border last:border-b-0"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1 mr-4">
                  <p className="font-medium text-sm text-foreground truncate">
                    {product.isRecipe && (
                      <span title="Producto elaborado" className="mr-1">🧾</span>
                    )}
                    {product.name}
                  </p>
                  <p className="text-[11px] text-foreground-muted truncate">
                    {product.sku && <>SKU: {product.sku} &middot; </>}[
                    {product.unitType === "WEIGHT"
                      ? "kg"
                      : product.unitType === "VOLUME"
                        ? "L"
                        : "unidad"}
                    ]
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-lg font-bold text-primary">
                    {formatCurrency(product.priceSale)}
                    <span className="text-xs text-foreground-muted font-normal ml-0.5">
                      /
                      {product.unitType === "WEIGHT"
                        ? "kg"
                        : product.unitType === "VOLUME"
                          ? "L"
                          : "u."}
                    </span>
                  </p>
                  <span
                    className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-medium ${product.quantityStock <= 0 ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}
                  >
                    Stock: {product.quantityStock}
                    {product.unitType === "WEIGHT"
                      ? " kg"
                      : product.unitType === "VOLUME"
                        ? " L"
                        : ""}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
    <AnimatePresence>
      {currentItem.productId && (
        <motion.div
          initial={{ opacity: 0, y: -10, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: -10, height: 0 }}
          transition={{ duration: 0.2 }}
          className="mt-4 p-4 border border-primary/50 rounded-md bg-primary/5 space-y-3 relative overflow-hidden"
        >
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-medium text-foreground">
              Añadir: {currentItem.productName}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClearCurrentItem}
              title="Cancelar selección"
              className="absolute top-2 right-2 p-1 h-auto w-auto"
            >
              <XCircle
                size={20}
                className="text-destructive hover:text-destructive/80"
              />
            </Button>
          </div>
          <p className="text-xs text-foreground-muted">
            Stock Disponible: {currentItem.availableStock}
            {currentItem.unitType === "WEIGHT"
              ? " kg"
              : currentItem.unitType === "VOLUME"
                ? " L"
                : ""}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
            <Input
              label={`Cantidad${currentItem.unitType === "WEIGHT" ? " (kg)" : currentItem.unitType === "VOLUME" ? " (L)" : ""} *`}
              type="number"
              name="quantity"
              value={String(currentItem.quantity)}
              onChange={onCurrentItemFieldChange}
              min="0"
              step={
                currentItem.unitType && currentItem.unitType !== "UNIT"
                  ? "any"
                  : "1"
              }
              required
              className="h-10"
            />
            <Input
              label={`Precio${currentItem.unitType === "WEIGHT" ? " por kg" : currentItem.unitType === "VOLUME" ? " por L" : " Venta (u.)"} *`}
              type="number"
              name="priceAtSale"
              value={String(currentItem.priceAtSale)}
              onChange={onCurrentItemFieldChange}
              step="0.01"
              min="0"
              required
              className="h-10"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={onAddItem}
              className="h-10"
            >
              Añadir a Venta
            </Button>
          </div>
          <p className="text-[10px] text-foreground-muted/60 mt-2">
            <kbd className="px-1 py-0.5 rounded bg-background border border-border font-mono text-[9px]">
              Enter
            </kbd>{" "}
            añadir &middot;
            <kbd className="px-1 py-0.5 rounded bg-background border border-border font-mono text-[9px] ml-1">
              Ctrl+Enter
            </kbd>{" "}
            finalizar venta
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  </fieldset>
  );
};

export default ProductSearchPanel;
