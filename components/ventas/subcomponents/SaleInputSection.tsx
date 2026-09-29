import React from "react";
import Input from "@/components/ui/Input";
import { Combo, Product } from "@/types";
import { formatCurrency } from "@/lib/formatCurrency";
import { recipeAvailabilityTooltip } from "@/lib/recipeUnits";

interface SaleInputSectionProps {
  productSearchTerm: string;
  searchedProducts: Product[];
  searchedCombos?: Combo[];
  productInputRef: React.RefObject<HTMLInputElement | null>;
  handleProductSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleProductKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleSelectProduct: (product: Product) => void;
  handleSelectCombo?: (combo: Combo) => void;
}

export const SaleInputSection: React.FC<SaleInputSectionProps> = ({
  productSearchTerm,
  searchedProducts,
  searchedCombos = [],
  productInputRef,
  handleProductSearchChange,
  handleProductKeyDown,
  handleSelectProduct,
  handleSelectCombo,
}) => {
  const showDropdown = searchedProducts.length > 0 || searchedCombos.length > 0;
  const comboPriceOf = (combo: Combo) => {
    const raw = (combo as any).price ?? (combo as any).priceSale ?? 0;
    return typeof raw === "number" ? raw : parseFloat(String(raw).replace(",", ".")) || 0;
  };
  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          ref={productInputRef}
          label="Búsqueda de Producto / Combo / Código de barras"
          type="text"
          placeholder="Escanea o escribe nombre/SKU/combo..."
          value={productSearchTerm}
          onChange={handleProductSearchChange}
          onKeyDown={handleProductKeyDown}
          autoComplete="off"
          className="w-full text-sm rounded-xl h-10 border-border"
        />

        {/* Autocomplete Dropdown list (productos + combos) */}
        {showDropdown && (
          <ul className="absolute z-30 w-full bg-background border border-border rounded-xl shadow-xl max-h-72 overflow-y-auto mt-1 border-collapse">
            {searchedCombos.map((combo) => (
              <li
                key={`combo-${combo.id}`}
                onClick={() => handleSelectCombo?.(combo)}
                className="px-4 py-2.5 hover:bg-amber-500/10 cursor-pointer border-b border-border last:border-b-0 flex items-center justify-between text-sm transition-colors"
              >
                <div className="min-w-0 mr-4">
                  <p className="font-bold text-foreground truncate">
                    {combo.name}{" "}
                    <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-extrabold bg-amber-500/15 text-amber-700 border border-amber-400/40 align-middle">
                      COMBO
                    </span>
                  </p>
                  {combo.items && (
                    <p className="text-[10px] text-foreground-muted truncate mt-0.5">
                      {combo.items
                        .map(
                          (i) =>
                            `${i.quantity}x ${i.product?.name || `#${i.productId}`}`,
                        )
                        .join(", ")}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="font-extrabold text-amber-700">
                    {formatCurrency(comboPriceOf(combo))}
                  </p>
                </div>
              </li>
            ))}
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
