import type { BotResult, DeyinApi } from "@deyin/contract";
import type { BotAvatarRequest, ModelInfo, ProviderInfo } from "@deyin/host-core/shared";

/** The call that makes a picture. Absent where Bots have no host (chat-only web), which hides the maker. */
export type AvatarMakerApi = NonNullable<DeyinApi["botAvatar"]>;

/** One image model a picture can be made with, as the person sees it in the list. */
export interface AvatarModelChoice {
  key: string;
  providerId: string;
  model: string;
  label: string;
}

/**
 * The text-to-image models the person has: the account's, then each enabled provider's own. Chat models that
 * can also draw are left out; the picture endpoint is what a model needs here.
 */
export function avatarModelChoices(account: readonly ModelInfo[], providers: readonly ProviderInfo[]): AvatarModelChoice[] {
  const choices: AvatarModelChoice[] = account
    .filter((model) => model.kind === "image")
    .map((model) => ({ key: `openference::${model.id}`, providerId: "openference", model: model.id, label: model.name || model.id }));
  for (const provider of providers) {
    if (provider.kind !== "custom" || !provider.enabled) continue;
    for (const model of provider.models) {
      if (model.kind !== "image" || provider.disabledModels.includes(model.id)) continue;
      choices.push({ key: `${provider.id}::${model.id}`, providerId: provider.id, model: model.id, label: `${model.name || model.id} (${provider.name})` });
    }
  }
  return choices;
}

/** Where making a picture stands. `closed` is the page without the maker open. */
export type AvatarMakerState =
  | { phase: "closed" }
  | { phase: "editing"; error: string | null }
  | { phase: "making" }
  | { phase: "review"; url: string };

export type AvatarMakerEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "start" }
  | { type: "made"; url: string }
  | { type: "failed"; error: string }
  /** Look at the description again, to change it or ask for another picture. */
  | { type: "retry" };

export const AVATAR_MAKER_CLOSED: AvatarMakerState = { phase: "closed" };

/**
 * What an event does to the maker. An event that does not fit the state (a picture that arrives after the maker
 * was closed, a second start) changes nothing, so a late answer can never reopen a panel or replace a choice.
 */
export function avatarMakerReducer(state: AvatarMakerState, event: AvatarMakerEvent): AvatarMakerState {
  switch (event.type) {
    case "open":
      return state.phase === "closed" ? { phase: "editing", error: null } : state;
    case "close":
      return AVATAR_MAKER_CLOSED;
    case "start":
      return state.phase === "editing" ? { phase: "making" } : state;
    case "made":
      return state.phase === "making" ? { phase: "review", url: event.url } : state;
    case "failed":
      return state.phase === "making" ? { phase: "editing", error: event.error } : state;
    case "retry":
      return state.phase === "review" ? { phase: "editing", error: null } : state;
    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled avatar maker event: ${JSON.stringify(unhandled)}`);
    }
  }
}

export type MakeOutcome = { kind: "made"; url: string } | { kind: "failed"; error: string };

/**
 * Ask the host for a picture. A refusal ("sign in first") and a call that rejects both come back as `failed`
 * with text, so the maker never stays on "making" waiting for something that will not arrive.
 */
export async function makeAvatarPicture(api: AvatarMakerApi, request: BotAvatarRequest): Promise<MakeOutcome> {
  try {
    const result: BotResult<{ url: string }> = await api.generate(request);
    return result.ok ? { kind: "made", url: result.value.url } : { kind: "failed", error: result.error };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** The model chosen from the list, or the first one when the choice is gone (the provider was turned off). */
export function chosenModel(choices: readonly AvatarModelChoice[], key: string): AvatarModelChoice | undefined {
  return choices.find((choice) => choice.key === key) ?? choices[0];
}
