"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { PackageSearch } from "lucide-react";
import Button from "@/components/ui/Button";
import { useModules } from "@/hooks/useModules";
import IngredientForm from "@/components/recetario/IngredientForm";
import ProductModifiersModal from "@/components/productos/ProductModifiersModal";
import { IngredientsTable, type IngredientView } from "@/components/recetario/IngredientsTable";
import { RecipeCardGrid, type RecipeView } from "@/components/recetario/RecipeCardGrid";
import { CostHistoryModal, type CostEntry } from "@/components/recetario/CostHistoryModal";
import { toast } from "react-hot-toast";

export default function RecetarioPage() {
  const { isModuleEnabled, plan } = useModules();
  const [tab, setTab] = useState<"ingredientes" | "elaborados">("ingredientes");

  // Elaborados
  const [recipes, setRecipes] = useState<RecipeView[]>([]);
  const [isLoadingRecipes, setIsLoadingRecipes] = useState(false);

  // Ingredientes
  const [ingredients, setIngredients] = useState<IngredientView[]>([]);
  const [isLoadingIngredients, setIsLoadingIngredients] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Ingredient form
  const [showIngredientForm, setShowIngredientForm] = useState(false);
  const [editingIngredient, setEditingIngredient] = useState<any | null>(null);

  // Cost history modal
  const [historyRecipe, setHistoryRecipe] = useState<RecipeView | null>(null);
  const [costHistory, setCostHistory] = useState<CostEntry[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Modifiers modal
  const [selectedRecipeForModifiers, setSelectedRecipeForModifiers] = useState<RecipeView | null>(null);
  const [isModifiersModalOpen, setIsModifiersModalOpen] = useState(false);
  const [businessSector, setBusinessSector] = useState("GASTRONOMIA");

  useEffect(() => {
    fetch("/api/store-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg?.businessSector) setBusinessSector(cfg.businessSector);
      })
      .catch(() => {});
  }, []);

  const isPro = plan === "pro";

  const loadRecipes = useCallback(async () => {
    setIsLoadingRecipes(true);
    try {
      const res = await fetch("/api/recipes");
      if (!res.ok) throw new Error("Error al cargar los elaborados.");
      setRecipes(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err.message || "Error al cargar los elaborados.");
    } finally {
      setIsLoadingRecipes(false);
    }
  }, []);

  const loadIngredients = useCallback(async () => {
    setIsLoadingIngredients(true);
    try {
      const res = await fetch("/api/products?kind=ingredients&limit=1000");
      if (!res.ok) throw new Error("Error al cargar los ingredientes.");
      const data = await res.json();
      setIngredients(Array.isArray(data) ? data : data.data || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Error al cargar los ingredientes.");
    } finally {
      setIsLoadingIngredients(false);
    }
  }, []);

  useEffect(() => {
    loadRecipes();
    loadIngredients();
  }, [loadRecipes, loadIngredients]);

  if (!isModuleEnabled("recetario")) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center space-y-3">
        <PackageSearch size={48} className="mx-auto text-foreground-muted" />
        <h1 className="text-xl font-bold text-foreground">
          Módulo Recetario desactivado
        </h1>
        <p className="text-sm text-foreground-muted">
          Activá el Recetario desde Configuración → Datos del Comercio → Módulos
          activables.
        </p>
        <Link href="/configuracion">
          <Button variant="primary" className="mt-2">
            Ir a Configuración
          </Button>
        </Link>
      </div>
    );
  }

  const openHistory = async (recipe: RecipeView) => {
    setHistoryRecipe(recipe);
    setIsLoadingHistory(true);
    setCostHistory([]);
    try {
      const res = await fetch(`/api/recipes/${recipe.id}/cost-history`);
      if (res.ok) setCostHistory(await res.json());
    } catch {
      // silencioso
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleToggleWeb = async (recipe: RecipeView, value: boolean) => {
    try {
      const res = await fetch(`/api/products/${recipe.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublicWeb: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "No se pudo actualizar la visibilidad.");
      }
      setRecipes((prev) =>
        prev.map((r) =>
          r.id === recipe.id ? { ...r, isPublicWeb: value } : r,
        ),
      );
      toast.success(
        value ? "Visible en la tienda web." : "Oculto de la tienda web.",
      );
    } catch (err: any) {
      toast.error(err.message || "Error al cambiar visibilidad.");
    }
  };

  const handleDeleteIngredient = async (ing: IngredientView) => {
    if (!confirm(`¿Eliminar el ingrediente "${ing.name}"?`)) return;
    try {
      const res = await fetch(`/api/products/${ing.id}`, { method: "DELETE" });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || "No se pudo eliminar.");
      }
      toast.success("Ingrediente eliminado.");
      loadIngredients();
    } catch (err: any) {
      toast.error(err.message || "No se pudo eliminar el ingrediente.");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-foreground flex items-center gap-2">
          Recetario
        </h1>
        <p className="mt-1 text-foreground-muted">
          Cargá tus ingredientes (materia prima) y definí los productos
          elaborados que los consumen.
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-border flex gap-2">
        <button
          onClick={() => setTab("ingredientes")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "ingredientes"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground"
          }`}
        >
          Ingredientes
          {ingredients.length > 0 && (
            <span className="ml-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">
              {ingredients.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab("elaborados")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "elaborados"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-foreground-muted hover:text-foreground"
          }`}
        >
          Productos Elaborados
          {recipes.length > 0 && (
            <span className="ml-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">
              {recipes.length}
            </span>
          )}
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
          {error}
        </div>
      )}

      {tab === "ingredientes" && (
        <IngredientsTable
          ingredients={ingredients}
          isLoading={isLoadingIngredients}
          onNewIngredient={() => {
            setEditingIngredient(null);
            setShowIngredientForm(true);
          }}
          onEditIngredient={(ing) => {
            setEditingIngredient(ing);
            setShowIngredientForm(true);
          }}
          onDeleteIngredient={handleDeleteIngredient}
        />
      )}

      {tab === "elaborados" && (
        <RecipeCardGrid
          recipes={recipes}
          isLoading={isLoadingRecipes}
          isPro={isPro}
          onOpenModifiers={(recipe) => {
            setSelectedRecipeForModifiers(recipe);
            setIsModifiersModalOpen(true);
          }}
          onOpenHistory={openHistory}
          onToggleWeb={handleToggleWeb}
        />
      )}

      {showIngredientForm && (
        <IngredientForm
          initial={editingIngredient}
          onClose={() => setShowIngredientForm(false)}
          onSaved={loadIngredients}
        />
      )}

      <CostHistoryModal
        recipe={historyRecipe}
        costHistory={costHistory}
        isLoading={isLoadingHistory}
        onClose={() => setHistoryRecipe(null)}
      />

      <ProductModifiersModal
        isOpen={isModifiersModalOpen}
        onClose={() => setIsModifiersModalOpen(false)}
        productId={selectedRecipeForModifiers?.id || 0}
        productName={selectedRecipeForModifiers?.name || ""}
        businessSector={businessSector}
        onSuccess={loadRecipes}
      />
    </div>
  );
}
