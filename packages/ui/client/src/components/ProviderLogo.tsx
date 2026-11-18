import { createElement, useId, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon.js";
import { OpenferenceLogo } from "./OpenferenceLogo.js";
import { PROVIDER_LOGOS, type LogoData, type LogoNode, type ProviderLogoId } from "./providerLogoData.js";

/**
 * Real vendor logos for model providers and model families. Rendered bare — no
 * tile, no border — so they sit directly on the page like they do in DSH and
 * LobeChat. Marks with no match fall back to a neutral chip glyph.
 */

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Normalized provider id or name -> logo. Whole-word hits only; see `providerLogoFor`. */
const PROVIDER_ALIASES: Readonly<Record<string, ProviderLogoId>> = {
  deepseek: "deepseek",
  openai: "openai",
  anthropic: "anthropic",
  claude: "anthropic",
  google: "gemini",
  googlegemini: "gemini",
  gemini: "gemini",
  openrouter: "openrouter",
  groq: "groq",
  xai: "xai",
  grok: "xai",
  mistral: "mistral",
  mistralai: "mistral",
  ollama: "ollama",
  lmstudio: "lmstudio",
  together: "together",
  togetherai: "together",
  fireworks: "fireworks",
  fireworksai: "fireworks",
  cerebras: "cerebras",
  moonshot: "kimi",
  kimi: "kimi",
  zhipu: "zhipu",
  zhipuglm: "zhipu",
  glm: "zhipu",
  siliconflow: "siliconcloud",
  siliconcloud: "siliconcloud",
  perplexity: "perplexity",
  qwen: "qwen",
  minimax: "minimax",
  meta: "meta",
  nvidia: "nvidia",
  huggingface: "huggingface",
  cohere: "cohere",
  azure: "azure",
  vllm: "vllm",
};

const ALIASES_LONGEST_FIRST = Object.keys(PROVIDER_ALIASES).sort((a, b) => b.length - a.length);

/**
 * Logo for a provider. Pass the provider id first and its display name second.
 * An exact match wins; otherwise a name that starts with a vendor ("Ollama
 * (local)", "Azure OpenAI") takes that vendor's mark. Names that say they are
 * merely compatible with a vendor ("OpenAI-compatible") never do.
 */
export function providerLogoFor(...keys: (string | undefined)[]): ProviderLogoId | undefined {
  const normalized = keys.filter((k): k is string => !!k).map(normalize);
  for (const key of normalized) {
    const exact = PROVIDER_ALIASES[key];
    if (exact) return exact;
  }
  for (const key of normalized) {
    if (key.includes("compatible")) continue;
    const prefix = ALIASES_LONGEST_FIRST.find((alias) => alias.length >= 4 && key.startsWith(alias));
    if (prefix) return PROVIDER_ALIASES[prefix];
  }
  return undefined;
}

const MODEL_FAMILIES: readonly (readonly [RegExp, ProviderLogoId])[] = [
  [/deepseek/, "deepseek"],
  [/glm|zhipu/, "zhipu"],
  [/kimi|moonshot/, "kimi"],
  [/qwen|qwq/, "qwen"],
  [/minimax|abab/, "minimax"],
  [/claude/, "anthropic"],
  [/gemini|gemma/, "gemini"],
  [/gpt|openai|codex|(^|[^a-z0-9])o[134]([^a-z0-9]|$)/, "openai"],
  [/mistral|mixtral|codestral|devstral|magistral/, "mistral"],
  [/llama/, "meta"],
  [/grok/, "xai"],
  [/command|cohere/, "cohere"],
  [/nemotron/, "nvidia"],
  [/sonar|perplexity/, "perplexity"],
];

/** Logo for the lab that made a model, from its id or display name. */
export function modelLogoFor(...keys: (string | undefined)[]): ProviderLogoId | undefined {
  for (const key of keys) {
    if (!key) continue;
    const lower = key.toLowerCase();
    const hit = MODEL_FAMILIES.find(([pattern]) => pattern.test(lower));
    if (hit) return hit[1];
  }
  return undefined;
}

/** Ids and `url(#id)` references are made unique per rendered logo. */
function scoped(value: string, scope: string): string {
  return value.replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${scope}-${id})`);
}

function renderNode(node: LogoNode, scope: string, key: number): ReactNode {
  const props: Record<string, string | number> = { key };
  for (const [name, value] of Object.entries(node.attrs)) {
    props[name] = name === "id" ? `${scope}-${value}` : scoped(value, scope);
  }
  return createElement(node.tag, props, node.children?.map((child, i) => renderNode(child, scope, i)));
}

export function ProviderLogo({ logo, size = 18 }: { logo: ProviderLogoId; size?: number }) {
  // Gradients need ids that stay unique when the same logo appears twice on a page.
  const scope = `plogo${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const data: LogoData = PROVIDER_LOGOS[logo];
  const style = data.tint
    ? ({ "--plogo-dark": data.tint.dark, "--plogo-light": data.tint.light } as CSSProperties)
    : undefined;
  return (
    <svg
      className={`plogo${data.tint ? " plogo--tinted" : data.mono ? " plogo--mono" : ""}`}
      style={style}
      width={size}
      height={size}
      viewBox={data.viewBox}
      role="img"
      aria-label={data.title}
      {...data.rootAttrs}
    >
      {data.nodes.map((node, i) => renderNode(node, scope, i))}
    </svg>
  );
}

/** A provider's mark: Openference's own logo, a vendor logo, or a neutral glyph. */
export function ProviderMark({ id, name, size = 18 }: { id: string; name: string; size?: number }) {
  if (id === "openference") {
    return (
      <span className="plogo plogo--wrap" style={{ width: size, height: size }}>
        <OpenferenceLogo size={size} />
      </span>
    );
  }
  const logo = providerLogoFor(id, name);
  if (logo) return <ProviderLogo logo={logo} size={size} />;
  return (
    <span className="plogo plogo--fallback" style={{ width: size, height: size }} aria-hidden>
      <Icon name="cpu" size={Math.round(size * 0.85)} />
    </span>
  );
}
