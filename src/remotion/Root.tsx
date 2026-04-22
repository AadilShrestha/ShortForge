import React from "react";
import { Composition } from "remotion";
import { CaptionOverlay } from "./CaptionOverlay";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CaptionOverlay"
      component={CaptionOverlay}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={1}
      defaultProps={{
        groups: [],
        width: 1080,
        height: 1920,
        fps: 30,
        durationInFrames: 1,
      }}
      calculateMetadata={async ({ props }) => ({
        durationInFrames: props.durationInFrames,
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
  );
};
