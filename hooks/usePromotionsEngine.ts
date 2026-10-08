import { useMemo } from 'react';

interface CartItem {
  productId: string;
  quantity: number;
  subtotal: number;
}

interface PromotionCondition {
  productId?: number | null;
  categoryId?: number | null;
  minQuantity: number;
}

interface Promotion {
  id: number;
  name: string;
  type: string;
  discountType: string;
  discountValue: number;
  minQuantity?: number | null;
  maxDiscountQty?: number | null;
  conditions: PromotionCondition[];
}

export interface AppliedPromotion {
  promotionId: number;
  name: string;
  type: string;
  discountAmount: number;
  discountLabel: string;
}

export function evaluatePromotions(
  items: CartItem[],
  subtotal: number,
  promotions: Promotion[]
): AppliedPromotion | null {
  if (!promotions.length || items.length === 0) return null;

  const itemCountByProductId: Record<string, number> = {};
  const itemSubtotalByProductId: Record<string, number> = {};

  items.forEach(item => {
    const pid = item.productId;
    itemCountByProductId[pid] = (itemCountByProductId[pid] || 0) + item.quantity;
    itemSubtotalByProductId[pid] = (itemSubtotalByProductId[pid] || 0) + item.subtotal;
  });

  let bestPromo: AppliedPromotion | null = null;

  for (const promo of promotions) {
    if (!promo.conditions || promo.conditions.length === 0) continue;

    let discount = 0;
    let qualifies = false;

    if (promo.type === 'BUY_X_GET_Y') {
      for (const cond of promo.conditions) {
        if (!cond.productId || !(cond.minQuantity > 0)) continue; // minQuantity 0 daba division por cero
        const pid = String(cond.productId);
        const qtyInCart = itemCountByProductId[pid] || 0;
        if (qtyInCart >= cond.minQuantity) {
          qualifies = true;
          const times = Math.floor(qtyInCart / cond.minQuantity);
          const maxDiscountUnits = promo.maxDiscountQty || 1;
          const discountUnits = Math.min(times, maxDiscountUnits);
          const unitPrice = itemSubtotalByProductId[pid] / qtyInCart;
          if (promo.discountType === 'PERCENTAGE') {
            discount += unitPrice * discountUnits * (promo.discountValue / 100);
          } else {
            discount += promo.discountValue * discountUnits;
          }
        }
      }
    } else if (promo.type === 'SET_DISCOUNT') {
      qualifies = promo.conditions.every(cond => {
        if (cond.productId) {
          return (itemCountByProductId[String(cond.productId)] || 0) >= cond.minQuantity;
        }
        return false;
      });
      if (qualifies) {
        if (promo.discountType === 'PERCENTAGE') {
          discount = subtotal * (promo.discountValue / 100);
        } else {
          discount = promo.discountValue;
        }
      }
    } else if (promo.type === 'THRESHOLD') {
      const threshold = promo.minQuantity || 0;
      if (subtotal >= threshold) {
        qualifies = true;
        if (promo.discountType === 'PERCENTAGE') {
          discount = subtotal * (promo.discountValue / 100);
        } else {
          discount = promo.discountValue;
        }
      }
    }

    // Nunca descontar mas que lo que se paga ni dejar decimales flotantes.
    discount = Math.round(Math.min(discount, subtotal) * 100) / 100;

    if (qualifies && discount > 0 && (!bestPromo || discount > bestPromo.discountAmount)) {
      const label = promo.discountType === 'PERCENTAGE' ? `${promo.discountValue}%` : `$${promo.discountValue}`;
      bestPromo = {
        promotionId: promo.id,
        name: promo.name,
        type: promo.type,
        discountAmount: discount,
        discountLabel: label,
      };
    }
  }

  return bestPromo;
}

export function usePromotionsEngine(
  items: CartItem[],
  subtotal: number,
  comboDiscount: number,
  promotions: Promotion[]
): AppliedPromotion | null {
  return useMemo(() => {
    return evaluatePromotions(items, Math.max(0, subtotal - comboDiscount), promotions);
  }, [items, subtotal, comboDiscount, promotions]);
}
