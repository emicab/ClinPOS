import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La nube no se toca: se reemplaza el módulo de sync completo. El outbox es
// quien decide qué subir, en qué orden y qué hacer ante un fallo.
vi.mock("../../../lib/syncService", () => ({
  getSelectiveSyncCredentials: vi.fn(async () => ({
    supabaseUrl: "https://fake.test/",
    supabaseKey: "fake-key",
    tenantId: "tenant-test",
  })),
  pushEntitiesToSupabase: vi.fn(async () => undefined),
  deleteProductFromSupabase: vi.fn(async () => true),
  deleteSaleFromSupabase: vi.fn(async () => true),
  deleteWebOrdersFromSupabase: vi.fn(async () => true),
  deleteComboFromSupabase: vi.fn(async () => true),
  deletePromotionFromSupabase: vi.fn(async () => true),
  syncSingleProduct: vi.fn(async () => true),
  syncWebOrderToSupabase: vi.fn(async () => true),
  syncStockTransferToSupabase: vi.fn(async () => true),
  syncModifierGroupsForProducts: vi.fn(async () => true),
}));

import {
  drainOutbox,
  enqueueOutbox,
  enqueueStockMovement,
  getPendingCount,
  hasPendingLocalChange,
  isOutboxDeletePending,
} from "../../../lib/syncOutbox";
import { invalidateCloudPolicyCache } from "../../../lib/cloudPolicy";
import * as syncService from "../../../lib/syncService";
import {
  setupApi,
  teardownApi,
  type TestDb,
} from "../../helpers/api";
import {
  makeProduct,
  makePurchase,
  makeSale,
  makeSeller,
  makeSupplier,
  setSetting,
} from "../../helpers/factories";

// El outbox es la garantía de "no perder ventas si se cae internet". Sus
// invariantes: en modo local no acumula nada, deduplica por entidad+clave,
// escribe tombstones para que un pull no resucite borrados, y distingue un
// error de red (no consume intentos) de un rechazo de la nube (sí).
describe("syncOutbox", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("outbox");
    vi.mocked(syncService.pushEntitiesToSupabase).mockReset().mockResolvedValue(undefined);
    vi.mocked(syncService.syncSingleProduct).mockReset().mockResolvedValue(true);
    vi.mocked(syncService.deleteProductFromSupabase).mockReset().mockResolvedValue(true);
    vi.mocked(syncService.syncStockTransferToSupabase).mockReset().mockResolvedValue(true);
    vi.mocked(syncService.syncWebOrderToSupabase).mockReset().mockResolvedValue(true);
    vi.mocked(syncService.syncModifierGroupsForProducts).mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // clearAllMocks conserva las implementaciones de fábrica; restoreAllMocks
    // las borraría y los tests siguientes saldrían sin mock de syncService.
    vi.clearAllMocks();
    invalidateCloudPolicyCache();
    await teardownApi(t);
  });

  /** Habilita nube + Pro (las dos condiciones de enqueueOutbox). */
  async function enableCloud(options: { pro?: boolean } = {}) {
    await setSetting(t.db, "cloud_sync_enabled", "true");
    if (options.pro !== false) await setSetting(t.db, "app_plan", "pro");
    invalidateCloudPolicyCache();
  }

  // Va primero a propósito: la purga y la reactivación corren una sola vez por
  // hora dentro del proceso, así que necesitan el primer drain del archivo.
  describe("housekeeping (purga y reactivación)", () => {
    it("purga los DONE de más de 7 días y reactiva los FAILED de más de 6 horas", async () => {
      await enableCloud();
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await t.db.syncOutbox.create({
        data: {
          entity: "Product",
          operation: "UPSERT",
          entityKey: "1",
          status: "DONE",
          updatedAt: old,
        },
      });
      await t.db.syncOutbox.create({
        data: {
          entity: "Product",
          operation: "UPSERT",
          entityKey: "2",
          status: "FAILED",
          attempts: 5,
          lastAttemptAt: old,
        },
      });

      const res = await drainOutbox();

      expect(res.drained).toBe(0);
      const rows = await t.db.syncOutbox.findMany({ orderBy: { id: "asc" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entityKey: "2", status: "PENDING", attempts: 0 });
      expect(rows[0].nextAttemptAt).toBeNull();
    });
  });

  describe("modo local", () => {
    it("no encola nada si la nube está apagada (default)", async () => {
      await enqueueOutbox("Product", "UPSERT", "1");
      await enqueueStockMovement({ operationId: "op-1", productId: 1, delta: 1 });

      expect(await t.db.syncOutbox.count()).toBe(0);
      expect(await t.db.syncTombstone.count()).toBe(0);
      expect(await getPendingCount()).toBe(0);
    });

    it("drainOutbox no hace nada y no sale a la red", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await drainOutbox();

      expect(res).toEqual({ drained: 0, remaining: 0, networkError: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("no encola nada si hay nube pero el plan no es Pro", async () => {
      await enableCloud({ pro: false });

      await enqueueOutbox("Product", "UPSERT", "1");

      expect(await t.db.syncOutbox.count()).toBe(0);
    });
  });

  describe("enqueueOutbox", () => {
    it("crea una operación PENDING con el payload", async () => {
      await enableCloud();

      await enqueueOutbox("Product", "UPSERT", "7", { name: "Harina" });

      const row = await t.db.syncOutbox.findFirstOrThrow();
      expect(row).toMatchObject({
        entity: "Product",
        operation: "UPSERT",
        entityKey: "7",
        status: "PENDING",
        attempts: 0,
      });
      expect(JSON.parse(row.payloadJson!)).toEqual({ name: "Harina" });
    });

    it("deduplica la misma entidad+clave+operación", async () => {
      await enableCloud();

      await enqueueOutbox("Product", "UPSERT", "7");
      await enqueueOutbox("Product", "UPSERT", "7");

      expect(await t.db.syncOutbox.count()).toBe(1);
    });

    it("actualiza el payload de la operación pendiente existente", async () => {
      await enableCloud();

      await enqueueOutbox("Product", "UPSERT", "7", { v: 1 });
      await enqueueOutbox("Product", "UPSERT", "7", { v: 2 });

      const rows = await t.db.syncOutbox.findMany();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].payloadJson!)).toEqual({ v: 2 });
    });

    it("UPSERT seguido de DELETE cierra el upsert y crea el tombstone", async () => {
      await enableCloud();

      await enqueueOutbox("Product", "UPSERT", "7");
      await enqueueOutbox("Product", "DELETE", "7");

      const rows = await t.db.syncOutbox.findMany({ orderBy: { id: "asc" } });
      expect(rows).toHaveLength(2);
      expect(rows[0].status).toBe("DONE");
      expect(rows[1]).toMatchObject({ operation: "DELETE", status: "PENDING" });
      expect(await t.db.syncTombstone.count()).toBe(1);
    });

    it("DELETE seguido de UPSERT elimina el tombstone y cierra el delete", async () => {
      await enableCloud();

      await enqueueOutbox("Product", "DELETE", "7");
      await enqueueOutbox("Product", "UPSERT", "7");

      const rows = await t.db.syncOutbox.findMany({ orderBy: { id: "asc" } });
      expect(rows[0]).toMatchObject({ operation: "DELETE", status: "DONE" });
      expect(rows[1]).toMatchObject({ operation: "UPSERT", status: "PENDING" });
      expect(await t.db.syncTombstone.count()).toBe(0);
    });

    it("borrar un producto descarta el upsert de su stock por sucursal", async () => {
      await enableCloud();

      await enqueueOutbox("ProductBranchStock", "UPSERT", "7");
      await enqueueOutbox("Product", "DELETE", "7");

      const stockRow = await t.db.syncOutbox.findFirstOrThrow({
        where: { entity: "ProductBranchStock" },
      });
      expect(stockRow.status).toBe("DONE");
    });

    it("enqueueStockMovement guarda la operación con su payload", async () => {
      await enableCloud();

      await enqueueStockMovement({
        operationId: "sale:1:item:0",
        productId: 7,
        delta: -2,
        branchId: 3,
      });

      const row = await t.db.syncOutbox.findFirstOrThrow();
      expect(row).toMatchObject({ entity: "StockMovement", operation: "UPSERT", entityKey: "sale:1:item:0" });
      expect(JSON.parse(row.payloadJson!)).toEqual({
        operationId: "sale:1:item:0",
        productId: 7,
        delta: -2,
        branchId: 3,
      });
    });
  });

  describe("consultas", () => {
    it("getPendingCount cuenta solo PENDING", async () => {
      await enableCloud();
      await enqueueOutbox("Product", "UPSERT", "1");
      await enqueueOutbox("Product", "UPSERT", "2");
      await t.db.syncOutbox.updateMany({ where: { entityKey: "2" }, data: { status: "DONE" } });

      expect(await getPendingCount()).toBe(1);
    });

    it("isOutboxDeletePending detecta un DELETE pendiente", async () => {
      await enableCloud();
      await enqueueOutbox("Product", "DELETE", "9");

      expect(await isOutboxDeletePending("Product", "9")).toBe(true);
      expect(await isOutboxDeletePending("Product", "10")).toBe(false);
    });

    it("isOutboxDeletePending detecta solo el tombstone", async () => {
      await enableCloud();
      await enqueueOutbox("Product", "DELETE", "9");
      await t.db.syncOutbox.deleteMany();

      expect(await isOutboxDeletePending("Product", "9")).toBe(true);
    });

    it("hasPendingLocalChange distingue PENDING/FAILED de DONE", async () => {
      await enableCloud();
      await enqueueOutbox("Product", "UPSERT", "1");
      await enqueueOutbox("Product", "UPSERT", "2");
      await enqueueOutbox("Product", "UPSERT", "3");
      await t.db.syncOutbox.updateMany({ where: { entityKey: "2" }, data: { status: "FAILED" } });
      await t.db.syncOutbox.updateMany({ where: { entityKey: "3" }, data: { status: "DONE" } });

      expect(await hasPendingLocalChange("Product", "1")).toBe(true);
      expect(await hasPendingLocalChange("Product", "2")).toBe(true);
      expect(await hasPendingLocalChange("Product", "3")).toBe(false);
    });
  });

  describe("drainOutbox", () => {
    it("marca DONE un DELETE confirmado y borra el tombstone", async () => {
      await enableCloud();
      await enqueueOutbox("Product", "DELETE", "5");

      const res = await drainOutbox();

      expect(res.drained).toBe(1);
      expect((await t.db.syncOutbox.findFirstOrThrow()).status).toBe("DONE");
      expect(await t.db.syncTombstone.count()).toBe(0);
      expect(syncService.deleteProductFromSupabase).toHaveBeenCalledWith(5);
    });

    it("un DELETE rechazado queda reintentable con backoff", async () => {
      await enableCloud();
      vi.mocked(syncService.deleteProductFromSupabase).mockResolvedValue(false);
      await enqueueOutbox("Product", "DELETE", "5");

      const res = await drainOutbox();

      expect(res.drained).toBe(0);
      const row = await t.db.syncOutbox.findFirstOrThrow();
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
      expect(row.lastError).toBeTruthy();
      expect(row.nextAttemptAt).not.toBeNull();
      // El tombstone sigue: el borrado no llegó a la nube.
      expect(await t.db.syncTombstone.count()).toBe(1);
    });

    it("un error de red no consume intentos y corta la cola", async () => {
      await enableCloud();
      await enqueueOutbox("Product", "DELETE", "5");
      await enqueueOutbox("Product", "DELETE", "6");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(syncService.deleteProductFromSupabase).mockRejectedValue(new Error("fetch failed"));

      const res = await drainOutbox();

      expect(res.networkError).toBe(true);
      const rows = await t.db.syncOutbox.findMany({ orderBy: { id: "asc" } });
      expect(rows[0]).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(rows[0].nextAttemptAt).not.toBeNull();
      // La segunda ni se intentó.
      expect(rows[1]).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(rows[1].lastAttemptAt).toBeNull();
    });

    it("sube un movimiento de stock por RPC con los parámetros correctos", async () => {
      await enableCloud();
      const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "" }));
      vi.stubGlobal("fetch", fetchMock);
      await enqueueStockMovement({ operationId: "op-42", productId: 7, delta: -3, branchId: 2 });

      const res = await drainOutbox();

      expect(res.drained).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as any;
      expect(url).toBe("https://fake.test/rest/v1/rpc/apply_stock_movement");
      expect(JSON.parse(init.body)).toEqual({
        p_tenant_id: "tenant-test",
        p_operation_id: "op-42",
        p_product_id: 7,
        p_delta: -3,
        p_branch_id: 2,
      });
      expect((await t.db.syncOutbox.findFirstOrThrow()).status).toBe("DONE");
    });

    it("un movimiento de stock sin datos válidos no sale a la red", async () => {
      await enableCloud();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await t.db.syncOutbox.create({
        data: {
          entity: "StockMovement",
          operation: "UPSERT",
          entityKey: "roto",
          status: "PENDING",
          payloadJson: JSON.stringify({ operationId: "roto" }),
        },
      });

      await drainOutbox();

      expect(fetchMock).not.toHaveBeenCalled();
      const row = await t.db.syncOutbox.findFirstOrThrow();
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
    });

    it("un RPC rechazado queda FAILED (un error no-red no se reintenta)", async () => {
      // Contrato actual: solo los errores de red conservan intentos. Un 5xx del
      // RPC entra por el catch como error no-red y se marca FAILED; el ciclo de
      // reactivación lo vuelve a PENDING a las 6 horas.
      await enableCloud();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })));
      await enqueueStockMovement({ operationId: "op-1", productId: 7, delta: 1, branchId: null });

      const res = await drainOutbox();

      expect(res.drained).toBe(0);
      const row = await t.db.syncOutbox.findFirstOrThrow();
      expect(row.status).toBe("FAILED");
      expect(row.attempts).toBe(1);
      expect(row.nextAttemptAt).toBeNull();
      expect(row.lastError).toMatch(/RPC de stock rechazado \(500\)/);
    });

    it("sube una venta COMPLETED con sus ítems", async () => {
      await enableCloud();
      const seller = await makeSeller(t.db);
      const product = await makeProduct(t.db);
      const sale = await makeSale(t.db, { sellerId: seller.id, totalAmount: "150.75" });
      await t.db.saleItem.create({
        data: {
          saleId: sale.id,
          productId: product.id,
          quantity: 2,
          priceAtSale: "75.375",
          purchasePriceAtSale: "10",
        },
      });
      await enqueueOutbox("Sale", "UPSERT", String(sale.id));

      const res = await drainOutbox();

      expect(res.drained).toBe(1);
      expect(syncService.pushEntitiesToSupabase).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(syncService.pushEntitiesToSupabase).mock.calls[0][2] as any;
      expect(payload.Sale[0]).toMatchObject({
        id: sale.id,
        totalAmount: "150.75",
        tenant_id: "tenant-test",
        sellerId: seller.id,
      });
      expect(payload.SaleItem).toHaveLength(1);
      expect(payload.SaleItem[0]).toMatchObject({ quantity: 2, priceAtSale: "75.375" });
    });

    it("una venta PENDING no se sube pero se marca DONE", async () => {
      await enableCloud();
      const seller = await makeSeller(t.db);
      const sale = await makeSale(t.db, { sellerId: seller.id, status: "PENDING" });
      await enqueueOutbox("Sale", "UPSERT", String(sale.id));

      const res = await drainOutbox();

      expect(res.drained).toBe(1);
      expect(syncService.pushEntitiesToSupabase).not.toHaveBeenCalled();
      expect((await t.db.syncOutbox.findFirstOrThrow()).status).toBe("DONE");
    });

    it("sube una compra con sus ítems", async () => {
      await enableCloud();
      const supplier = await makeSupplier(t.db);
      const product = await makeProduct(t.db);
      const purchase = await makePurchase(t.db, {
        supplierId: supplier.id,
        items: [{ productId: product.id, quantity: 2, purchasePrice: "9.50" }],
      });
      await enqueueOutbox("Purchase", "UPSERT", String(purchase.id));

      await drainOutbox();

      const payload = vi.mocked(syncService.pushEntitiesToSupabase).mock.calls[0][2] as any;
      expect(payload.Purchase[0]).toMatchObject({
        id: purchase.id,
        totalAmount: "19",
        supplierId: supplier.id,
        tenant_id: "tenant-test",
      });
      expect(payload.PurchaseItem[0]).toMatchObject({ quantity: 2, purchasePrice: "9.5" });
    });

    it("un Product sube con syncSingleProduct", async () => {
      await enableCloud();
      const product = await makeProduct(t.db);
      await enqueueOutbox("Product", "UPSERT", String(product.id));

      await drainOutbox();

      expect(syncService.syncSingleProduct).toHaveBeenCalledWith(product.id);
    });

    it("un ProductBranchStock de un producto ya borrado se marca DONE sin subir", async () => {
      await enableCloud();
      await enqueueOutbox("ProductBranchStock", "UPSERT", "999999");

      const res = await drainOutbox();

      expect(res.drained).toBe(1);
      expect(syncService.syncSingleProduct).not.toHaveBeenCalled();
    });

    it("enruta WebOrder, StockTransfer y ProductModifierGroup a su sincronizador", async () => {
      await enableCloud();
      await enqueueOutbox("WebOrder", "UPSERT", "11");
      await enqueueOutbox("StockTransfer", "UPSERT", "12");
      await enqueueOutbox("ProductModifierGroup", "UPSERT", "13");

      await drainOutbox();

      expect(syncService.syncWebOrderToSupabase).toHaveBeenCalledWith(11);
      expect(syncService.syncStockTransferToSupabase).toHaveBeenCalledWith(12);
      expect(syncService.syncModifierGroupsForProducts).toHaveBeenCalledWith("tenant-test", [13]);
    });

    it("procesa por prioridad: StockMovement → Sale → Product", async () => {
      await enableCloud();
      const order: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          order.push("StockMovement");
          return { ok: true, text: async () => "" };
        }),
      );
      vi.mocked(syncService.pushEntitiesToSupabase).mockImplementation(async () => {
        order.push("Sale");
        return undefined;
      });
      vi.mocked(syncService.syncSingleProduct).mockImplementation(async () => {
        order.push("Product");
        return true;
      });

      const seller = await makeSeller(t.db);
      const product = await makeProduct(t.db);
      const sale = await makeSale(t.db, { sellerId: seller.id });
      await enqueueOutbox("Product", "UPSERT", String(product.id));
      await enqueueOutbox("Sale", "UPSERT", String(sale.id));
      await enqueueStockMovement({ operationId: "op-1", productId: product.id, delta: 1, branchId: null });

      await drainOutbox();

      expect(order).toEqual(["StockMovement", "Sale", "Product"]);
    });
  });
});
