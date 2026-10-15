import { PHOTO_EFFECT_CATEGORIES, PHOTO_EFFECTS, type PhotoEffect, type PhotoEffectCategory } from "@/data/effects";
import { TEMPLATES, type Template } from "@/data/templates";
import { catalogMediaUrl } from "@/data/catalogMedia";

export interface CatalogTheme {
  accent: string;
  secondary: string;
  background: string;
  surface: string;
  text: string;
}

export interface RuntimeCatalog {
  schemaVersion: number;
  settings: {
    productName: string;
    generationEnabled: boolean;
    captionEnabled: boolean;
    maintenanceNotice: string;
  };
  theme: CatalogTheme;
  templates: Template[];
  photoCategories: PhotoEffectCategory[];
  photoEffects: PhotoEffect[];
  release?: { id: string; version: number; publishedAt: string };
}

const FEATURED_IDS = new Set(["jinqu", "street", "dance", "quote"]);
const CACHE_KEY = "lyx_catalog_last_good_v1";
const API_BASE = import.meta.env.VITE_API_BASE || "";

export const DEFAULT_RUNTIME_CATALOG: RuntimeCatalog = {
  schemaVersion: 1,
  settings: { productName: "乐颜秀", generationEnabled: true, captionEnabled: true, maintenanceNotice: "" },
  theme: { accent: "#f23bd1", secondary: "#72f5d1", background: "#000000", surface: "#19191d", text: "#ffffff" },
  templates: TEMPLATES.map((template, index) => ({
    ...template,
    enabled: true,
    featured: FEATURED_IDS.has(template.id),
    sortOrder: (index + 1) * 10,
  })),
  photoCategories: PHOTO_EFFECT_CATEGORIES.map((category, index) => ({ ...category, enabled: true, sortOrder: (index + 1) * 10 })),
  photoEffects: PHOTO_EFFECTS.map((effect, index) => ({ ...effect, enabled: true, sortOrder: (index + 1) * 10 })),
};

function isCatalog(value: unknown): value is RuntimeCatalog {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeCatalog>;
  const settings = candidate.settings as RuntimeCatalog["settings"] | undefined;
  const theme = candidate.theme as RuntimeCatalog["theme"] | undefined;
  const hex = /^#[0-9a-fA-F]{6}$/;
  return candidate.schemaVersion === 1
    && Array.isArray(candidate.templates)
    && Array.isArray(candidate.photoCategories)
    && Array.isArray(candidate.photoEffects)
    && candidate.templates.every((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.cover === "string")
    && candidate.photoCategories.every((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.cover === "string")
    && candidate.photoEffects.every((item) => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.preview === "string")
    && typeof settings?.productName === "string"
    && typeof settings?.generationEnabled === "boolean"
    && typeof settings?.captionEnabled === "boolean"
    && typeof settings?.maintenanceNotice === "string"
    && Boolean(theme && hex.test(theme.accent) && hex.test(theme.secondary) && hex.test(theme.background) && hex.test(theme.surface) && hex.test(theme.text));
}

function ordered<T extends { sortOrder?: number }>(items: T[]) {
  return [...items].sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0));
}

export function projectCatalogForClient(catalog: RuntimeCatalog): RuntimeCatalog {
  const photoCategories = ordered(catalog.photoCategories.filter((item) => item.enabled !== false));
  const categoryIds = new Set(photoCategories.map((item) => item.id));
  return {
    ...catalog,
    templates: ordered(catalog.templates.filter((item) => item.enabled !== false)),
    photoCategories,
    photoEffects: ordered(catalog.photoEffects.filter((item) => item.enabled !== false && categoryIds.has(item.categoryId))),
  };
}

export function cachedCatalog(): RuntimeCatalog {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null") as unknown;
    return isCatalog(cached) ? projectCatalogForClient(cached) : DEFAULT_RUNTIME_CATALOG;
  } catch {
    return DEFAULT_RUNTIME_CATALOG;
  }
}

export async function fetchRuntimeCatalog(signal?: AbortSignal): Promise<RuntimeCatalog> {
  const response = await fetch(`${API_BASE}/api/catalog`, { signal, credentials: "omit", headers: { Accept: "application/json" } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0 || !isCatalog(json.data)) throw new Error(json.message || "配置服务暂不可用");
  const raw = json.data as RuntimeCatalog;
  const catalog = projectCatalogForClient({
    ...raw,
    templates: raw.templates.map((item) => ({ ...item, cover: catalogMediaUrl(item.cover, API_BASE)!, previewVideo: catalogMediaUrl(item.previewVideo, API_BASE) })),
    photoCategories: raw.photoCategories.map((item) => ({ ...item, cover: catalogMediaUrl(item.cover, API_BASE)! })),
    photoEffects: raw.photoEffects.map((item) => ({ ...item, preview: catalogMediaUrl(item.preview, API_BASE) })),
  });
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(catalog));
  } catch {
    // The in-memory catalog remains usable when storage quota is unavailable.
  }
  return catalog;
}
