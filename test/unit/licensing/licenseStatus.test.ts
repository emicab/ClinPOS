import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLocalPlan,
  isProLicenseKey,
  revalidateLicense,
} from "../../../lib/licenseStatus";
import { setupApi, teardownApi, type TestDb } from "../../helpers/api";
import { setSetting } from "../../helpers/factories";

// La licencia decide si el comercio tiene traspasos entre locales, nube y
// reportes Pro. El punto delicado: un error de red NUNCA debe degradar el plan
// (el local sigue facturando), pero una clave vencida/desactivada SÍ debe
// bajarlo y propagarlo.
describe("isProLicenseKey", () => {
  it("reconoce las claves Pro por prefijo", () => {
    expect(isProLicenseKey("CLIN-PRO-1234")).toBe(true);
    expect(isProLicenseKey("CRM-PRO-ABCD")).toBe(true);
  });

  it("una clave BASICO no se vuelve Pro porque contenga PRO", () => {
    expect(isProLicenseKey("CLIN-BASICO-XPRO-1234")).toBe(false);
    expect(isProLicenseKey("CRM-BASICO-PRO")).toBe(false);
  });

  it("tolera formatos viejos que incluyen PRO en cualquier lado", () => {
    expect(isProLicenseKey("LEGACY-PRO-KEY")).toBe(true);
  });

  it("una clave sin PRO ni prefijo conocido no es Pro", () => {
    expect(isProLicenseKey("CLIN-BASE-1")).toBe(false);
    expect(isProLicenseKey("ABC")).toBe(false);
  });
});

describe("getLocalPlan", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await setupApi("license-plan");
  });

  afterEach(async () => {
    await teardownApi(t);
  });

  it("sin configuración el plan es básico", async () => {
    expect(await getLocalPlan()).toBe("basico");
  });

  it.each([
    ["app_plan", "pro"],
    ["plan_type", "pro"],
    ["unlocked_plan_pro", "true"],
    ["storage_mode", "seguro"],
  ])("con %s=%s el plan es Pro", async (key, value) => {
    await setSetting(t.db, key, value);
    expect(await getLocalPlan()).toBe("pro");
  });

  it("alcanza con que una sola marca diga Pro", async () => {
    await setSetting(t.db, "app_plan", "basico");
    await setSetting(t.db, "plan_type", "basico");
    await setSetting(t.db, "unlocked_plan_pro", "false");
    await setSetting(t.db, "storage_mode", "seguro");
    expect(await getLocalPlan()).toBe("pro");
  });
});

describe("revalidateLicense", () => {
  let t: TestDb;
  let originalHardwareId: string | undefined;

  beforeEach(async () => {
    t = await setupApi("license");
    originalHardwareId = process.env.HARDWARE_ID;
    process.env.HARDWARE_ID = "POS-TEST-01";
    await setSetting(t.db, "supabase_url", "https://test.supabase.co");
    await setSetting(t.db, "supabase_anon_key", "anon-test");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (originalHardwareId === undefined) delete process.env.HARDWARE_ID;
    else process.env.HARDWARE_ID = originalHardwareId;
    await teardownApi(t);
  });

  async function setLicenseKey(key: string) {
    await setSetting(t.db, "license_key", key);
  }

  function jsonResponse(rows: unknown) {
    return { ok: true, status: 200, json: async () => rows };
  }

  it("sin clave no consulta la nube y no tiene licencia", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const status = await revalidateLicense();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(status).toEqual({
      hasLicense: false,
      plan: "basico",
      active: false,
      online: false,
      expiresAt: null,
      changed: false,
    });
  });

  it("consulta get_license con la clave normalizada y las credenciales guardadas", async () => {
    await setLicenseKey("  clin-pro-123  ");
    const fetchMock = vi.fn(async () => jsonResponse([{ is_active: true }]));
    vi.stubGlobal("fetch", fetchMock);

    await revalidateLicense();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://test.supabase.co/rest/v1/rpc/get_license");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      apikey: "anon-test",
      Authorization: "Bearer anon-test",
    });
    expect(JSON.parse(init.body)).toEqual({ p_key: "CLIN-PRO-123" });
  });

  it("un error de red mantiene el plan y no degrada nada", async () => {
    await setLicenseKey("CLIN-PRO-123");
    await setSetting(t.db, "app_plan", "pro");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));

    const status = await revalidateLicense();

    expect(status).toMatchObject({
      hasLicense: true,
      plan: "pro",
      active: true,
      online: false,
      changed: false,
    });
    expect(await getLocalPlan()).toBe("pro");
  });

  it("una respuesta HTTP no-ok se trata como offline (no degrada)", async () => {
    await setLicenseKey("CLIN-PRO-123");
    await setSetting(t.db, "app_plan", "pro");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => null })));

    const status = await revalidateLicense();

    expect(status).toMatchObject({ plan: "pro", active: true, online: false, changed: false });
  });

  it("una respuesta que no es array se trata como offline", async () => {
    await setLicenseKey("CLIN-PRO-123");
    await setSetting(t.db, "app_plan", "pro");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ not: "array" })));

    const status = await revalidateLicense();

    expect(status).toMatchObject({ plan: "pro", active: true, online: false });
  });

  it("una clave inexistente baja a básico y propaga el plan", async () => {
    await setLicenseKey("CLIN-PRO-123");
    await setSetting(t.db, "app_plan", "pro");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));

    const status = await revalidateLicense();

    expect(status).toMatchObject({
      hasLicense: true,
      plan: "basico",
      active: false,
      online: true,
      expiresAt: null,
      changed: true,
    });
    expect(await getLocalPlan()).toBe("basico");
    expect((await t.db.setting.findUniqueOrThrow({ where: { key: "unlocked_plan_pro" } })).value).toBe("false");
    expect((await t.db.setting.findUniqueOrThrow({ where: { key: "storage_mode" } })).value).toBe("local");
  });

  it("una clave desactivada baja a básico", async () => {
    await setLicenseKey("CLIN-PRO-123");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ is_active: false }])));

    const status = await revalidateLicense();

    expect(status.plan).toBe("basico");
    expect(status.active).toBe(false);
  });

  it("una clave expirada baja a básico y devuelve la fecha", async () => {
    await setLicenseKey("CLIN-PRO-123");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      { is_active: true, expires_at: "2020-01-01T00:00:00.000Z" },
    ])));

    const status = await revalidateLicense();

    expect(status).toMatchObject({
      plan: "basico",
      active: false,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
  });

  it("una clave asignada a otro hardware baja a básico", async () => {
    await setLicenseKey("CLIN-PRO-123");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      { is_active: true, hardware_id: "POS-OTRA-PC", expires_at: "2099-01-01T00:00:00.000Z" },
    ])));

    const status = await revalidateLicense();

    expect(status).toMatchObject({ plan: "basico", active: false, online: true });
  });

  it("una clave válida asignada a este hardware sube a Pro", async () => {
    await setLicenseKey("CLIN-PRO-123");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      { is_active: true, hardware_id: "POS-TEST-01", expires_at: "2099-01-01T00:00:00.000Z" },
    ])));

    const status = await revalidateLicense();

    expect(status).toMatchObject({
      hasLicense: true,
      plan: "pro",
      active: true,
      online: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
      changed: true,
    });
    expect(await getLocalPlan()).toBe("pro");
  });

  it("si ya estaba en Pro, changed es false", async () => {
    await setLicenseKey("CLIN-PRO-123");
    await setSetting(t.db, "app_plan", "pro");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ is_active: true }])));

    const status = await revalidateLicense();

    expect(status.plan).toBe("pro");
    expect(status.changed).toBe(false);
  });

  it("una clave BASICO válida baja un equipo Pro a básico", async () => {
    await setLicenseKey("CLIN-BASICO-123");
    await setSetting(t.db, "app_plan", "pro");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ is_active: true }])));

    const status = await revalidateLicense();

    expect(status.plan).toBe("basico");
    expect(status.changed).toBe(true);
    expect(await getLocalPlan()).toBe("basico");
  });

  it("una clave válida sin hardware asignado se acepta", async () => {
    await setLicenseKey("CLIN-PRO-123");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ is_active: true, hardware_id: null }])));

    const status = await revalidateLicense();

    expect(status.plan).toBe("pro");
    expect(status.active).toBe(true);
  });
});
