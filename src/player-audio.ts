export type PlayerAudio = { volume: number; muted: boolean };

const PLAYER_AUDIO_KEY = "open-easyx.player-audio";
const DEFAULT_PLAYER_AUDIO: PlayerAudio = { volume: 1, muted: false };

export function loadPlayerAudio(storage?: Pick<Storage, "getItem">, fallback: PlayerAudio = DEFAULT_PLAYER_AUDIO): PlayerAudio {
  try {
    const availableStorage = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!availableStorage) return { ...fallback };
    const value = JSON.parse(availableStorage.getItem(PLAYER_AUDIO_KEY) || "{}") as Partial<PlayerAudio>;
    const volume = typeof value.volume === "number" && Number.isFinite(value.volume)
      ? Math.max(0, Math.min(1, value.volume))
      : fallback.volume;
    return { volume, muted: typeof value.muted === "boolean" ? value.muted : fallback.muted };
  } catch {
    return { ...fallback };
  }
}

export function savePlayerAudio(audio: PlayerAudio, storage?: Pick<Storage, "setItem">): void {
  try {
    const availableStorage = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    availableStorage?.setItem(PLAYER_AUDIO_KEY, JSON.stringify(audio));
  } catch {
    // Playback controls should remain usable when browser storage is unavailable.
  }
}
