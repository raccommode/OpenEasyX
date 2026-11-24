import { useEffect, useRef, useState } from "react";
import { Captions, Check, RefreshCw } from "lucide-react";
import { api } from "./api";

type Track = { id: string; language: string; label: string; origin: "original" | "generated" | "manual"; url: string; updatedAt: string };
export type SubtitleState = {
  pluginEnabled: boolean; status: string; progress: number; error: string; tracks: Track[]; targetLanguages?: string[];
};

type SubtitlePreference = string | Pick<Track, "id" | "language">;

export function readSubtitlePreference(value: string | null): SubtitlePreference {
  if (!value) return "auto";
  if (!value.startsWith("{")) return value; // Includes track IDs saved by earlier players.
  try {
    const saved = JSON.parse(value);
    if (typeof saved.id === "string" && typeof saved.language === "string" && saved.language) return { id: saved.id, language: saved.language };
  } catch { /* Ignore invalid saved preferences. */ }
  return "auto";
}

export function selectedSubtitleTrack(preferred: SubtitlePreference, tracks: Track[], targets: readonly string[] = []) {
  if (typeof preferred !== "string") {
    const matches = tracks.filter((track) => track.language.toLowerCase() === preferred.language.toLowerCase());
    return (matches.find((track) => track.id === preferred.id) ?? matches.find((track) => track.origin !== "manual") ?? matches[0])?.id ?? "off";
  }
  if (preferred === "off" || tracks.some((track) => track.id === preferred)) return preferred;
  const languages = preferred === "auto" ? targets : [preferred.replace(/^manual-/, ""), ...targets];
  for (const language of languages) {
    const track = tracks.find((entry) => entry.language === language && entry.origin !== "manual")
      ?? tracks.find((entry) => entry.language === language);
    if (track) return track.id;
  }
  return tracks.find((track) => track.origin === "original")?.id ?? tracks[0]?.id ?? "off";
}

export function useMediaSubtitles(mediaId?: string) {
  const [snapshot, setSnapshot] = useState<{ mediaId: string; state: SubtitleState }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!mediaId) return;
    const controller = new AbortController();
    let timer: number;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      window.clearTimeout(timer);
      let poll = true;
      try {
        const state = await api<SubtitleState>(`/api/media/${mediaId}/subtitles`, { signal: controller.signal });
        if (!controller.signal.aborted) setSnapshot({ mediaId, state });
        poll = state.pluginEnabled && ["queued", "running", "error"].includes(state.status);
      } catch { /* Retry when the connection comes back. */ }
      finally {
        loading = false;
        if (poll && !controller.signal.aborted) timer = window.setTimeout(refresh, 5000);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [mediaId, revision]);
  return {
    state: snapshot && snapshot.mediaId === mediaId ? snapshot.state : undefined,
    update: (state: SubtitleState) => {
      if (mediaId) setSnapshot({ mediaId, state });
      setRevision((value) => value + 1);
    },
  };
}

function generationMessage(state: SubtitleState) {
  if (!state.pluginEnabled) return "";
  switch (state.status) {
    case "running": return `Generating subtitles · ${Math.round(state.progress)}%`;
    case "queued": return "Waiting in the local queue";
    case "error": return state.error || "Subtitle generation failed";
    case "no_audio": return "No audio track detected";
    case "no_speech": return "No speech detected";
    case "disabled": return "Automatic generation is paused";
    default: return state.tracks.length ? "" : "No subtitle tracks yet";
  }
}

export function PlayerSubtitles({ mediaId, state, selected, automatic, open, toggle, select, update, setNotice }: {
  mediaId: string; state: SubtitleState; selected: string; automatic: boolean; open: boolean; toggle: () => void;
  select: (id: string) => void; update: (state: SubtitleState) => void; setNotice: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const retry = async () => {
    setBusy(true);
    try {
      const result = await api<SubtitleState>(`/api/media/${mediaId}/subtitles/retry`, { method: "POST" });
      if (alive.current) update(result);
    } catch (err) { if (alive.current) setNotice(err instanceof Error ? err.message : String(err)); }
    finally { if (alive.current) setBusy(false); }
  };
  if (!state.pluginEnabled && !state.tracks.length) return null;
  const message = generationMessage(state);
  const activeChoice = automatic ? "auto" : selected;
  return <div className="caption-control">
    <button className={`player-icon-button ${selected !== "off" ? "active" : ""}`} aria-label="Subtitles" aria-expanded={open} onClick={toggle}><Captions/></button>
    {open && <div className="caption-menu"><strong>Subtitles</strong>
      {state.tracks.length > 0 && <button className={automatic ? "active" : ""} aria-pressed={automatic} onClick={() => select("auto")}><span>Automatic<small>{automatic ? state.tracks.find((track) => track.id === selected)?.label : "Use plugin language preferences"}</small></span>{automatic && <Check/>}</button>}
      {state.tracks.map((track) => <button key={track.id} className={activeChoice === track.id ? "active" : ""} aria-pressed={activeChoice === track.id} onClick={() => select(track.id)}>
        <span>{track.label}<small>{track.origin === "original" ? "Detected original language" : track.origin === "manual" ? "Imported subtitle file" : "Local translation"}</small></span>{activeChoice === track.id && <Check/>}
      </button>)}
      {state.tracks.length > 0 && <button className={activeChoice === "off" ? "active" : ""} aria-pressed={activeChoice === "off"} onClick={() => select("off")}><span>Off<small>Hide subtitles</small></span>{activeChoice === "off" && <Check/>}</button>}
      {message && <p role="status">{message}</p>}
      {state.pluginEnabled && state.status === "error" && <button disabled={busy} onClick={() => void retry()}><span>Retry generation</span><RefreshCw/></button>}
    </div>}
  </div>;
}
