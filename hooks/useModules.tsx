"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useLicense, type LicenseTier } from "@/hooks/useLicense";

export interface UserSession {
  id: number;
  name: string;
  role: string;
}

export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMIN: ["*"],
  SUPERVISOR: [
    "/caja",
    "/ventas",
    "/productos",
    "/stock",
    "/combos",
    "/promociones",
    "/categorias",
    "/marcas",
    "/compras",
    "/gastos",
    "/clientes",
    "/cuenta-corriente",
    "/proveedores",
    "/vendedores",
  ],
  CASHIER: [
    "/caja",
    "/ventas",
  ],
};

interface ModuleContextType {
  isModuleEnabled: (moduleId: string) => boolean;
  modules: Record<string, boolean>;
  businessProfile: string;
  storageMode: string;
  cloudSyncEnabled: boolean;
  plan: 'basico' | 'pro';
  isLoading: boolean;
  refresh: () => Promise<void>;
  currentUser: UserSession | null;
  loginUser: (user: UserSession) => void;
  logout: () => void;
  supabaseLastSync: string;
  hasSupabaseConfig: boolean;
  tier: LicenseTier;
  isPro: boolean;
  isFree: boolean;
  rolePermissions: Record<string, string[]>;
  hasRolePermission: (role: string, pathPrefix: string) => boolean;
}

const ModuleContext = createContext<ModuleContextType | undefined>(undefined);

export const ModuleProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { tier, isPro, isFree, isLoading: licenseLoading } = useLicense();
  const [modules, setModules] = useState<Record<string, boolean>>({});
  const [businessProfile, setBusinessProfile] = useState<string>("general");
  const [storageMode, setStorageMode] = useState<string>("local");
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState<boolean>(false);
  const [plan, setPlan] = useState<'basico' | 'pro'>("basico");
  const [planLoaded, setPlanLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<UserSession | null>(null);
  const [supabaseLastSync, setSupabaseLastSync] = useState<string>("");
  const [hasSupabaseConfig, setHasSupabaseConfig] = useState<boolean>(false);
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>(DEFAULT_ROLE_PERMISSIONS);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("clinpos-user");
      if (stored) {
        try { setCurrentUser(JSON.parse(stored)); } catch { localStorage.removeItem("clinpos-user"); }
      }
    }
  }, []);

  const loginUser = (user: UserSession) => {
    setCurrentUser(user);
    localStorage.setItem("clinpos-user", JSON.stringify(user));
  };

  const logout = () => {
    setCurrentUser(null);
    localStorage.removeItem("clinpos-user");
  };

  const fetchModules = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error("Error fetching config");
      const data = await res.json();

      const parsedModules: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("module_")) {
          const moduleId = key.replace("module_", "");
          parsedModules[moduleId] = value === "true";
        }
      }
      setModules(parsedModules);
      if (data.business_profile) setBusinessProfile(data.business_profile);
      if (data.storage_mode) setStorageMode(data.storage_mode);
      // Modo local por defecto: solo se activa si el flag dice explícitamente true.
      setCloudSyncEnabled(
        data.cloud_sync_enabled === "true" || data.cloud_sync_enabled === "1",
      );
      
      const isProPlan = data.app_plan === 'pro' || data.plan_type === 'pro' || data.unlocked_plan_pro === 'true' || data.storage_mode === 'seguro';
      setPlan(isProPlan ? 'pro' : 'basico');

      if (data.role_permissions) {
        try {
          const parsedPerms = JSON.parse(data.role_permissions);
          setRolePermissions({
            ...DEFAULT_ROLE_PERMISSIONS,
            ...parsedPerms,
          });
        } catch {
          setRolePermissions(DEFAULT_ROLE_PERMISSIONS);
        }
      } else {
        setRolePermissions(DEFAULT_ROLE_PERMISSIONS);
      }

      setSupabaseLastSync(data.supabase_last_sync || "");
      setHasSupabaseConfig(!!data.supabase_url && !!data.supabase_anon_key);
    } catch (error) {
      console.error("Error loading modules context:", error);
    } finally {
      setPlanLoaded(true);
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModules();
  }, [fetchModules]);

  useEffect(() => {
    if (!licenseLoading) setIsLoading(false);
  }, [licenseLoading]);

  const isModuleEnabled = useCallback(
    (moduleId: string) => {
      // Módulos que dependen de la nube: apagados en modo local.
      if (!cloudSyncEnabled && ['pedidos_web', 'backup_nube'].includes(moduleId)) {
        return false;
      }
      // Módulos exclusivos del Plan Pro
      if (['cuenta_corriente', 'analiticas', 'roles', 'backup_nube', 'consignaciones', 'agente_ia', 'clinia', 'traspasos', 'pedidos_web'].includes(moduleId)) {
        if (!planLoaded) return true;
        return plan === 'pro';
      }
      // Módulos con toggle de configuración (setting `module_<id>`): respetan el valor guardado.
      if (modules[moduleId] !== undefined) {
        return modules[moduleId];
      }
      // Todos los demás módulos básicos están siempre habilitados por defecto.
      return true;
    },
    [plan, planLoaded, modules, cloudSyncEnabled]
  );

  const hasRolePermission = useCallback(
    (role: string, pathPrefix: string): boolean => {
      if (role === "ADMIN") return true;
      const perms = rolePermissions[role] || DEFAULT_ROLE_PERMISSIONS[role] || [];
      if (perms.includes("*")) return true;
      return perms.some((p) => pathPrefix.startsWith(p) || p.startsWith(pathPrefix));
    },
    [rolePermissions]
  );

  return (
    <ModuleContext.Provider
      value={{
        isModuleEnabled, modules, businessProfile, storageMode, cloudSyncEnabled, plan,
        isLoading, refresh: fetchModules, currentUser, loginUser, logout,
        supabaseLastSync, hasSupabaseConfig, tier, isPro, isFree,
        rolePermissions, hasRolePermission,
      }}
    >
      {children}
    </ModuleContext.Provider>
  );
};

export const useModules = () => {
  const context = useContext(ModuleContext);
  if (context === undefined) {
    throw new Error("useModules must be used within a ModuleProvider");
  }
  return context;
};
