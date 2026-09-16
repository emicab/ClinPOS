import React from "react";
import Input from "@/components/ui/Input";
import { Product } from "@/types";
import { formatCurrency } from "@/lib/formatCurrency";
import { recipeAvailabilityTooltip } from "@/lib/recipeUnits";

interface SaleInputSectionProps {
  productSearchTerm: string;
  searchedProducts: Product[];
  productInputRef: React.RefObject<HTMLInputElement | null>;
  handleProductSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleProductKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleSelectProduct: (product: Product) => void;
}

export const SaleInputSection: React.FC<SaleInputSectionProps> = ({
  productSearchTerm,
  searchedProducts,
  productInputRef,
  handleProductSearchChange,
  handleProductKeyDown,
  handleSelectProduct,
}) => {
  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          ref={productInputRef}
          label="Búsqueda de Producto / Código de barras"
          type="text"
          placeholder="Escanea o escribe nombre/SKU..."
          value={productSearchTerm}
          onChange={handleProductSearchChange}
          onKeyDown={handleProductKeyDown}
          autoComplete="off"
          className="w-full text-sm rounded-xl h-10 border-border"
        />

        {/* Autocomplete Dropdown list */}
        {searchedProducts.length > 0 && (
          <ul className="absolute z-30 w-full bg-background border border-border rounded-xl shadow-xl max-h-72 overflow-y-auto mt-1 border-collapse">
            {searchedProducts.map((product) => (
              <li
                key={product.id}
                onClick={() => handleSelectProduct(product)}
                className="px-4 py-2.5 hover:bg-muted cursor-pointer border-b border-border last:border-b-0 flex items-center justify-between text-sm transition-colors"
              >
                <div className="min-w-0 mr-4">
                  <p className="font-bold text-foreground truncate">{product.name}</p>
                  {product.sku && (
                    <p className="text-[10px] text-foreground-muted truncate mt-0.5">
                      SKU: {product.sku}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="font-extrabold text-primary">{formatCurrency(product.priceSale)}</p>
                  <p
                    className={`text-[10px] font-bold mt-0.5 ${
                      product.quantityStock <= 0
                        ? "text-red-500"
                        : "text-emerald-600"
                    }`}
                    title={recipeAvailabilityTooltip(product.isRecipe, product.recipeAvailability)}
                  >
                    {product.isRecipe
                      ? `Stock: ${product.quantityStock} por tipo`
                      : `Stock: ${product.quantityStock}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[9px] text-foreground-muted/60 pl-1 pt-2">
        <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border font-mono text-[9px] mr-1 shadow-sm">
          F8
        </kbd>{" "}
        buscar &middot;
        <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border font-mono text-[9px] mx-1 shadow-sm">
          Esc
        </kbd>{" "}
        limpiar &middot;
        <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border font-mono text-[9px] mx-1 shadow-sm">
          Enter
        </kbd>{" "}
        agregar producto
      </p>
    </div>
  );
};

export default SaleInputSection;
