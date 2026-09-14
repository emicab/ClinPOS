import React from "react";
import { useRouter } from "next/navigation";
import { Package, Loader2, Plus } from "lucide-react";
import { Product } from "@/types";
import { formatCurrency } from "@/lib/formatCurrency";
import { recipeAvailabilityTooltip } from "@/lib/recipeUnits";

interface SaleQuickAccessProps {
  isLoadingCategoryProducts: boolean;
  recentProducts: Product[];
  categoryProducts: Product[];
  handleSelectProduct: (product: Product) => void;
}

export const SaleQuickAccess: React.FC<SaleQuickAccessProps> = ({
  isLoadingCategoryProducts,
  recentProducts,
  categoryProducts,
  handleSelectProduct,
}) => {
  const router = useRouter();
  const displayProducts = recentProducts.length > 0 ? recentProducts : categoryProducts;

  return (
    <div className="bg-white border border-border p-5 rounded-2xl shadow-sm space-y-4">
      <h3 className="text-xs font-bold text-foreground flex items-center gap-1.5 uppercase pb-1 border-b border-border/50">
        <Package size={14} className="text-primary" /> Últimos Vendidos
      </h3>

      {/* Grid de Productos Rápidos */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-2 max-h-[360px] overflow-y-auto p-0.5">
        {isLoadingCategoryProducts && recentProducts.length === 0 ? (
          <div className="col-span-full flex items-center justify-center py-10">
            <Loader2 size={20} className="animate-spin text-primary mr-2" />
            <span className="text-xs text-foreground-muted">Cargando catálogo...</span>
          </div>
        ) : displayProducts.length === 0 ? (
          <div className="col-span-full text-center py-10 text-xs text-foreground-muted">
            No hay productos registrados o vendidos recientemente.
          </div>
        ) : (
          displayProducts.slice(0, 24).map((prod) => {
            const reservedQuantity = (prod as any).reservedQuantity || 0;
            const availableStock = prod.quantityStock - reservedQuantity;
            const isOutOfStock = prod.quantityStock <= 0;
            const isReservedOut = !isOutOfStock && availableStock <= 0;
            const recipeTitle = recipeAvailabilityTooltip(prod.isRecipe, prod.recipeAvailability);
            const title = [recipeTitle, isReservedOut ? `Producto reservado en pedido guardado (${reservedQuantity} u.)` : ""]
              .filter(Boolean)
              .join(" | ") || undefined;

            // Sin stock no se puede vender (el servidor lo rebotaría): el click
            // lleva a reponer en Compras con el producto preseleccionado.
            const goReplenish = () => router.push(`/compras/nueva?productId=${prod.id}`);
            return (
              <button
                key={prod.id}
                type="button"
                onClick={() => (isOutOfStock ? goReplenish() : handleSelectProduct(prod))}
                title={isOutOfStock ? "Sin stock — click para reponer en Compras" : title}
                className={`flex flex-col justify-between p-2.5 rounded-xl text-left shadow-sm hover:shadow-md transition-all active:scale-[0.96] cursor-pointer min-h-[85px] border ${
                  isOutOfStock
                    ? "bg-red-50/40 hover:bg-red-100/30 border-red-200 hover:border-red-300/80 opacity-80"
                    : isReservedOut
                    ? "bg-amber-50/40 hover:bg-amber-100/30 border-amber-200 hover:border-amber-300/80"
                    : "bg-muted hover:bg-white border-transparent hover:border-primary/50"
                }`}
              >
                <span
                  className={`text-[10px] font-bold line-clamp-2 leading-tight ${
                    isOutOfStock ? "text-foreground-muted" : "text-foreground"
                  }`}
                >
                  {prod.name}
                </span>
                <span
                  className={`text-xs font-extrabold mt-1.5 flex items-center justify-between w-full ${
                    isOutOfStock ? "text-red-500" : isReservedOut ? "text-amber-600" : "text-primary"
                  }`}
                >
                  <span>{formatCurrency(prod.priceSale)}</span>
                  {isOutOfStock ? (
                    <span className="text-[8px] font-bold text-red-500 bg-red-100/60 px-1.5 py-0.5 rounded-md uppercase tracking-wider shrink-0">
                      Sin Stock
                    </span>
                  ) : isReservedOut ? (
                    <span className="text-[8px] font-bold text-amber-600 bg-amber-100/60 px-1.5 py-0.5 rounded-md uppercase tracking-wider shrink-0" title="Reservado en pedidos guardados">
                      Reservado
                    </span>
                  ) : (
                    <span className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center text-primary hover:bg-primary hover:text-white transition-colors">
                      <Plus size={12} />
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SaleQuickAccess;
