"use client";

import React from "react";
import type { Product } from "@/types";
import Button from "@/components/ui/Button";
import { Edit3, Trash2, EyeOff, Globe, Sliders } from "lucide-react";
import { formatCurrency } from "@/lib/formatCurrency";
import { recipeAvailabilityTooltip } from "@/lib/recipeUnits";

interface ProductTableRowProps {
  product: Product;
  selected: boolean;
  isPro: boolean;
  activeBranchId?: string;
  onToggleSelect: (id: number) => void;
  onToggleWebPublic: (id: number, current: boolean) => void;
  onOpenModifiers: (product: Product) => void;
  onEdit: (id: number) => void;
  onOpenDelete: (product: Product) => void;
}

export function ProductTableRow({
  product,
  selected,
  isPro,
  activeBranchId,
  onToggleSelect,
  onToggleWebPublic,
  onOpenModifiers,
  onEdit,
  onOpenDelete,
}: ProductTableRowProps) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-background transition-colors">
      <td className="py-2.5 px-2 text-center w-8">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(product.id)}
          className="rounded border-border cursor-pointer"
        />
      </td>
      <td
        className="py-2.5 px-2 text-sm text-foreground font-medium max-w-[200px] truncate"
        title={product.name}
      >
        {product.name}
      </td>
      <td
        className="py-2.5 px-2 text-xs text-foreground-muted w-28 truncate"
        title={product.sku || "-"}
      >
        {product.sku || "-"}
      </td>
      <td
        className="py-2.5 px-2 text-xs text-foreground-muted w-28 truncate"
        title={product.brand?.name || "-"}
      >
        {product.brand?.name || "-"}
      </td>
      <td
        className="py-2.5 px-2 text-xs text-foreground-muted w-28 truncate"
        title={product.category?.name || "-"}
      >
        {product.category?.name || "-"}
      </td>
      <td
        className="py-2.5 px-2 text-xs text-foreground-muted w-28 truncate"
        title={product.supplier?.name || "-"}
      >
        {product.supplier?.name || "-"}
      </td>
      <td className="py-2.5 px-2 text-sm text-foreground text-right w-28 font-mono">
        {formatCurrency(product.pricePurchase ?? 0)}
      </td>
      <td className="py-2.5 px-2 text-sm text-foreground font-bold text-right w-28 font-mono">
        {formatCurrency(product.priceSale)}
      </td>
      <td className="py-2.5 px-2 text-sm text-foreground text-center w-36">
        <div className="flex flex-col items-center">
          <span
            className="font-bold text-foreground"
            title={recipeAvailabilityTooltip(product.isRecipe, product.recipeAvailability)}
          >
            {(() => {
              if (activeBranchId) {
                const bs = product.branchStocks?.find(
                  (b: any) => b.branchId === Number(activeBranchId),
                );
                // Sin fila para la sucursal = stock global (legados / autocurado
                // pendiente), nunca 0 fantasma.
                return bs ? bs.quantityStock : product.quantityStock;
              }
              return product.quantityStock;
            })()}
            {product.isRecipe
              ? " por tipo"
              : product.unitType === "WEIGHT"
              ? " kg"
              : product.unitType === "VOLUME"
              ? " L"
              : " u."}
          </span>
        </div>
      </td>
      {isPro && (
        <td className="py-2.5 px-2 text-sm text-center w-28">
          <button
            onClick={() =>
              onToggleWebPublic(product.id, !product.isPublicWeb)
            }
            className={`px-2 py-0.5 rounded-full text-xs font-semibold flex items-center justify-center gap-1 mx-auto transition-colors ${
              product.isPublicWeb
                ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 border border-emerald-300"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200 border border-gray-300"
            }`}
            title="Haz clic para cambiar la visibilidad en ClinStore"
          >
            {product.isPublicWeb ? (
              <>
                <Globe size={12} className="text-emerald-600" /> Publicado
              </>
            ) : (
              <>
                <EyeOff size={12} className="text-gray-500" /> Oculto
              </>
            )}
          </button>
        </td>
      )}
      <td className="py-2.5 px-2 text-sm text-center w-24 whitespace-nowrap">
        <div className="flex items-center justify-center space-x-1">
          {product.isRecipe && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenModifiers(product)}
              title="Personalizar Variantes & Modificadores (Talles, Colores, Agregados)"
              className="h-7 w-7 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/50"
            >
              <Sliders size={15} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(product.id)}
            title="Editar"
            className="h-7 w-7"
          >
            <Edit3 size={15} className="text-primary" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenDelete(product)}
            title="Eliminar"
            className="h-7 w-7"
          >
            <Trash2 size={15} className="text-destructive" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
