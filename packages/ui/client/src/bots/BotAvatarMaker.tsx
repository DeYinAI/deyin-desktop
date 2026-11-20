import { useReducer, useRef, useState } from "react";
import { AVATAR_PROMPT_LIMIT, checkAvatarPrompt } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import {
  AVATAR_MAKER_CLOSED,
  avatarMakerReducer,
  chosenModel,
  makeAvatarPicture,
  type AvatarMakerApi,
  type AvatarMakerState,
  type AvatarModelChoice,
} from "./botAvatarMaker.js";

export interface BotAvatarMakerViewProps {
  state: AvatarMakerState;
  prompt: string;
  /** The image models to choose from; none means the maker explains what to add. */
  choices: readonly AvatarModelChoice[];
  modelKey: string;
  disabled?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPrompt: (value: string) => void;
  onModel: (key: string) => void;
  onMake: () => void;
  onUse: () => void;
  onRetry: () => void;
}

/** Make a Bot's picture from a description: describe it, look at it, then use it or ask again. Nothing is saved here. */
export function BotAvatarMakerView(props: BotAvatarMakerViewProps) {
  const t = useT();
  const { state, prompt, choices, modelKey } = props;
  if (state.phase === "closed") {
    return (
      <button type="button" className="btn btn--ghost" disabled={props.disabled} onClick={props.onOpen}>
        {t("bot.avatar.make")}
      </button>
    );
  }
  const making = state.phase === "making";
  const canMake = !making && choices.length > 0 && checkAvatarPrompt(prompt).ok;
  return (
    <div className="bot-maker" role="group" aria-label={t("bot.avatar.make")}>
      {state.phase === "review" ? (
        <div className="bot-maker__review">
          <img className="bot-maker__preview" src={state.url} alt={t("bot.avatar.preview")} width={96} height={96} />
          <div className="bot-maker__actions">
            <button type="button" className="btn btn--primary" onClick={props.onUse}>
              {t("bot.avatar.use")}
            </button>
            <button type="button" className="btn btn--ghost" onClick={props.onRetry}>
              {t("bot.avatar.again")}
            </button>
            <button type="button" className="btn btn--ghost" onClick={props.onClose}>
              {t("bot.avatar.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <label className="field__label" htmlFor="bot-maker-prompt">
            {t("bot.avatar.describe")}
          </label>
          <textarea
            id="bot-maker-prompt"
            className="input bot-maker__prompt"
            rows={2}
            value={prompt}
            maxLength={AVATAR_PROMPT_LIMIT}
            placeholder={t("bot.avatar.placeholder")}
            disabled={making}
            onChange={(event) => props.onPrompt(event.target.value)}
          />
          {choices.length > 1 ? (
            <select className="input" aria-label={t("bot.avatar.model")} value={modelKey} disabled={making} onChange={(event) => props.onModel(event.target.value)}>
              {choices.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.label}
                </option>
              ))}
            </select>
          ) : null}
          {choices.length === 0 ? <p className="hint">{t("bot.avatar.noModel")}</p> : null}
          {state.phase === "editing" && state.error ? (
            <p className="field__error" role="alert">
              {state.error}
            </p>
          ) : null}
          {making ? (
            <p className="hint" role="status">
              {t("bot.avatar.making")}
            </p>
          ) : null}
          <div className="bot-maker__actions">
            <button type="button" className="btn btn--primary" disabled={!canMake} onClick={props.onMake}>
              {t("bot.avatar.go")}
            </button>
            <button type="button" className="btn btn--ghost" onClick={props.onClose}>
              {t("bot.avatar.cancel")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface BotAvatarMakerProps {
  api: AvatarMakerApi;
  choices: readonly AvatarModelChoice[];
  /** The Bot's name, so the picture is made for it. */
  botName: string;
  disabled?: boolean;
  /** The person chose the picture. It is the form's avatar from here on; saving the Bot is still theirs to do. */
  onUse: (url: string) => void;
}

export function BotAvatarMaker({ api, choices, botName, disabled, onUse }: BotAvatarMakerProps) {
  const [state, dispatch] = useReducer(avatarMakerReducer, AVATAR_MAKER_CLOSED);
  const [prompt, setPrompt] = useState("");
  const [modelKey, setModelKey] = useState("");
  // A picture that arrives after the maker was closed (or restarted) belongs to a request nobody is waiting for.
  const request = useRef(0);

  const make = (): void => {
    const check = checkAvatarPrompt(prompt);
    const model = chosenModel(choices, modelKey);
    if (state.phase !== "editing" || !check.ok || !model) return;
    request.current += 1;
    const mine = request.current;
    dispatch({ type: "start" });
    void makeAvatarPicture(api, { prompt: check.text, model: model.model, providerId: model.providerId, botName }).then((outcome) => {
      if (request.current !== mine) return;
      dispatch(outcome.kind === "made" ? { type: "made", url: outcome.url } : { type: "failed", error: outcome.error });
    });
  };

  return (
    <BotAvatarMakerView
      state={state}
      prompt={prompt}
      choices={choices}
      modelKey={chosenModel(choices, modelKey)?.key ?? ""}
      disabled={disabled}
      onOpen={() => dispatch({ type: "open" })}
      onClose={() => {
        request.current += 1;
        dispatch({ type: "close" });
      }}
      onPrompt={setPrompt}
      onModel={setModelKey}
      onMake={make}
      onUse={() => {
        if (state.phase !== "review") return;
        onUse(state.url);
        dispatch({ type: "close" });
      }}
      onRetry={() => dispatch({ type: "retry" })}
    />
  );
}
