/**
 * One agent's cat, in one pose, at a whole scale so each pixel is a square: the Look tab's preview, and the face a
 * fresh chat greets you with. The same sprite the Office draws, so an agent looks like itself everywhere.
 */

import { useEffect, useRef } from "react";
import type { Pose } from "./compose";
import type { Look } from "./look";
import { catSprite } from "./sprite";

export function CatPortrait({ look, pose = "stand", scale, label }: { look: Look; pose?: Pose; scale: number; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 32, 32);
    context.drawImage(catSprite(look, pose), 0, 0);
  }, [look, pose]);
  return (
    <canvas
      ref={canvas}
      width={32}
      height={32}
      role="img"
      aria-label={label ?? `${pose} pose`}
      style={{ width: 32 * scale, height: 32 * scale, imageRendering: "pixelated" }}
    />
  );
}
