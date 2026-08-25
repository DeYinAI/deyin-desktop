import { discoverPlugins } from "@deyin/agent-core";
import type { AgentsStore } from "@deyin/host-core";
import {
  DEFAULT_LOCAL_VISION_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  checkOllamaVisionModel,
  describeImagesViaOllama,
  formatUserMessageWithLocalVision,
  resolveLocalOllamaBaseUrl,
  type LocalVisionDescribeResult,
  type LocalVisionImage,
  type LocalVisionStatus,
  validateLocalVisionImages,
} from "@deyin/host-core/shared";

export const LOCAL_VISION_PLUGIN_NAME = "local-vision";

function pluginConfig(agents: AgentsStore): { baseUrl: string; model: string } {
  const secrets = agents.getPluginSecrets(LOCAL_VISION_PLUGIN_NAME);
  const rawBase = secrets.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;
  let baseUrl = DEFAULT_OLLAMA_BASE_URL;
  try {
    baseUrl = resolveLocalOllamaBaseUrl(rawBase);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const model = secrets.OLLAMA_VISION_MODEL?.trim() || DEFAULT_LOCAL_VISION_MODEL;
  return { baseUrl, model };
}

/** Desktop Local Vision: Ollama + moondream when the registry plugin is installed and enabled. */
export class LocalVisionService {
  constructor(
    private readonly pluginsDir: string,
    private readonly agents: AgentsStore,
  ) {}

  private async pluginRow(): Promise<{ installed: boolean; enabled: boolean }> {
    const plugins = await discoverPlugins(this.pluginsDir).catch(() => []);
    const row = plugins.find((p) => p.name === LOCAL_VISION_PLUGIN_NAME);
    if (!row) return { installed: false, enabled: false };
    const enabled = !this.agents.disabledCaps().has(`plugin:${LOCAL_VISION_PLUGIN_NAME}`);
    return { installed: true, enabled };
  }

  async status(): Promise<LocalVisionStatus> {
    const secrets = this.agents.getPluginSecrets(LOCAL_VISION_PLUGIN_NAME);
    const rawBase = secrets.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;
    const model = secrets.OLLAMA_VISION_MODEL?.trim() || DEFAULT_LOCAL_VISION_MODEL;
    const { installed, enabled } = await this.pluginRow();
    let baseUrl = rawBase;
    try {
      baseUrl = resolveLocalOllamaBaseUrl(rawBase);
    } catch {
      return {
        pluginInstalled: installed,
        pluginEnabled: enabled,
        ollamaReachable: false,
        modelAvailable: false,
        model,
        baseUrl: rawBase,
      };
    }
    const health = installed && enabled ? await checkOllamaVisionModel(baseUrl, model) : { reachable: false, modelAvailable: false };
    return {
      pluginInstalled: installed,
      pluginEnabled: enabled,
      ollamaReachable: health.reachable,
      modelAvailable: health.modelAvailable,
      model,
      baseUrl,
    };
  }

  async describeLocal(images: LocalVisionImage[], userText?: string): Promise<LocalVisionDescribeResult> {
    const { installed, enabled } = await this.pluginRow();
    if (!installed) {
      return { ok: false, error: "Install the Local Vision plugin from Settings → Capabilities → Plugins." };
    }
    if (!enabled) {
      return { ok: false, error: "Enable the Local Vision plugin in Settings → Capabilities → Plugins." };
    }
    const imageError = validateLocalVisionImages(images);
    if (imageError) return { ok: false, error: imageError };
    let baseUrl: string;
    let model: string;
    try {
      ({ baseUrl, model } = pluginConfig(this.agents));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
    const health = await checkOllamaVisionModel(baseUrl, model);
    if (!health.reachable) {
      return {
        ok: false,
        error: `Ollama is not reachable at ${baseUrl}. Install Ollama and ensure it is running.`,
      };
    }
    if (!health.modelAvailable) {
      return {
        ok: false,
        error: `Pull the vision model first: \`ollama pull ${model}\` (~1.7 GB for moondream).`,
      };
    }
    try {
      const descriptions = await describeImagesViaOllama(images, { baseUrl, model });
      const prompt = userText !== undefined ? formatUserMessageWithLocalVision(userText, descriptions) : undefined;
      return { ok: true, model, descriptions, prompt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
}
