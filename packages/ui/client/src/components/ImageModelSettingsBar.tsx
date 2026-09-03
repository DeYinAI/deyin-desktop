import { Icon } from "./Icon.js";
import { ImageModelSettingsMenu } from "./ImageModelSettingsMenu.js";
import type { ImageModelParams } from "@deyin/host-core/shared";

interface ImageModelSettingsBarProps {
  providerId: string;
  modelId: string;
  saved?: ImageModelParams;
  onChange: (providerId: string, modelId: string, params: ImageModelParams) => void;
}

/** Image diffusion controls in a slim bar above the workspace folder row. */
export function ImageModelSettingsBar({ providerId, modelId, saved, onChange }: ImageModelSettingsBarProps) {
  return (
    <div className="image-settings-bar">
      <div className="image-settings-bar__label">
        <Icon name="sliders" size={12} />
        <span>Image quality</span>
      </div>
      <ImageModelSettingsMenu
        providerId={providerId}
        modelId={modelId}
        saved={saved}
        onChange={onChange}
        variant="bar"
      />
    </div>
  );
}
