/**
 * Deyin's three products and how the shell moves between them.
 *
 * The logo menu switches the whole interface between Deyin Code, Deyin Bot and Deyin
 * Conductor. Each product owns its sidebar body, its new-item action and its center
 * column; the title bar, settings, profile, plugins and search are shared chrome.
 *
 * Everything here is pure so the switching rules can be tested without a DOM:
 * which product a view or thread belongs to, where a product reopens, and what is
 * remembered per product so switching away and back is not destructive.
 */
import { PRODUCT_IDS, isProductId } from "@deyin/host-core/shared";
import type { ChatMode, MessageKey, ProductId, Project, Thread } from "@deyin/host-core/shared";
import type { IconName } from "./components/Icon.js";
import type { View } from "./views.js";

/** Views a product's own shell renders; every other view is shared chrome. */
export type ProductView = Extract<View, "workspace" | "conductor" | "workflows" | "bot" | "botDetail" | "botMarket">;

export interface Product {
  id: ProductId;
  /** Brand name, never translated. */
  label: string;
  /** i18n key for the one-line description under the name in the switcher. */
  taglineKey: MessageKey;
  /** i18n key for the sidebar's primary create action. */
  newItemKey: MessageKey;
  icon: IconName;
  /** Tint of the logo mark, so each product reads differently at a glance. */
  tint: string;
  /** Where the product opens when it has nothing remembered. */
  homeView: ProductView;
  /** Every view this product's shell can show. */
  views: readonly ProductView[];
  /** Composer modes the product offers. The first is the default. */
  chatModes: readonly ChatMode[];
  /** Which list fills the sidebar body. */
  sidebar: "threads" | "bots" | "pipelines";
  /**
   * Needs a runtime (a local shell and git, or a server) to do its job, so it is
   * hidden on a hosted chat-only build.
   */
  requiresRuntime: boolean;
}

export const PRODUCTS: Readonly<Record<ProductId, Product>> = {
  code: {
    id: "code",
    label: "Deyin Code",
    taglineKey: "product.code.tagline",
    newItemKey: "product.code.new",
    icon: "terminal",
    tint: "#9db4ff",
    homeView: "workspace",
    views: ["workspace"],
    chatModes: ["agent", "plan", "ask", "delivery"],
    sidebar: "threads",
    requiresRuntime: false,
  },
  bot: {
    id: "bot",
    label: "Deyin Bot",
    taglineKey: "product.bot.tagline",
    newItemKey: "product.bot.new",
    icon: "bot",
    tint: "#7fe0c0",
    homeView: "bot",
    views: ["bot", "botDetail", "botMarket"],
    chatModes: ["agent"],
    sidebar: "bots",
    requiresRuntime: true,
  },
  conductor: {
    id: "conductor",
    label: "Deyin Conductor",
    taglineKey: "product.conductor.tagline",
    newItemKey: "conductor.newRun",
    icon: "route",
    tint: "#f0b36b",
    homeView: "conductor",
    views: ["conductor", "workflows"],
    chatModes: ["conductor"],
    sidebar: "pipelines",
    requiresRuntime: true,
  },
};

/** The products a host offers, in switcher order. A chat-only host has no runtime, so only Code. */
export function availableProducts(chatOnly: boolean): Product[] {
  return PRODUCT_IDS.map((id) => PRODUCTS[id]).filter((product) => !(chatOnly && product.requiresRuntime));
}

/** A saved or requested product, or Code when it is unknown or this host cannot run it. */
export function coerceProduct(value: unknown, chatOnly: boolean): ProductId {
  return isProductId(value) && availableProducts(chatOnly).some((product) => product.id === value) ? value : "code";
}

/**
 * The product a view belongs to. Shared views (settings, plugins, automations, ...) belong to
 * whichever product the user is already in, so opening Settings never changes the shell.
 */
export function productOfView(view: View, current: ProductId): ProductId {
  switch (view) {
    case "workspace":
      return "code";
    case "conductor":
    case "workflows":
      return "conductor";
    case "bot":
    case "botDetail":
    case "botMarket":
      return "bot";
    case "settings":
    case "upgrade":
    case "automations":
    case "plugins":
    case "superagent":
      return current;
    default: {
      const unhandled: never = view;
      throw new Error(`Unhandled view: ${String(unhandled)}`);
    }
  }
}

/**
 * The view to land on when a product is reopened from where it was left. A Bot's details page and the marketplace
 * are visits, not places worth returning to; coming back lands on the Bot's chat or home instead.
 */
export function restorableView(view: ProductView): ProductView {
  switch (view) {
    case "botDetail":
    case "botMarket":
      return "bot";
    case "workspace":
    case "conductor":
    case "workflows":
    case "bot":
      return view;
    default: {
      const unhandled: never = view;
      throw new Error(`Unhandled view: ${String(unhandled)}`);
    }
  }
}

/** True when `view` belongs to a product's own shell, as opposed to shared chrome. */
export function isProductView(view: View): view is ProductView {
  return (Object.values(PRODUCTS) as Product[]).some((product) => (product.views as readonly View[]).includes(view));
}

/** The product a conversation belongs to: a Bot's thread is Bot's, a pipeline run is Conductor's. */
export function productOfThread(thread: Pick<Thread, "mode" | "botId">): ProductId {
  if (thread.botId) return "bot";
  return thread.mode === "conductor" ? "conductor" : "code";
}

/** Where the user was inside one product. Only product-owned views are remembered. */
export interface ProductPlace {
  view: ProductView;
  projectId: string | null;
  threadId: string | null;
}

export type ProductPlaces = Partial<Record<ProductId, ProductPlace>>;

export function rememberPlace(places: ProductPlaces, product: ProductId, place: ProductPlace): ProductPlaces {
  const prev = places[product];
  if (prev && prev.view === place.view && prev.projectId === place.projectId && prev.threadId === place.threadId) {
    return places;
  }
  return { ...places, [product]: place };
}

/** Where a product opens, and the composer mode that goes with it. */
export interface ProductTarget {
  product: ProductId;
  view: ProductView;
  projectId: string | null;
  threadId: string | null;
  composerMode: ChatMode;
}

interface ThreadRef {
  project: Project;
  thread: Thread;
}

function liveThreads(projects: readonly Project[], product: ProductId): ThreadRef[] {
  return projects.flatMap((project) =>
    project.threads
      .filter((thread) => !thread.archived && productOfThread(thread) === product)
      .map((thread) => ({ project, thread })),
  );
}

/**
 * Decide where switching to `to` lands.
 *
 * It returns to the thread and view the user last used in that product when they still
 * exist, otherwise the product's most recently active thread (preferring the current
 * project), otherwise the product's home with no thread. A remembered thread that was
 * archived, deleted, or now belongs to another product is ignored rather than trusted.
 */
export function resolveProductSwitch(
  to: ProductId,
  places: ProductPlaces,
  projects: readonly Project[],
  currentProjectId: string | null,
): ProductTarget {
  const product = PRODUCTS[to];
  const remembered = places[to];
  const candidates = liveThreads(projects, to);

  const rememberedRef = remembered?.threadId
    ? candidates.find((ref) => ref.thread.id === remembered.threadId)
    : undefined;
  const newest = (refs: ThreadRef[]): ThreadRef | undefined =>
    [...refs].sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)[0];
  const picked =
    rememberedRef ??
    newest(candidates.filter((ref) => ref.project.id === currentProjectId)) ??
    newest(candidates);

  const view =
    remembered && (product.views as readonly ProductView[]).includes(remembered.view)
      ? remembered.view
      : product.homeView;
  const mode = picked?.thread.mode;
  const composerMode = mode && product.chatModes.includes(mode) ? mode : product.chatModes[0]!;

  return {
    product: to,
    view,
    projectId: picked?.project.id ?? remembered?.projectId ?? currentProjectId,
    threadId: picked?.thread.id ?? null,
    composerMode,
  };
}

export const PRODUCT_PLACES_KEY = "deyin.productPlaces";

type PlaceStore = Pick<Storage, "getItem" | "setItem">;

function parsePlace(product: ProductId, value: unknown): ProductPlace | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const views = PRODUCTS[product].views as readonly unknown[];
  if (!views.includes(raw.view)) return null;
  const id = (field: unknown): string | null => (typeof field === "string" && field.length > 0 ? field : null);
  return { view: raw.view as ProductView, projectId: id(raw.projectId), threadId: id(raw.threadId) };
}

/** Saved places, dropping anything malformed so a corrupt blob can never break startup. */
export function parseProductPlaces(raw: string | null): ProductPlaces {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const places: ProductPlaces = {};
  for (const id of PRODUCT_IDS) {
    const place = parsePlace(id, (parsed as Record<string, unknown>)[id]);
    if (place) places[id] = place;
  }
  return places;
}

export function loadProductPlaces(store: PlaceStore): ProductPlaces {
  try {
    return parseProductPlaces(store.getItem(PRODUCT_PLACES_KEY));
  } catch {
    return {};
  }
}

export function saveProductPlaces(store: PlaceStore, places: ProductPlaces): void {
  try {
    store.setItem(PRODUCT_PLACES_KEY, JSON.stringify(places));
  } catch {
    // Storage full or blocked: the places only help the next switch, so losing them is harmless.
  }
}
