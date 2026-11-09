import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCloudNewer, recordSyncConflict } from "../../../lib/syncConflict";
import { setupApi, teardownApi, type TestDb } from "../../helpers/api";

// En un pull+push bidireccional, la nube NO puede pisar un cambio local recién
// hecho con una versión vieja. isCloudNewer es ese guardián; recordSyncConflict
// deja rastro auditable sin romper la sincronización si falla.
describe("isCloudNewer", () => {
  const local = new Date("2026-05-10T12:00:00.000Z");

  it("es true solo si la nube es estrictamente más nueva", () => {
    expect(isCloudNewer("2026-05-10T12:00:00.001Z", local)).toBe(true);
    expect(isCloudNewer("2026-05-11T00:00:00.000Z", local)).toBe(true);
  });

  it("es false si la nube es igual o más vieja", () => {
    expect(isCloudNewer("2026-05-10T12:00:00.000Z", local)).toBe(false);
    expect(isCloudNewer("2026-05-09T23:59:59.999Z", local)).toBe(false);
  });

  it("es false sin fecha de nube", () => {
    expect(isCloudNewer(null, local)).toBe(false);
    expect(isCloudNewer(undefined, local)).toBe(false);
    expect(isCloudNewer("", local)).toBe(false);
  });

  it("es false con una fecha inválida (no pisa datos por basura)", () => {
    expect(isCloudNewer("no-es-fecha", local)).toBe(false);
  });
});

describe("recordSyncConflict", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("sync-conflict");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownApi(t);
  });

  it("crea un conflicto OPEN con versiones y payloads serializados", async () => {
    await recordSyncConflict({
      entity: "Product",
      entityKey: "7",
      localVersion: new Date("2026-05-10T12:00:00.000Z"),
      remoteVersion: "2026-05-11T09:30:00.000Z",
      localPayload: { name: "Local" },
      remotePayload: { name: "Nube" },
    });

    const row = await t.db.syncConflict.findFirstOrThrow();
    expect(row).toMatchObject({
      entity: "Product",
      entityKey: "7",
      status: "OPEN",
      localVersion: "2026-05-10T12:00:00.000Z",
      remoteVersion: "2026-05-11T09:30:00.000Z",
    });
    expect(JSON.parse(row.localPayload!)).toEqual({ name: "Local" });
    expect(JSON.parse(row.remotePayload!)).toEqual({ name: "Nube" });
  });

  it("guarda null cuando no hay versión ni payload", async () => {
    await recordSyncConflict({ entity: "Sale", entityKey: "1" });

    const row = await t.db.syncConflict.findFirstOrThrow();
    expect(row.localVersion).toBeNull();
    expect(row.remoteVersion).toBeNull();
    expect(row.localPayload).toBeNull();
    expect(row.remotePayload).toBeNull();
  });

  it("no duplica un conflicto OPEN para la misma entidad+clave", async () => {
    await recordSyncConflict({ entity: "Product", entityKey: "7" });
    await recordSyncConflict({ entity: "Product", entityKey: "7" });

    expect(await t.db.syncConflict.count()).toBe(1);
  });

  it("permite un conflicto nuevo si el anterior ya se resolvió", async () => {
    await recordSyncConflict({ entity: "Product", entityKey: "7" });
    await t.db.syncConflict.updateMany({ data: { status: "RESOLVED" } });

    await recordSyncConflict({ entity: "Product", entityKey: "7" });

    expect(await t.db.syncConflict.count()).toBe(2);
  });

  it("distingue conflictos de entidades o claves distintas", async () => {
    await recordSyncConflict({ entity: "Product", entityKey: "7" });
    await recordSyncConflict({ entity: "Product", entityKey: "8" });
    await recordSyncConflict({ entity: "Sale", entityKey: "7" });

    expect(await t.db.syncConflict.count()).toBe(3);
  });

  it("si el registro falla, no propaga el error (solo avisa)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const circular: any = {};
    circular.self = circular;

    await expect(
      recordSyncConflict({ entity: "Product", entityKey: "7", localPayload: circular }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(await t.db.syncConflict.count()).toBe(0);
  });
});
