import { nativeImage } from "electron";
import { shrinkToAvatar, type RawPicture } from "./avatar-generate.js";

/** `shrinkToAvatar` over Electron's own image decoder, so no image library is added for a 256-pixel picture. */
export function shrinkWithElectron(picture: RawPicture) {
  return shrinkToAvatar(picture, (bytes) => nativeImage.createFromBuffer(bytes));
}
