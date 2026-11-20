import {
  BOT_LIMITS,
  checkBotFields,
  cleanBotLine,
  cleanBotText,
  defaultBotAvatar,
  type BotAvatarColor,
  type BotAvatarShape,
  type BotInput,
  type BotPatch,
  type BotResult,
  type DeyinBot,
} from "@deyin/host-core/shared";

/** What the create and edit forms hold. Text is kept exactly as typed; it is cleaned only when sent. */
export interface BotForm {
  name: string;
  title: string;
  description: string;
  role: string;
  purpose: string;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  /** An uploaded picture as a data URL, or null to use the shape. */
  avatarUrl: string | null;
}

/** A blank form with the avatar a Bot of this seed would get by default, so "Create" never starts with black. */
export function newBotForm(seed: string): BotForm {
  const avatar = defaultBotAvatar(seed);
  return {
    name: "",
    title: "",
    description: "",
    role: "",
    purpose: "",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarUrl: null,
  };
}

export function formFromBot(bot: DeyinBot): BotForm {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    role: bot.role,
    purpose: bot.purpose ?? "",
    avatarShape: bot.avatarShape,
    avatarColor: bot.avatarColor,
    avatarUrl: bot.avatarUrl ?? null,
  };
}

/** The values as the host will store them, so "changed" means changed after cleaning. */
function cleaned(form: BotForm) {
  return {
    name: cleanBotLine(form.name),
    title: cleanBotLine(form.title),
    role: cleanBotLine(form.role),
    description: cleanBotText(form.description),
    purpose: cleanBotText(form.purpose),
  };
}

/** The first thing wrong with the form, in the host's own words, or null when it can be sent. */
export function formProblem(form: BotForm, mode: "create" | "update"): string | null {
  const values = cleaned(form);
  return checkBotFields(
    {
      name: values.name,
      title: values.title,
      role: values.role,
      description: values.description,
      purpose: values.purpose,
      avatarShape: form.avatarShape,
      avatarColor: form.avatarColor,
      ...(form.avatarUrl !== null ? { avatarUrl: form.avatarUrl } : {}),
    },
    mode,
  );
}

/** The request that creates a Bot from the form. Empty optional fields are left out so the store's defaults apply. */
export function formToInput(form: BotForm): BotInput {
  const values = cleaned(form);
  return {
    name: values.name,
    avatarShape: form.avatarShape,
    avatarColor: form.avatarColor,
    ...(values.title ? { title: values.title } : {}),
    ...(values.role ? { role: values.role } : {}),
    ...(values.description ? { description: values.description } : {}),
    ...(values.purpose ? { purpose: values.purpose } : {}),
  };
}

/**
 * Only the fields that differ from the saved Bot, so saving an untouched form sends nothing and
 * never bumps `updatedAt` or the avatar version. A cleared title, role or description is sent as
 * an empty string (it is a real value); a removed picture is sent as `null`.
 */
export function formToPatch(bot: DeyinBot, form: BotForm): BotPatch {
  const values = cleaned(form);
  const patch: BotPatch = {};
  if (values.name !== bot.name) patch.name = values.name;
  if (values.title !== bot.title) patch.title = values.title;
  if (values.role !== bot.role) patch.role = values.role;
  if (values.description !== bot.description) patch.description = values.description;
  if (values.purpose !== (bot.purpose ?? "")) patch.purpose = values.purpose;
  if (form.avatarShape !== bot.avatarShape) patch.avatarShape = form.avatarShape;
  if (form.avatarColor !== bot.avatarColor) patch.avatarColor = form.avatarColor;
  if (form.avatarUrl !== (bot.avatarUrl ?? null)) patch.avatarUrl = form.avatarUrl;
  return patch;
}

export function isFormDirty(bot: DeyinBot, form: BotForm): boolean {
  return Object.keys(formToPatch(bot, form)).length > 0;
}

/** Biggest picture file accepted. Base64 adds a third, so this stays inside the host's data-URL limit. */
export const AVATAR_MAX_FILE_BYTES = 200 * 1024;
export const AVATAR_FILE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

export type AvatarFileCheck = "ok" | "type" | "size";

/** Whether a chosen file can be an avatar. SVG is refused on purpose: it can carry script. */
export function checkAvatarFile(file: { type: string; size: number }): AvatarFileCheck {
  if (!AVATAR_FILE_TYPES.includes(file.type)) return "type";
  if (file.size > AVATAR_MAX_FILE_BYTES) return "size";
  return "ok";
}

/** The largest data URL the host accepts, restated so a test can prove the file limit fits inside it. */
export const AVATAR_MAX_DATA_URL_CHARS = BOT_LIMITS.avatarUrl;

/** Read a chosen picture as a data URL. */
export function readAvatarDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read that file."));
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read that file.")));
    reader.readAsDataURL(file);
  });
}

export type SubmitOutcome<T> = { kind: "done"; value: T } | { kind: "failed"; error: string };

/**
 * Send a form to the host and say what happened. A refusal and a call that rejects (a dropped IPC
 * channel, say) both come back as `failed` with a message, so a form never stays locked waiting on
 * a promise that will not resolve with a value.
 */
export async function submitBotForm<T>(send: () => Promise<BotResult<T>>): Promise<SubmitOutcome<T>> {
  try {
    const result = await send();
    return result.ok ? { kind: "done", value: result.value } : { kind: "failed", error: result.error };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The form after the saved Bot changed underneath it (another window, a run). An untouched form follows
 * the change; one with edits keeps them, so typing is never overwritten.
 */
export function followSavedBot(previous: DeyinBot, next: DeyinBot, form: BotForm): BotForm {
  return isFormDirty(previous, form) ? form : formFromBot(next);
}

export type AvatarPick =
  | { kind: "ok"; url: string }
  | { kind: "rejected"; why: "type" | "size" }
  | { kind: "unreadable"; error: string };

/** Check and read a chosen picture. `read` is injectable so the rules can be tested without a browser. */
export async function pickAvatarFile(
  file: Blob & { type: string; size: number },
  read: (file: Blob) => Promise<string> = readAvatarDataUrl,
): Promise<AvatarPick> {
  const check = checkAvatarFile(file);
  if (check !== "ok") return { kind: "rejected", why: check };
  try {
    const url = await read(file);
    // The file limit leaves room for base64, but the host's limit is the one that decides.
    if (url.length > AVATAR_MAX_DATA_URL_CHARS) return { kind: "rejected", why: "size" };
    return { kind: "ok", url };
  } catch (error) {
    return { kind: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
}
