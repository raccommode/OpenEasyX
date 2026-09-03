import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Captions, Check, Clock3, Grid3X3, Heart, LoaderCircle, Maximize, Minimize, Pause, Play, Upload, Volume2, VolumeX } from "lucide-react";
import { api } from "./api";
import { initialAutoplay, nextMediaId, PHOTO_AUTOPLAY_SECONDS } from "./playback";
import { loadPlayerAudio, savePlayerAudio } from "./player-audio";
import { monitorVideoStalls } from "./video-stall-recovery";
import { usePlayerFullscreen } from "./player-fullscreen";
import "./player.css";
import "./photo-player.css";
import "./watch-page.css";

type Media = {
  id: string; relativePath: string; kind: "video" | "image"; title: string; performer: string; source: string;
  extension: string; mimeType: string; size: number; modifiedAt: string; duration: number; width: number; height: number; favorite: boolean; progressSeconds: number; completed: boolean;
  viewCount: number; lastViewedAt?: string; thumbnailUrl: string; previewUrl: string; streamUrl: string;
};
type Track = { id: string; language: string; label: string; origin: "original" | "generated" | "manual"; url: string };
type SubtitleState = { status: string; progress: number; sourceLanguage: string; error: string; tracks: Track[] };
type Language = { code: string; label: string };
export type PlaybackContext = { query?: string; ids?: string[] };

function playerTime(value = 0) {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
function bytes(value = 0) {
  const units = ["B", "KB", "MB", "GB", "TB"]; const index = value ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}
function safePlay(element: HTMLVideoElement) {
  void element.play().catch(() => {});
}

export function PlayerViewer({ media, context, autoStart = false, close, favorite, advance, setNotice }: {
  media: Media; context: PlaybackContext; autoStart?: boolean; close: () => void;
  favorite: (media: Media, value: boolean) => void; advance: (media: Media) => void; setNotice: (value: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null); const player = useRef<HTMLDivElement>(null); const lastSaved = useRef(0); const hideTimer = useRef<number | undefined>(undefined);
  const initialAudio = useRef(loadPlayerAudio());
  const [playing, setPlaying] = useState(false); const [waiting, setWaiting] = useState(false); const [controls, setControls] = useState(true);
  const [currentTime, setCurrentTime] = useState(media.progressSeconds || 0); const [duration, setDuration] = useState(media.duration || 0); const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(initialAudio.current.volume); const [muted, setMuted] = useState(initialAudio.current.muted);
  const { fullscreen, pageFullscreen, toggleFullscreen } = usePlayerFullscreen(player, video, media.id);
  const [autoplay, setAutoplay] = useState(() => initialAutoplay(media.kind, autoStart, localStorage.getItem("open-easyx.autoplay")));
  const [photoRemaining, setPhotoRemaining] = useState(PHOTO_AUTOPLAY_SECONDS); const [photoReady, setPhotoReady] = useState(false);
  const [captionMenu, setCaptionMenu] = useState(false); const [subtitleTrack, setSubtitleTrack] = useState(() => localStorage.getItem("open-easyx.subtitle-track") || "original");
  const [subtitles, setSubtitles] = useState<SubtitleState>({ status: "disabled", progress: 0, sourceLanguage: "", error: "", tracks: [] });
  const [languages, setLanguages] = useState<Language[]>([]); const [uploadLanguage, setUploadLanguage] = useState("en"); const [uploading, setUploading] = useState(false);

  const save = (completed = false, force = false) => {
    const element = video.current; if (!element || !Number.isFinite(element.duration)) return Promise.resolve();
    if (!force && !completed && Math.abs(element.currentTime - lastSaved.current) < 8) return Promise.resolve();
    lastSaved.current = element.currentTime;
    return api(`/api/media/${media.id}/progress`, { method: "PUT", body: JSON.stringify({ position: element.currentTime, duration: element.duration || media.duration || 0, completed }) }).catch((error) => setNotice(error.message));
  };
  const closeViewer = () => { void save(false, true); close(); };
  const reveal = () => {
    setControls(true); window.clearTimeout(hideTimer.current);
    if (!video.current?.paused) hideTimer.current = window.setTimeout(() => { if (!captionMenu) setControls(false); }, 2400);
  };
  const togglePlayback = () => { const element = video.current; if (!element) return; if (element.paused) safePlay(element); else element.pause(); };
  const seek = (value: number) => { const element = video.current; if (!element) return; element.currentTime = Math.max(0, Math.min(element.duration || 0, value)); setCurrentTime(element.currentTime); reveal(); };
  const toggleMute = () => { const element = video.current; if (!element) return; element.muted = !element.muted; setMuted(element.muted); savePlayerAudio({ volume: element.volume, muted: element.muted }); };
  const selectTrack = (id: string) => { setSubtitleTrack(id); localStorage.setItem("open-easyx.subtitle-track", id); setCaptionMenu(false); };
  const toggleAutoplay = () => { const value = !autoplay; setAutoplay(value); localStorage.setItem("open-easyx.autoplay", String(value)); };
  const next = async () => {
    await save(true, true);
    if (!autoplay) return;
    let ids = context.ids ?? [];
    if (context.query) ids = (await api<{ ids: string[] }>(`/api/library/playlist?${context.query}`).catch(() => ({ ids }))).ids;
    const nextId = nextMediaId(ids, media.id);
    if (!nextId) { setNotice("You reached the end of this playlist."); return; }
    try { advance(await api<Media>(`/api/media/${nextId}`)); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };

  useEffect(() => {
    if (media.kind === "image") void api(`/api/media/${media.id}/progress`, { method: "PUT", body: JSON.stringify({ position: 0, duration: 0, completed: true }) }).catch(() => {});
  }, [media.id, media.kind]);
  useEffect(() => {
    lastSaved.current = 0; window.clearTimeout(hideTimer.current);
    if (media.kind === "video" && video.current) {
      video.current.src = media.streamUrl; video.current.load();
    }
    initialAudio.current = loadPlayerAudio(); setVolume(initialAudio.current.volume); setMuted(initialAudio.current.muted);
    setPlaying(false); setWaiting(false); setControls(true); setCurrentTime(media.progressSeconds || 0); setDuration(media.duration || 0); setBuffered(0);
    setPhotoRemaining(PHOTO_AUTOPLAY_SECONDS); setPhotoReady(false); setCaptionMenu(false);
    setSubtitles({ status: "disabled", progress: 0, sourceLanguage: "", error: "", tracks: [] });
  }, [media.id]);
  useEffect(() => {
    if (media.kind !== "image") return;
    setPhotoRemaining(PHOTO_AUTOPLAY_SECONDS);
    if (!autoplay || !photoReady) return;
    const startedAt = Date.now();
    const updateCountdown = () => setPhotoRemaining(Math.max(0, Math.ceil(PHOTO_AUTOPLAY_SECONDS - (Date.now() - startedAt) / 1000)));
    const interval = window.setInterval(updateCountdown, 250);
    const timer = window.setTimeout(() => { void next(); }, PHOTO_AUTOPLAY_SECONDS * 1000);
    return () => { window.clearInterval(interval); window.clearTimeout(timer); };
  }, [media.id, media.kind, autoplay, photoReady]);
  useEffect(() => {
    if (media.kind !== "video") return;
    let cancelled = false;
    const refresh = () => api<SubtitleState>(`/api/media/${media.id}/subtitles`).then((value) => { if (!cancelled) setSubtitles(value); }).catch(() => {});
    void refresh(); void api<{ subtitleLanguages: Language[] }>("/api/settings").then((value) => setLanguages(value.subtitleLanguages)).catch(() => {});
    const timer = window.setInterval(refresh, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [media.id, media.kind]);
  useEffect(() => {
    const element = video.current;
    if (media.kind !== "video" || !element) return;
    return monitorVideoStalls(element);
  }, [media.id, media.kind]);
  useEffect(() => {
    const element = video.current; if (!element?.textTracks) return;
    Array.from(element.textTracks).forEach((track, index) => { track.mode = subtitles.tracks[index]?.id === subtitleTrack ? "showing" : "disabled"; });
  }, [subtitleTrack, subtitles.tracks]);
  useEffect(() => {
    if (subtitleTrack !== "off" && subtitles.tracks.length && !subtitles.tracks.some((track) => track.id === subtitleTrack)) {
      selectTrack(subtitles.tracks.find((track) => track.id === "original")?.id ?? subtitles.tracks[0].id);
    }
  }, [subtitles.tracks]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && captionMenu) { setCaptionMenu(false); return; }
      if (media.kind !== "video" || ["INPUT", "SELECT", "BUTTON"].includes((event.target as HTMLElement).tagName)) return;
      if (event.code === "Space" || event.key.toLowerCase() === "k") { event.preventDefault(); togglePlayback(); }
      else if (event.key === "ArrowLeft") seek(currentTime - 10); else if (event.key === "ArrowRight") seek(currentTime + 10);
      else if (event.key.toLowerCase() === "m") toggleMute(); else if (event.key.toLowerCase() === "f") void toggleFullscreen();
    };
    window.addEventListener("keydown", key); return () => { window.removeEventListener("keydown", key); window.clearTimeout(hideTimer.current); };
  }, [captionMenu, currentTime, media.id, media.kind, fullscreen, pageFullscreen]);

  const upload = async (file?: File) => {
    if (!file) return; setUploading(true);
    try {
      const content = await file.text();
      const nextState = await api<SubtitleState>(`/api/media/${media.id}/subtitles/${uploadLanguage}`, { method: "PUT", body: JSON.stringify({ content, label: languages.find((item) => item.code === uploadLanguage)?.label }) });
      setSubtitles(nextState); selectTrack(`manual-${uploadLanguage}`); setNotice(`${file.name} added to this video.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setUploading(false); }
  };

  const subtitleText = subtitles.status === "running" ? `Generating · ${Math.round(subtitles.progress)}%` : subtitles.status === "queued" ? "Waiting in the local queue" : subtitles.status === "error" ? subtitles.error || "Subtitle generation failed" : subtitles.status === "no_audio" ? "No audio track detected" : subtitles.status === "no_speech" ? "No speech detected" : subtitles.status === "disabled" ? "Enable automatic subtitles in Settings" : "No subtitle track yet";
  const progress = duration ? Math.min(100, currentTime / duration * 100) : 0; const bufferedProgress = duration ? Math.min(100, buffered / duration * 100) : 0;

  return <article className="watch-page">
    <div className="theater-stage">{media.kind === "video" ? <div ref={player} className={`custom-player ${pageFullscreen ? "page-fullscreen" : ""} ${controls || !playing ? "controls-visible" : "controls-hidden"}`} tabIndex={0} onMouseMove={reveal} onTouchStart={reveal} onMouseLeave={() => playing && !captionMenu && setControls(false)}>
      <div className="player-surface" onClick={togglePlayback} onDoubleClick={() => void toggleFullscreen()}><video ref={video} src={media.streamUrl} poster={media.thumbnailUrl} playsInline preload="metadata" autoPlay={autoStart}
        onLoadedMetadata={(event) => { const element = event.currentTarget; setDuration(element.duration || media.duration || 0); element.volume = initialAudio.current.volume; element.muted = initialAudio.current.muted; element.currentTime = 0; if (!media.completed && media.progressSeconds > 0 && media.progressSeconds < element.duration - 5) element.currentTime = media.progressSeconds; if (autoStart && element.paused) safePlay(element); }}
        onTimeUpdate={(event) => { setCurrentTime(event.currentTarget.currentTime); void save(); }} onProgress={(event) => { const element = event.currentTarget; if (element.buffered.length) setBuffered(element.buffered.end(element.buffered.length - 1)); }}
        onPlay={() => { setPlaying(true); setWaiting(false); reveal(); }} onPlaying={() => { setPlaying(true); setWaiting(false); }} onPause={() => { setPlaying(false); setWaiting(false); void save(false, true); }} onWaiting={() => setWaiting(true)} onCanPlay={() => setWaiting(false)}
        onVolumeChange={(event) => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); initialAudio.current = { volume: event.currentTarget.volume, muted: event.currentTarget.muted }; savePlayerAudio(initialAudio.current); }} onEnded={() => void next()}>
        {subtitles.tracks.map((track) => <track key={`${track.id}-${track.url}`} kind="subtitles" src={track.url} srcLang={track.language} label={track.label}/>)}
      </video></div>
      {waiting && <div className="player-buffering"><LoaderCircle className="spin"/></div>}{!playing && !waiting && <button className="player-center-play" onClick={togglePlayback} aria-label="Play"><Play fill="currentColor"/></button>}
      <div className="player-controls" onClick={(event) => event.stopPropagation()}><div className="player-timeline"><span className="player-buffered" style={{ width: `${bufferedProgress}%` }}/><span className="player-elapsed" style={{ width: `${progress}%` }}/><input type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentTime, duration || 0)} onChange={(event) => seek(Number(event.target.value))} aria-label="Video position"/></div>
        <div className="player-control-row"><div className="player-controls-left"><button className="player-icon-button" onClick={togglePlayback} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><div className="player-volume"><button className="player-icon-button" onClick={toggleMute}>{muted || volume === 0 ? <VolumeX/> : <Volume2/>}</button><input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => { const element = video.current; if (!element) return; element.volume = Number(event.target.value); element.muted = element.volume === 0; }}/></div><span className="player-time"><b>{playerTime(currentTime)}</b><i>/</i><span>{playerTime(duration)}</span></span></div>
          <div className="player-controls-right"><button className={`player-autoplay ${autoplay ? "active" : ""}`} aria-label="Autoplay" aria-pressed={autoplay} onClick={toggleAutoplay}><span>Auto</span><i/></button>
            <div className="caption-control"><button className={`player-icon-button ${subtitleTrack !== "off" && subtitles.tracks.length ? "active" : ""}`} onClick={() => setCaptionMenu(!captionMenu)} aria-label="Subtitles"><Captions/></button>{captionMenu && <div className="caption-menu"><strong>Subtitles</strong>{subtitles.tracks.map((track) => <button key={track.id} className={subtitleTrack === track.id ? "active" : ""} onClick={() => selectTrack(track.id)}><span>{track.label}<small>{track.origin === "original" ? "Detected original language" : track.origin === "manual" ? "Imported subtitle file" : "Local translation"}</small></span>{subtitleTrack === track.id && <Check/>}</button>)}<button className={subtitleTrack === "off" ? "active" : ""} onClick={() => selectTrack("off")}><span>Off<small>Hide subtitles</small></span>{subtitleTrack === "off" && <Check/>}</button>{!subtitles.tracks.length && <p>{subtitleText}</p>}<div className="caption-upload"><select value={uploadLanguage} onChange={(event) => setUploadLanguage(event.target.value)}>{languages.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select><label className={uploading ? "disabled" : ""}><Upload/>{uploading ? "Adding…" : "Add VTT or SRT"}<input type="file" accept=".vtt,.srt,text/vtt,application/x-subrip" disabled={uploading} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }}/></label></div></div>}</div>
            <button className="player-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize/> : <Maximize/>}</button></div></div></div>
    </div> : <div ref={player} className={`image-stage ${pageFullscreen ? "page-fullscreen" : ""}`}><img src={media.streamUrl} alt={media.title} onLoad={() => setPhotoReady(true)} onError={() => setPhotoReady(true)}/><div className="photo-controls"><div className="photo-timeline"><i style={{ width: `${autoplay && photoReady ? (PHOTO_AUTOPLAY_SECONDS - photoRemaining) / PHOTO_AUTOPLAY_SECONDS * 100 : 0}%` }}/></div><div className="photo-control-row"><span>{autoplay ? photoReady ? `Next item in ${photoRemaining}s` : "Loading photo…" : "Autoplay is off"}</span><div><button className={`player-autoplay ${autoplay ? "active" : ""}`} aria-label="Autoplay" aria-pressed={autoplay} onClick={toggleAutoplay}><span>Auto</span><i/></button><button className="player-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize/> : <Maximize/>}</button></div></div></div></div>}</div>
    <section className="watch-info">
      <div className="watch-heading"><div><span className="watch-eyebrow">{media.source || "Local library"} · {media.kind === "video" ? "Video" : "Photo"}</span><h1>{media.title}</h1><p>{media.performer || "Unsorted"}</p></div><div className="watch-actions"><button className="quiet" onClick={() => void favorite(media, !media.favorite)}><Heart className={media.favorite ? "filled" : ""}/>{media.favorite ? "In favorites" : "Add to favorites"}</button><button className="quiet" onClick={closeViewer}><ArrowLeft/>Back</button></div></div>
      <div className="watch-meta"><span><Clock3/>{media.completed ? "Completed" : media.progressSeconds > 0 ? `${Math.round(media.progressSeconds / Math.max(1, media.duration) * 100)}% watched` : "Not started"}</span><span>{media.viewCount} {media.viewCount === 1 ? "view" : "views"}</span>{duration > 0 && <span>{playerTime(duration)}</span>}{media.width > 0 && media.height > 0 && <span>{media.width}×{media.height}</span>}<span><Grid3X3/>{media.extension.replace(".", "").toUpperCase()} · {bytes(media.size)}</span></div>
      <div className="watch-file"><span>Local file</span><code title={media.relativePath}>{media.relativePath}</code></div>
    </section>
  </article>;
}
