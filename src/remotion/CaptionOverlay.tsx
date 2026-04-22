import React from "react";
import { useCurrentFrame } from "remotion";
import type { CaptionGroup, CaptionOverlayProps } from "./types";

const FONT_SIZE = 36;
const ACTIVE_COLOR = "#FFD44F";
const INACTIVE_COLOR = "#FFFFFF";
const BOX_BACKGROUND = "rgba(0, 0, 0, 0.72)";
const TEXT_STROKE =
  "0 3px 12px rgba(0, 0, 0, 0.85), 0 1px 0 rgba(0, 0, 0, 0.92), 0 -1px 0 rgba(0, 0, 0, 0.92)";

const CaptionBox: React.FC<{ group: CaptionGroup; frame: number; width: number }> = ({
  group,
  frame,
  width,
}) => {
  const renderWord = (word: (typeof group.words)[0], idx: number) => {
    const isActive = frame >= word.startFrame && frame < word.endFrame;
    return (
      <span
        key={`${word.text}-${idx}`}
        style={{
          color: isActive ? ACTIVE_COLOR : INACTIVE_COLOR,
          textShadow: TEXT_STROKE,
          whiteSpace: "pre",
        }}
      >
        {word.text.toUpperCase()}
      </span>
    );
  };

  return (
    <div
      style={{
        maxWidth: Math.round(width * 0.74),
        background: BOX_BACKGROUND,
        padding: "10px 16px",
        borderRadius: 14,
        border: "1px solid rgba(255, 255, 255, 0.14)",
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        columnGap: 10,
        rowGap: 8,
        lineHeight: 1.08,
      }}
    >
      {group.words.map(renderWord)}
    </div>
  );
};

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({ groups, width, height }) => {
  const frame = useCurrentFrame();
  const activeGroup = groups.find((g) => frame >= g.startFrame && frame < g.endFrame);

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        paddingBottom: Math.round(height * 0.16),
        fontFamily: "Arial, Helvetica, sans-serif",
        fontWeight: 800,
        fontSize: FONT_SIZE,
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: "none",
        backgroundColor: "#00FF00",
      }}
    >
      {activeGroup && <CaptionBox group={activeGroup} frame={frame} width={width} />}
    </div>
  );
};
