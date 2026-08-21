import type { ProviderApiFormat } from "./transports.js";

/**
 * Which model a given step should run on. Roles map to the phases of a run:
 * `plan`/`ask`/`delivery` follow the composer mode, `implement` is the default
 * working role (composer mode "agent"), and `tool` is the opportunistic cheap
 * role for mechanical tool churn (see {@link roleForStep}).
 */
export type ModelRole = "implement" | "plan" | "ask" | "delivery" | "tool";

export const MODEL_ROLES: readonly ModelRole[] = ["implement", "plan", "ask", "delivery", "tool"];

export function isModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && (MODEL_ROLES as readonly string[]).includes(value);
}

/** Composer mode -> the role that owns it. Unknown modes fall back to `implement`. */
export function roleForMode(mode: string | undefined): ModelRole {
  switch (mode) {
    case "plan":
      return "plan";
    case "ask":
      return "ask";
    case "delivery":
      return "delivery";
    default:
      return "implement";
  }
}

/** What the previous step produced, used to detect mechanical tool churn. */
export interface PreviousStep {
  /** True when the assistant emitted prose alongside (or instead of) tool calls. */
  hadProse: boolean;
  /** Tools the previous step called, in order. */
  toolNames: string[];
  /** True when every tool called was read-tier (no writes, no shell, no prompts). */
  allRead: boolean;
}

export interface StepRoleInput {
  /** 1-based step index within the run. */
  step: number;
  /** Live composer mode; mid-run switch_mode calls change this between steps. */
  mode?: string;
  previous?: PreviousStep;
}

/**
 * Pick the role for a step.
 *
 * The first step of a run, and any step that follows a step which produced prose
 * or touched the workspace, belongs to the mode's own role — that is where the
 * reasoning happens. A step that merely continues read-only churn (the previous
 * step called only read-tier tools and said nothing) is routed to `tool`, so a
 * cheap fast model can grind through greps and file reads.
 *
 * Restricting the cheap role to read-tier churn is deliberate: handing `edit`,
 * `write` or `bash` results to a weaker model is where quality actually breaks.
 */
export function roleForStep(input: StepRoleInput): ModelRole {
  const previous = input.previous;
  if (input.step > 1 && previous && !previous.hadProse && previous.toolNames.length > 0 && previous.allRead) {
    return "tool";
  }
  return roleForMode(input.mode);
}

/** A model reference as stored in settings: "providerId::modelId", or a bare model id. */
export interface ModelRef {
  /** Absent for a bare "modelId" reference, which keeps the run's own provider. */
  providerId?: string;
  model: string;
}

/**
 * Parse a `"providerId::modelId"` settings value. A bare value (no separator)
 * names a model on whichever provider the run is already using — the same
 * convention `subagentModels` uses. Blank/garbage values return undefined so a
 * half-filled settings field never breaks a run.
 */
export function parseModelRef(ref: string | undefined | null): ModelRef | undefined {
  if (typeof ref !== "string") return undefined;
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const sep = trimmed.indexOf("::");
  if (sep < 0) return { model: trimmed };
  const providerId = trimmed.slice(0, sep).trim();
  const model = trimmed.slice(sep + 2).trim();
  if (!model) return undefined;
  return providerId ? { providerId, model } : { model };
}

/** Everything needed to address one provider endpoint. */
export interface ProviderRouting {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
  apiFormat?: ProviderApiFormat;
  authHeader?: boolean;
}

/** The run's own model + endpoint, used whenever a role has no override. */
export interface RouterBase extends ProviderRouting {
  model: string;
  providerId: string;
  contextLength?: number;
}

/** Resolved routing for a single step, as consumed by the agent loop. */
export interface StepRouting extends ProviderRouting {
  model: string;
  providerId: string;
  role: ModelRole;
  contextLength?: number;
}

export type StepRouter = (input: StepRoleInput) => StepRouting;

export interface RoleRouterOptions {
  /** role -> "providerId::modelId". Roles left out fall back to the run's model. */
  roleModels: Record<string, string>;
  base: RouterBase;
  /** Route a non-default provider id to its endpoint; omit for single-provider hosts. */
  resolveProvider?: (providerId: string) => ProviderRouting | undefined;
  /** Context window for a routed model, so compaction follows the model in use. */
  getContextLength?: (providerId: string, model: string) => number | undefined;
}

/**
 * Build a per-step router from the user's role -> model table.
 *
 * Returns undefined when no role carries a usable override, which lets callers
 * skip the routing path entirely and keep the single-model behaviour (and its
 * prompt-cache key) byte-for-byte unchanged.
 */
export function createRoleRouter(opts: RoleRouterOptions): StepRouter | undefined {
  const refs = new Map<ModelRole, ModelRef>();
  for (const [role, value] of Object.entries(opts.roleModels ?? {})) {
    if (!isModelRole(role)) continue;
    const ref = parseModelRef(value);
    if (ref) refs.set(role, ref);
  }
  if (refs.size === 0) return undefined;

  const cache = new Map<ModelRole, StepRouting>();

  const resolve = (role: ModelRole): StepRouting => {
    const cached = cache.get(role);
    if (cached) return cached;

    const ref = refs.get(role);
    let routing: StepRouting;
    if (!ref) {
      routing = { ...opts.base, role };
    } else {
      const providerId = ref.providerId ?? opts.base.providerId;
      const endpoint =
        providerId === opts.base.providerId
          ? opts.base
          : (opts.resolveProvider?.(providerId) ?? opts.base);
      routing = {
        role,
        model: ref.model,
        providerId,
        apiBaseUrl: endpoint.apiBaseUrl,
        getToken: endpoint.getToken,
        apiFormat: endpoint.apiFormat,
        authHeader: endpoint.authHeader,
        contextLength:
          opts.getContextLength?.(providerId, ref.model) ??
          (ref.model === opts.base.model ? opts.base.contextLength : undefined),
      };
    }
    cache.set(role, routing);
    return routing;
  };

  return (input) => resolve(roleForStep(input));
}
