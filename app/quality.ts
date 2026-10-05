import type { Quality } from "./protocol";

export function qualityHeight(quality: Quality): number | null {
  return quality === "best" ? null : Number(quality);
}

export function qualityLabel(quality: Quality): string {
  return quality === "best" ? "Best compatible" : `Up to ${quality}p`;
}
