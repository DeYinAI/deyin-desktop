import {
  AVATAR_GENERATED_BUDGET,
  BotError,
  avatarImagePrompt,
  avatarSide,
  botResultAsync,
  checkAvatarPrompt,
  cleanBotLine,
  isBotAvatarUrl,
  squareCrop,
  type BotAvatarPicture,
  type BotAvatarRequest,
  type BotResult,
  type SquareCrop,
} from "@deyin/host-core";

/** A picture as the image model hands it back. */
export interface RawPicture {
  base64: string;
  mediaType: string;
}

/** The few things the avatar needs from the platform's image type (Electron's `NativeImage` has all of them). */
export interface DecodedPicture {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  crop(rect: SquareCrop): DecodedPicture;
  resize(size: { width: number; height: number }): DecodedPicture;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

/** JPEG qualities tried, best first, when a picture will not fit as PNG. */
const JPEG_QUALITIES = [85, 70, 55] as const;

const dataUrl = (mediaType: "image/png" | "image/jpeg", bytes: Buffer): string => `data:${mediaType};base64,${bytes.toString("base64")}`;

/**
 * Cut a generated picture down to an avatar: the middle square, at most `AVATAR_IMAGE_PIXELS` a side, as a PNG when
 * that fits the budget (it keeps a drawing's edges clean) and as a JPEG when it does not (a photograph).
 */
export function shrinkToAvatar(picture: RawPicture, decode: (bytes: Buffer) => DecodedPicture): BotAvatarPicture {
  const decoded = decode(Buffer.from(picture.base64, "base64"));
  if (decoded.isEmpty()) throw new BotError("invalid", "The image model did not return a picture. Try again or pick another model.");
  const { width, height } = decoded.getSize();
  const square = decoded.crop(squareCrop(width, height));
  const side = avatarSide(Math.min(width, height));
  const sized = side < Math.min(width, height) ? square.resize({ width: side, height: side }) : square;

  const png = dataUrl("image/png", sized.toPNG());
  if (png.length <= AVATAR_GENERATED_BUDGET && isBotAvatarUrl(png)) return { url: png };
  for (const quality of JPEG_QUALITIES) {
    const jpeg = dataUrl("image/jpeg", sized.toJPEG(quality));
    if (jpeg.length <= AVATAR_GENERATED_BUDGET && isBotAvatarUrl(jpeg)) return { url: jpeg };
  }
  throw new BotError("limit", "That picture is too detailed to use as an avatar. Try a simpler description.");
}

export interface AvatarGenerateDeps {
  /** One picture from the person's image model. Throws with a readable message when the model or the network refuses. */
  generate(request: { prompt: string; model: string; providerId?: string }): Promise<RawPicture>;
  /** Cut the picture down to an avatar (see `shrinkToAvatar`). */
  shrink(picture: RawPicture): BotAvatarPicture;
}

export interface AvatarHandlers {
  generate(input: unknown): Promise<BotResult<BotAvatarPicture>>;
}

/** An id the person picked from a list: bounded, one line. Anything else is not from the list. */
function identifier(value: unknown, what: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) throw new BotError("invalid", `${what} is not valid.`);
  return text;
}

/** The first line of a refusal, short enough for a form: a provider's error can carry a page of detail. */
function reason(error: unknown): string {
  const line = cleanBotLine(error instanceof Error ? error.message.split("\n")[0] : String(error));
  return line.length > 200 ? `${line.slice(0, 199)}…` : line || "The image model did not answer.";
}

/**
 * Make a picture for a Bot. The request comes from the window, so each part is checked before the image model is
 * called (and paid for); a second request while one is running is refused rather than queued, so a stuck click
 * cannot spend a person's credits many times over.
 */
export function createAvatarHandlers(deps: AvatarGenerateDeps): AvatarHandlers {
  let running = false;
  return {
    generate: (input) =>
      botResultAsync(async () => {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new BotError("invalid", "The picture request must be an object.");
        const request = input as Partial<Record<keyof BotAvatarRequest, unknown>>;
        const description = checkAvatarPrompt(request.prompt);
        if (!description.ok) throw new BotError("invalid", description.error);
        const model = identifier(request.model, "The image model");
        const providerId = request.providerId === undefined ? undefined : identifier(request.providerId, "The provider");
        if (running) throw new BotError("conflict", "A picture is already being made. Wait for it to finish.");
        running = true;
        try {
          let picture: RawPicture;
          try {
            picture = await deps.generate({
              prompt: avatarImagePrompt(description.text, typeof request.botName === "string" ? request.botName : undefined),
              model,
              ...(providerId ? { providerId } : {}),
            });
          } catch (error) {
            throw new BotError("invalid", reason(error));
          }
          return deps.shrink(picture);
        } finally {
          running = false;
        }
      }),
  };
}
