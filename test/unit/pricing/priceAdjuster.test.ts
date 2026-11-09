import { describe, expect, it } from "vitest";
import {
  applyRound,
  calcAdjustedPrice,
  calcSalePrice,
  marginOnSale,
  markupOnCost,
  validateAdjustValue,
} from "../../../lib/priceAdjuster";

// El ajustador masivo toca TODOS los precios de una categoría o marca. Un
// redondeo mal aplicado o un descuento que deja el precio negativo se propaga
// a cientos de productos y a la tienda web. Estas son las reglas del cálculo.
describe("applyRound", () => {
  it("sin redondeo deja 2 decimales", () => {
    expect(applyRound(10.006, "none")).toBe(10.01);
    expect(applyRound(10.004, "none")).toBe(10);
    expect(applyRound(10.125, "none")).toBe(10.13);
  });

  it("integer redondea al entero más cercano", () => {
    expect(applyRound(10.49, "integer")).toBe(10);
    expect(applyRound(10.5, "integer")).toBe(11);
    expect(applyRound(10.99, "integer")).toBe(11);
  });

  it("tens redondea a la decena", () => {
    expect(applyRound(14.9, "tens")).toBe(10);
    expect(applyRound(15, "tens")).toBe(20);
    expect(applyRound(1049, "tens")).toBe(1050);
  });

  it("hundreds redondea al centenar", () => {
    expect(applyRound(149, "hundreds")).toBe(100);
    expect(applyRound(150, "hundreds")).toBe(200);
    expect(applyRound(1250, "hundreds")).toBe(1300);
  });

  it("nunca devuelve un precio negativo", () => {
    expect(applyRound(-1, "none")).toBe(0);
    expect(applyRound(-1, "integer")).toBe(0);
    expect(applyRound(-1, "hundreds")).toBe(0);
  });
});

describe("calcAdjustedPrice", () => {
  it("aumenta un porcentaje", () => {
    expect(calcAdjustedPrice(100, "PERCENT_INCREASE", 10, "none")).toBe(110);
  });

  it("disminuye un porcentaje", () => {
    expect(calcAdjustedPrice(100, "PERCENT_DECREASE", 10, "none")).toBe(90);
  });

  it("aumenta un monto fijo", () => {
    expect(calcAdjustedPrice(100, "FIXED_INCREASE", 25, "none")).toBe(125);
  });

  it("disminuye un monto fijo", () => {
    expect(calcAdjustedPrice(100, "FIXED_DECREASE", 25, "none")).toBe(75);
  });

  it("set fija el precio sin importar el actual", () => {
    expect(calcAdjustedPrice(999, "SET_FIXED", 50, "none")).toBe(50);
  });

  it("aplica el redondeo después del ajuste", () => {
    // 99 × 1.10 = 108.9 → 110
    expect(calcAdjustedPrice(99, "PERCENT_INCREASE", 10, "tens")).toBe(110);
    // 99 + 1 = 100 → 100
    expect(calcAdjustedPrice(99, "FIXED_INCREASE", 1, "integer")).toBe(100);
  });

  it("un descuento mayor al precio deja 0, no negativo", () => {
    expect(calcAdjustedPrice(50, "PERCENT_DECREASE", 200, "none")).toBe(0);
    expect(calcAdjustedPrice(50, "FIXED_DECREASE", 80, "none")).toBe(0);
  });

  it("un tipo desconocido no cambia el precio", () => {
    expect(calcAdjustedPrice(80, "INVENTED" as any, 10, "none")).toBe(80);
  });
});

describe("validateAdjustValue", () => {
  it("acepta números y strings numéricos", () => {
    expect(validateAdjustValue(10)).toBe(10);
    expect(validateAdjustValue("12.5")).toBe(12.5);
  });

  it("rechaza 0, negativos, vacío y no numéricos", () => {
    for (const value of [0, -1, "", null, undefined, "abc"]) {
      expect(() => validateAdjustValue(value)).toThrow(/mayor a 0/);
    }
  });

  it("parsea el prefijo numérico (comportamiento actual de parseFloat)", () => {
    expect(validateAdjustValue("10%")).toBe(10);
  });
});

describe("calcSalePrice", () => {
  it("markup: costo × (1 + p/100)", () => {
    expect(calcSalePrice(100, 50, "markup")).toBe(150);
    expect(calcSalePrice(100, 10, "markup")).toBe(110);
  });

  it("margin: costo / (1 − p/100)", () => {
    expect(calcSalePrice(100, 50, "margin")).toBe(200);
    expect(calcSalePrice(100, 25, "margin")).toBe(133.33);
  });

  it("rechaza costo inválido", () => {
    for (const cost of [0, -1, NaN, Infinity]) {
      expect(() => calcSalePrice(cost, 50, "markup")).toThrow(/precio de compra/);
    }
  });

  it("rechaza porcentaje inválido", () => {
    for (const pct of [0, -1, NaN, Infinity]) {
      expect(() => calcSalePrice(100, pct, "markup")).toThrow(/porcentaje/);
    }
  });

  it("margin exige un porcentaje menor a 100", () => {
    expect(() => calcSalePrice(100, 100, "margin")).toThrow(/menor a 100/);
    expect(() => calcSalePrice(100, 120, "margin")).toThrow(/menor a 100/);
  });
});

describe("marginOnSale / markupOnCost", () => {
  it("calcula el margen sobre venta con un decimal", () => {
    expect(marginOnSale(100, 150)).toBe(33.3);
    expect(marginOnSale(100, 200)).toBe(50);
    expect(marginOnSale(100, 100)).toBe(0);
  });

  it("calcula el recargo sobre costo con un decimal", () => {
    expect(markupOnCost(100, 150)).toBe(50);
    expect(markupOnCost(100, 125)).toBe(25);
  });

  it("devuelve 0 con datos inválidos", () => {
    for (const [cost, sale] of [
      [0, 100],
      [-1, 100],
      [100, 0],
      [100, -1],
      [NaN, 100],
      [100, NaN],
    ]) {
      expect(marginOnSale(cost, sale)).toBe(0);
      expect(markupOnCost(cost, sale)).toBe(0);
    }
  });
});
