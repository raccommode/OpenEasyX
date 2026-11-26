export const PHOTO_AUTOPLAY_SECONDS = 10;

export function playerTime(value = 0) {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function initialAutoplay(kind: "video" | "image", autoStart: boolean, stored: string | null) {
  if (kind === "image" && !autoStart) return false;
  return stored !== "false";
}

export function autoplayOnOpen(kind: "video" | "image", stored: string | null) {
  return kind === "video" && stored !== "false";
}

export function nextMediaId(ids: string[], currentId: string) {
  return ids[ids.indexOf(currentId) + 1];
}
