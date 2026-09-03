import { Icon } from "./Icon.js";
import { VideoModelSettingsMenu } from "./VideoModelSettingsMenu.js";
import type { VideoModelParams } from "@deyin/host-core/shared";

interface VideoModelSettingsBarProps {
  providerId: string;
  modelId: string;
  saved?: VideoModelParams;
  onChange: (providerId: string, modelId: string, params: VideoModelParams) => void;
}

/** Agnes-style video controls in a slim bar above the workspace folder row. */
export function VideoModelSettingsBar({ providerId, modelId, saved, onChange }: VideoModelSettingsBarProps) {
  return (
    <div className="image-settings-bar video-settings-bar">
      <div className="image-settings-bar__label">
        <Icon name="sliders" size={12} />
        <span>Agnes video settings</span>
      </div>
      <VideoModelSettingsMenu
        providerId={providerId}
        modelId={modelId}
        saved={saved}
        onChange={onChange}
        variant="bar"
      />
    </div>
  );
}
