import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHandler from "../../../pages/api/caja/index";
import registerHandler from "../../../pages/api/caja/[id]";
import {
  callHandler,
  mockReq,
  setupApi,
  teardownApi,
  type TestDb,
} from "../../helpers/api";
import {
  makeCashMovement,
  makeCashRegister,
  makeSeller,
} from "../../helpers/factories";

// La caja es el único lugar donde se compara lo que debería haber contra lo que
// hay. El cierre suma SOLO efectivo (tarjeta/transferencia/QR no pasan por el
// cajón); si esa regla se rompe, el arqueo nunca cierra y el comerciante
// persigue diferencias que no existen.
describe("POST /api/caja", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("caja");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  function post(body: unknown) {
    return callHandler(indexHandler, mockReq(body));
  }

  it("abre la caja con el saldo inicial indicado", async () => {
    const res = await post({ initialBalance: "100.50" });

    expect(res.statusCode).toBe(201);
    expect(String(res.body.initialBalance)).toBe("100.5");
    expect(res.body.status).toBe("OPEN");
    expect(res.body.closeDate).toBeNull();
  });

  it("usa 0 si no se indica saldo inicial", async () => {
    const res = await post({});

    expect(res.statusCode).toBe(201);
    expect(String(res.body.initialBalance)).toBe("0");
  });

  it("trata el string vacío como 0", async () => {
    const res = await post({ initialBalance: "" });

    expect(res.statusCode).toBe(201);
    expect(String(res.body.initialBalance)).toBe("0");
  });

  it("400 con saldo inicial negativo", async () => {
    const res = await post({ initialBalance: "-1" });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/mayor o igual a 0/);
    expect(await t.db.cashRegister.count()).toBe(0);
  });

  it("400 con saldo inicial no numérico", async () => {
    const res = await post({ initialBalance: "abc" });

    expect(res.statusCode).toBe(400);
    expect(await t.db.cashRegister.count()).toBe(0);
  });

  it("no permite dos cajas abiertas a la vez", async () => {
    await makeCashRegister(t.db, { status: "OPEN" });

    const res = await post({ initialBalance: "10" });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Ya hay una caja abierta/);
    expect(await t.db.cashRegister.count()).toBe(1);
  });

  it("asocia el vendedor que abrió la caja", async () => {
    const seller = await makeSeller(t.db);

    const res = await post({ sellerId: String(seller.id), initialBalance: "0" });

    expect(res.statusCode).toBe(201);
    expect(res.body.sellerId).toBe(seller.id);
  });

  it("405 para métodos no soportados", async () => {
    const res = await callHandler(indexHandler, mockReq(undefined, { method: "DELETE" }));
    expect(res.statusCode).toBe(405);
  });
});

describe("GET /api/caja", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("caja-get");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("devuelve la caja abierta con sus movimientos", async () => {
    const open = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "50" });
    await makeCashMovement(t.db, open.id, { amount: "25", type: "SALE" });
    await makeCashRegister(t.db, { status: "CLOSED" });

    const res = await callHandler(indexHandler, mockReq(undefined, { method: "GET" }));

    expect(res.statusCode).toBe(200);
    expect(res.body.open.id).toBe(open.id);
    expect(res.body.open.movements).toHaveLength(1);
    expect(res.body.history).toHaveLength(1);
  });

  it("devuelve open=null si no hay caja abierta", async () => {
    const res = await callHandler(indexHandler, mockReq(undefined, { method: "GET" }));

    expect(res.statusCode).toBe(200);
    expect(res.body.open).toBeNull();
    expect(res.body.history).toEqual([]);
  });

  it("limita el historial a las últimas 10 cajas cerradas, más nuevas primero", async () => {
    for (let i = 0; i < 12; i++) {
      await makeCashRegister(t.db, { status: "CLOSED" });
      await t.db.cashRegister.updateMany({
        where: { status: "CLOSED", closeDate: null },
        data: { closeDate: new Date(Date.UTC(2026, 0, i + 1)) },
      });
    }

    const res = await callHandler(indexHandler, mockReq(undefined, { method: "GET" }));

    expect(res.body.history).toHaveLength(10);
    const dates = res.body.history.map((r: any) => r.closeDate.toISOString());
    expect(dates).toEqual([...dates].sort().reverse());
    // La más vieja (1/1) quedó fuera.
    expect(dates.some((d: string) => d.startsWith("2026-01-01"))).toBe(false);
  });
});

describe("GET /api/caja/[id]", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("caja-detalle");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  function get(id: string | number) {
    return callHandler(registerHandler, mockReq(undefined, { method: "GET", query: { id: String(id) } }));
  }

  it("400 con id inválido", async () => {
    const res = await get("abc");

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/ID inválido/);
  });

  it("404 si la caja no existe", async () => {
    const res = await get(999_999);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/no encontrada/);
  });

  it("serializa los importes como string", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "150.75" });
    await makeCashMovement(t.db, register.id, { amount: "20.10" });

    const res = await get(register.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.initialBalance).toBe("150.75");
    expect(res.body.movements[0].amount).toBe("20.1");
  });

  it("405 para métodos no soportados", async () => {
    const res = await callHandler(
      registerHandler,
      mockReq(undefined, { method: "POST", query: { id: "1" } }),
    );
    expect(res.statusCode).toBe(405);
  });
});

describe("PUT /api/caja/[id] (cierre)", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("caja-cierre");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  function close(id: string | number, body: unknown) {
    return callHandler(
      registerHandler,
      mockReq(body, { method: "PUT", query: { id: String(id) } }),
    );
  }

  it("400 si falta el saldo real", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN" });

    for (const actualBalance of [undefined, null, "", "abc"]) {
      const res = await close(register.id, { actualBalance });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/saldo real es obligatorio/);
    }

    expect((await t.db.cashRegister.findUniqueOrThrow({ where: { id: register.id } })).status).toBe("OPEN");
  });

  it("404 si la caja no existe", async () => {
    const res = await close(999_999, { actualBalance: 10 });

    expect(res.statusCode).toBe(404);
  });

  it("400 si la caja ya está cerrada", async () => {
    const register = await makeCashRegister(t.db, { status: "CLOSED" });

    const res = await close(register.id, { actualBalance: 10 });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/ya está cerrada/);
  });

  it("calcula el esperado con el saldo inicial más los movimientos en efectivo", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "100" });
    await makeCashMovement(t.db, register.id, { type: "SALE", paymentType: "CASH", amount: "50" });
    await makeCashMovement(t.db, register.id, { type: "EXPENSE", paymentType: "CASH", amount: "-20" });

    const res = await close(register.id, { actualBalance: "130" });

    expect(res.statusCode).toBe(200);
    expect(String(res.body.expectedBalance)).toBe("130");
    expect(String(res.body.actualBalance)).toBe("130");
    expect(String(res.body.difference)).toBe("0");
    expect(res.body.status).toBe("CLOSED");
    expect(res.body.closeDate).not.toBeNull();
  });

  it("NO suma tarjeta, transferencia, QR ni Mercado Pago al efectivo esperado", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "100" });
    await makeCashMovement(t.db, register.id, { type: "SALE", paymentType: "CASH", amount: "50" });
    await makeCashMovement(t.db, register.id, { type: "SALE", paymentType: "TRANSFER", amount: "200" });
    await makeCashMovement(t.db, register.id, { type: "SALE", paymentType: "CARD", amount: "300" });
    await makeCashMovement(t.db, register.id, { type: "SALE", paymentType: "QR", amount: "400" });
    await makeCashMovement(t.db, register.id, { type: "SALE", paymentType: "MERCADO_PAGO", amount: "500" });

    const res = await close(register.id, { actualBalance: "150" });

    expect(String(res.body.expectedBalance)).toBe("150");
    expect(String(res.body.difference)).toBe("0");
  });

  it("ignora los movimientos sin medio de pago", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "100" });
    await makeCashMovement(t.db, register.id, { type: "ADJUSTMENT", paymentType: null, amount: "999" });

    const res = await close(register.id, { actualBalance: "100" });

    expect(String(res.body.expectedBalance)).toBe("100");
  });

  it("registra una diferencia negativa cuando falta plata", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "100" });
    await makeCashMovement(t.db, register.id, { paymentType: "CASH", amount: "50" });

    const res = await close(register.id, { actualBalance: "125" });

    expect(String(res.body.expectedBalance)).toBe("150");
    expect(String(res.body.difference)).toBe("-25");
  });

  it("registra una diferencia positiva cuando sobra plata", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "100" });

    const res = await close(register.id, { actualBalance: "110" });

    expect(String(res.body.difference)).toBe("10");
  });

  it("guarda las notas del cierre y limpia las vacías", async () => {
    const withNotes = await makeCashRegister(t.db, { status: "OPEN" });
    const res = await close(withNotes.id, { actualBalance: "0", notes: "Faltó vuelto" });
    expect(res.body.notes).toBe("Faltó vuelto");

    const withoutNotes = await makeCashRegister(t.db, { status: "OPEN" });
    const res2 = await close(withoutNotes.id, { actualBalance: "0", notes: "" });
    expect(res2.body.notes).toBeNull();
  });

  it("acepta un saldo real en 0", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "0" });

    const res = await close(register.id, { actualBalance: "0" });

    expect(res.statusCode).toBe(200);
    expect(String(res.body.difference)).toBe("0");
  });

  it("un segundo cierre no vuelve a tocar los importes", async () => {
    const register = await makeCashRegister(t.db, { status: "OPEN", initialBalance: "100" });
    await close(register.id, { actualBalance: "100" });

    const res = await close(register.id, { actualBalance: "500" });

    expect(res.statusCode).toBe(400);
    const after = await t.db.cashRegister.findUniqueOrThrow({ where: { id: register.id } });
    expect(String(after.actualBalance)).toBe("100");
  });
});
