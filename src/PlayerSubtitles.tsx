import { useEffect, useRef, useState } from "react";
import { Captions, Check, RefreshCw } from "lucide-react";
import { api } from "./api";

type Track = { id: string; language: string; label: string; origin: "original" | "generated" | "manual"; url: string; updatedAt: string };
export type SubtitleState = {
  pluginEnabled: boolean; status: string; progress: number; error: string; tracks: Track[];
};

export function selectedSubtitleTrack(preferred: string, tracks: Track[]) {
  if (preferred === "off" || tracks.some((track) => track.id === preferred)) return preferred;
  const language = preferred.replace(/^manual-/, "");
  return tracks.find((track) => track.language === language)?.id
    ?? tracks.find((track) => track.origin === "original")?.id ?? tracks[0]?.id ?? "off";
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

export function PlayerSubtitles({ mediaId, state, selected, open, toggle, select, update, setNotice }: {
  mediaId: string; state: SubtitleState; selected: string; open: boolean; toggle: () => void;
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
  return <div className="caption-control">
    <button className={`player-icon-button ${selected !== "off" ? "active" : ""}`} aria-label="Subtitles" aria-expanded={open} onClick={toggle}><Captions/></button>
    {open && <div className="caption-menu"><strong>Subtitles</strong>
      {state.tracks.map((track) => <button key={track.id} className={selected === track.id ? "active" : ""} aria-pressed={selected === track.id} onClick={() => select(track.id)}>
        <span>{track.label}<small>{track.origin === "original" ? "Detected original language" : track.origin === "manual" ? "Imported subtitle file" : "Local translation"}</small></span>{selected === track.id && <Check/>}
      </button>)}
      {state.tracks.length > 0 && <button className={selected === "off" ? "active" : ""} aria-pressed={selected === "off"} onClick={() => select("off")}><span>Off<small>Hide subtitles</small></span>{selected === "off" && <Check/>}</button>}
      {message && <p role="status">{message}</p>}
      {state.pluginEnabled && state.status === "error" && <button disabled={busy} onClick={() => void retry()}><span>Retry generation</span><RefreshCw/></button>}
    </div>}
  </div>;
}
