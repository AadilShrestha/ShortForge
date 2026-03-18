export interface CaptionWord {
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface CaptionGroup {
  words: CaptionWord[];
  startFrame: number;
  endFrame: number;
}

export interface CaptionOverlayProps {
  groups: CaptionGroup[];
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  [key: string]: unknown;
}
