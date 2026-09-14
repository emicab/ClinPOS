import React, { useState, useEffect, useRef } from "react";
import { ShoppingCart, Trash2 } from "lucide-react";
import { SaleItemInCart } from "@/types";
import { formatCurrency } from "@/lib/formatCurrency";

interface QuantityInputProps {
  item: SaleItemInCart;
  onChange: (tempId: number, field: "quantity", value: string) => void;
  invalid?: boolean;
}

const QuantityInput: React.FC<QuantityInputProps> = ({ item, onChange, invalid }) => {
  const [localValue, setLocalValue] = useState(String(item.quantity));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setLocalValue(String(item.quantity));
    }
  }, [item.quantity]);

  const handleChange = (val: string) => {
    const normalized = val.replace(",", ".");
    if (val === "" || /^[0-9]*\.?[0-9]*$/.test(normalized)) {
      setLocalValue(val);
      onChange(item.tempId, "quantity", val);
    }
  };

  const handleBlur = () => {
    setLocalValue(String(item.quantity));
  };

  return (
    <input
      ref={inputRef}
      id={`qty-input-${item.tempId}`}
      type="text"
      inputMode="decimal"
      value={localValue}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={handleBlur}
      className={`w-16 text-center border rounded-lg px-2 py-1 text-sm bg-background focus:outline-none focus:ring-1 font-mono font-medium ${
        invalid
          ? "border-destructive ring-1 ring-destructive/50 text-destructive"
          : "border-border focus:ring-primary"
      }`}
    />
  );
};

interface SaleCartTableProps {
  items: SaleItemInCart[];
  handleItemDetailChange: (tempId: number, field: "quantity" | "priceAtSale", value: string) => void;
  handleRemoveItem: (tempId: number) => void;
  clearCart: () => void;
}

export const SaleCartTable: React.FC<SaleCartTableProps> = ({
  items,
  handleItemDetailChange,
  handleRemoveItem,
  clearCart,
}) => {
  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5 uppercase">
          <ShoppingCart size={16} className="text-primary" /> Detalle de Venta
        </h2>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const ok = confirm("¿Vaciar todos los productos del carrito?");
              if (ok) {
                clearCart();
              }
            }}
            className="text-xs text-destructive hover:underline font-semibold"
          >
            Vaciar
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-foreground-muted/50 border-2 border-dashed border-border rounded-2xl bg-muted/10">
          <ShoppingCart size={40} className="mb-2 text-foreground-muted/30" />
          <p className="text-sm font-semibold">El carrito está vacío</p>
          <p className="text-xs mt-1">
            Escanee un código de barras o busque productos arriba.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border rounded-xl bg-white shadow-sm max-h-[300px] overflow-y-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-muted border-b border-border sticky top-0 z-10">
              <tr>
                <th className="p-3 text-xs font-bold text-foreground uppercase">
                  Detalle del Producto
                </th>
                <th className="p-3 text-xs font-bold text-foreground text-center w-20 uppercase">
                  Cant.
                </th>
                <th className="p-3 text-xs font-bold text-foreground text-right w-24 uppercase">
                  Unitario
                </th>
                <th className="p-3 text-xs font-bold text-foreground text-right w-28 uppercase">
                  Subtotal
                </th>
                <th className="p-3 text-xs font-bold text-foreground text-center w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-sm">
              {items.map((item) => {
                // Alerta temprana: la cantidad supera el disponible → el cobro
                // rebotaría recién al completar. Se avisa acá, en el carrito.
                const overStock =
                  item.availableStock !== undefined &&
                  item.availableStock !== null &&
                  Number(item.quantity) > Number(item.availableStock);
                return (
                <tr
                  key={item.tempId}
                  className={`transition-colors ${
                    overStock ? "bg-destructive/5 hover:bg-destructive/10" : "hover:bg-muted/40"
                  }`}
                >
                  <td className="p-3 font-semibold text-foreground align-middle">
                    <div
                      className="truncate max-w-[200px]"
                      title={item.productName}
                    >
                      {item.productName}
                    </div>
                    <span className="text-[10px] text-foreground-muted font-normal block mt-0.5">
                      Disponibles: {item.availableStock}
                      {item.unitType === "WEIGHT"
                        ? " kg"
                        : item.unitType === "VOLUME"
                          ? " L"
                          : " u"}
                      {overStock && (
                        <span className="text-destructive font-bold">
                          {" "}· ¡Solo hay {item.availableStock}!
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="p-3 text-center align-middle">
                    <QuantityInput
                      item={item}
                      onChange={handleItemDetailChange}
                      invalid={overStock}
                    />
                  </td>
                  <td className="p-3 text-right align-middle">
                    <input
                      type="number"
                      value={String(item.priceAtSale)}
                      onChange={(e) =>
                        handleItemDetailChange(
                          item.tempId,
                          "priceAtSale",
                          e.target.value,
                        )
                      }
                      step="0.01"
                      min="0"
                      className="w-20 text-right border border-border rounded-lg px-2 py-1 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary font-mono font-medium"
                    />
                  </td>
                  <td className="p-3 text-right font-bold text-foreground align-middle font-mono">
                    {formatCurrency(item.subtotal)}
                  </td>
                  <td className="p-3 text-center align-middle">
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(item.tempId)}
                      className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg transition-colors cursor-pointer"
                      title="Quitar ítem"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SaleCartTable;
