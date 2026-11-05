import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, ArrowLeft, Captions, Cast, Check, ChevronsLeft, ChevronsRight, FastForward, ZoomOut, Clock3, Grid3X3, Heart, LoaderCircle, Maximize, Minimize, Pause, Play, RefreshCw, Trash2, Upload, Volume2, VolumeX } from "lucide-react";
import { api } from "./api";
import { initialAutoplay, nextMediaId, PHOTO_AUTOPLAY_SECONDS } from "./playback";
import { loadPlayerAudio, savePlayerAudio } from "./player-audio";
import { createPlayerAudioBoost, loadPlayerAudioBoost, MAX_AUDIO_BOOST, savePlayerAudioBoost, type PlayerAudioBoost } from "./player-audio-boost";
import { monitorVideoStalls } from "./video-stall-recovery";
import { usePlayerFullscreen } from "./player-fullscreen";
import { createControlsAutoHide } from "./player-controls";
import { clampZoom, createPlayerGestures, HOLD_PLAYBACK_RATE, NO_ZOOM, pinchZoom, SEEK_STEP_SECONDS, type GesturePoint, type GestureSide, type ZoomState } from "./player-gestures";
import { usePlayerCast } from "./player-cast";
import "./player-gestures.css";
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
export function PlayerViewer({ media, context, autoStart = false, close, favorite, advance, setNotice, remove }: {
  media: Media; context: PlaybackContext; autoStart?: boolean; close: () => void; remove?: (media: Media) => Promise<boolean>;
  favorite: (media: Media, value: boolean) => void; advance: (media: Media) => void; setNotice: (value: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null); const player = useRef<HTMLDivElement>(null); const surface = useRef<HTMLDivElement>(null); const lastSaved = useRef(0);
  const initialAudio = useRef(loadPlayerAudio());
  const audioBoost = useRef<PlayerAudioBoost | undefined>(undefined);
  const selectedBoost = useRef(loadPlayerAudioBoost());
  const [boost, setBoost] = useState(selectedBoost.current);
  const recoveryPosition = useRef<number | undefined>(undefined);
  const [playbackError, setPlaybackError] = useState("");
  const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false); const [waiting, setWaiting] = useState(false); const [controls, setControls] = useState(true);
  const [currentTime, setCurrentTime] = useState(media.progressSeconds || 0); const [duration, setDuration] = useState(media.duration || 0); const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(initialAudio.current.volume); const [muted, setMuted] = useState(initialAudio.current.muted);
  const { fullscreen, pageFullscreen, toggleFullscreen } = usePlayerFullscreen(player, video, media.id);
  const [autoplay, setAutoplay] = useState(() => initialAutoplay(media.kind, autoStart, localStorage.getItem("open-easyx.autoplay")));
  const [photoRemaining, setPhotoRemaining] = useState(PHOTO_AUTOPLAY_SECONDS); const [photoReady, setPhotoReady] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [captionMenu, setCaptionMenu] = useState(false); const captionMenuOpen = useRef(false); captionMenuOpen.current = captionMenu; const [subtitleTrack, setSubtitleTrack] = useState(() => localStorage.getItem("open-easyx.subtitle-track") || "original");
  const [subtitles, setSubtitles] = useState<SubtitleState>({ status: "disabled", progress: 0, sourceLanguage: "", error: "", tracks: [] });
  const [languages, setLanguages] = useState<Language[]>([]); const [uploadLanguage, setUploadLanguage] = useState("en"); const [uploading, setUploading] = useState(false);
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM); const zoomRef = useRef(zoom); zoomRef.current = zoom; const zoomStart = useRef<ZoomState | undefined>(undefined);
  const [speedHold, setSpeedHold] = useState(false); const holdRate = useRef(1);
  const [seekFlash, setSeekFlash] = useState<{ side: GestureSide; seconds: number; key: number } | undefined>(undefined); const seekFlashTimer = useRef<number | undefined>(undefined);
  const cast = usePlayerCast(video, media, setNotice, (seconds, resumePlaying) => {
    const element = video.current; if (!element) return;
    element.currentTime = seconds; setCurrentTime(seconds);
    if (resumePlaying) safePlay(element);
  });

  const compatibilityPlayback = useRef(false);
  const useCompatiblePlayback = () => {
    const element = video.current;
    if (!element || compatibilityPlayback.current) return false;
    compatibilityPlayback.current = true;
    recoveryPosition.current = Number.isFinite(element.currentTime) ? element.currentTime : 0;
    setPlaybackError(""); setWaiting(true); setPlaying(false);
    setNotice("Preparing a browser-compatible video. This can take a while for long recordings.");
    const url = new URL(media.streamUrl, window.location.href); url.searchParams.set("compatible", "1");
    element.src = url.href; element.load();
    return true;
  };
  const failPlayback = (message: string, tryCompatibility = false) => { if (tryCompatibility && useCompatiblePlayback()) return; setPlaybackError(message); setWaiting(false); setPlaying(false); video.current?.pause(); };
  const resumeAudioBoost = () => {
    const value = selectedBoost.current; const output = audioBoost.current;
    void output?.setBoost(value).then((enabled) => {
      if (audioBoost.current !== output || enabled || selectedBoost.current !== value || value === 1) return;
      selectedBoost.current = 1; setBoost(1); savePlayerAudioBoost(1);
      void audioBoost.current?.setBoost(1);
      setNotice("Audio boost is unavailable in this browser. Standard volume is still available.");
    });
  };
  const changeBoost = (value: number) => {
    selectedBoost.current = value; setBoost(value); savePlayerAudioBoost(value); resumeAudioBoost();
  };
  const safePlay = (element: HTMLVideoElement) => {
    resumeAudioBoost();
    const requestedSource = element.src;
    void element.play().catch((reason: unknown) => {
      // A decode error may already have switched to the compatibility copy.
      if (element.src !== requestedSource) return;
      if (reason instanceof DOMException && (reason.name === "AbortError" || reason.name === "NotAllowedError")) { setWaiting(false); return; }
      failPlayback("This video could not be played. Try again or check the file format.", reason instanceof DOMException && reason.name === "NotSupportedError");
    });
  };
  const reloadPlayback = () => {
    const element = video.current; if (!element) return;
    recoveryPosition.current = Number.isFinite(element.currentTime) ? element.currentTime : currentTime;
    setPlaybackError(""); setWaiting(true); setPlaying(false);
    element.load();
  };

  const save = (completed = false, force = false) => {
    const element = video.current; if (!element || !Number.isFinite(element.duration)) return Promise.resolve();
    if (!force && !completed && Math.abs(element.currentTime - lastSaved.current) < 8) return Promise.resolve();
    lastSaved.current = element.currentTime;
    return api(`/api/media/${media.id}/progress`, { method: "PUT", body: JSON.stringify({ position: element.currentTime, duration: element.duration || media.duration || 0, completed }) }).catch((error) => setNotice(error.message));
  };
  const closeViewer = () => { void save(false, true); close(); };
  const autoHide = useRef<ReturnType<typeof createControlsAutoHide>>(undefined);
  autoHide.current ??= createControlsAutoHide({ show: () => setControls(true), hide: () => setControls(false), paused: () => video.current?.paused ?? true, pinned: () => captionMenuOpen.current });
  const reveal = () => autoHide.current?.reveal();
  const deleteCurrent = async () => {
    if (!remove || deleting) return;
    if (!window.confirm(`Permanently delete "${media.title}"? This cannot be undone.`)) return;
    setDeleting(true); video.current?.pause();
    try { if (await remove(media)) return; } catch { /* The app-level notice reports request failures. */ }
    setDeleting(false);
  };
  const togglePlayback = () => { if (cast.casting) { cast.togglePlay(); return; } const element = video.current; if (!element) return; if (element.paused) safePlay(element); else element.pause(); };
  const seek = (value: number) => { if (cast.casting) { cast.seek(value); reveal(); return; } const element = video.current; if (!element) return; element.currentTime = Math.max(0, Math.min(element.duration || 0, value)); setCurrentTime(element.currentTime); reveal(); };
  const shownTime = cast.casting ? cast.remoteTime : currentTime;
  const shownDuration = cast.casting ? cast.remoteDuration || duration : duration;
  const shownPlaying = cast.casting ? !cast.remotePaused : playing;

  // Touch gestures on the video surface (see player-gestures.ts). The latest handlers are
  // read through a ref so the recognizer is created only once.
  const surfaceSize = () => { const rect = surface.current?.getBoundingClientRect(); return { width: rect?.width ?? 0, height: rect?.height ?? 0 }; };
  const gesture = useRef({
    tap: (_pointerType: string) => {}, doubleTap: (_side: GestureSide, _pointerType: string) => {}, holdStart: () => {}, holdEnd: () => {},
    pinch: (_scale: number, _x: number, _y: number, _sx: number, _sy: number) => {}, pinchEnd: () => {}, pan: (_dx: number, _dy: number) => {}, panEnd: () => {},
  });
  gesture.current = {
    tap: (pointerType) => {
      if (pointerType === "mouse") { togglePlayback(); return; }
      if (controls && shownPlaying) { autoHide.current?.cancel(); setControls(false); } else reveal();
    },
    doubleTap: (side, pointerType) => {
      if (pointerType === "mouse") { void toggleFullscreen(); return; }
      const step = side === "right" ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS;
      seek(shownTime + step);
      window.clearTimeout(seekFlashTimer.current);
      setSeekFlash((flash) => ({ side, seconds: flash && flash.side === side ? flash.seconds + SEEK_STEP_SECONDS : SEEK_STEP_SECONDS, key: (flash?.key ?? 0) + 1 }));
      seekFlashTimer.current = window.setTimeout(() => setSeekFlash(undefined), 700);
    },
    holdStart: () => {
      const element = video.current; if (!element || cast.casting) return;
      holdRate.current = element.playbackRate || 1; element.playbackRate = HOLD_PLAYBACK_RATE; setSpeedHold(true);
      if (element.paused) safePlay(element);
    },
    holdEnd: () => { const element = video.current; if (element) element.playbackRate = holdRate.current; setSpeedHold(false); },
    pinch: (scale, x, y, startX, startY) => {
      zoomStart.current ??= zoomRef.current;
      const { width, height } = surfaceSize();
      setZoom(pinchZoom(zoomStart.current, scale, x, y, startX, startY, width, height));
    },
    pinchEnd: () => { zoomStart.current = undefined; setZoom((value) => value.scale < 1.05 ? NO_ZOOM : value); },
    pan: (dx, dy) => { const { width, height } = surfaceSize(); setZoom((value) => clampZoom({ ...value, x: value.x + dx, y: value.y + dy }, width, height)); },
    panEnd: () => {},
  };
  const recognizer = useRef<ReturnType<typeof createPlayerGestures>>(undefined);
  recognizer.current ??= createPlayerGestures({
    width: () => surfaceSize().width,
    zoomed: () => zoomRef.current.scale > 1,
    actions: {
      tap: (pointerType) => gesture.current.tap(pointerType), doubleTap: (side, pointerType) => gesture.current.doubleTap(side, pointerType),
      holdStart: () => gesture.current.holdStart(), holdEnd: () => gesture.current.holdEnd(),
      pinch: (scale, x, y, sx, sy) => gesture.current.pinch(scale, x, y, sx, sy), pinchEnd: () => gesture.current.pinchEnd(),
      pan: (dx, dy) => gesture.current.pan(dx, dy), panEnd: () => gesture.current.panEnd(),
    },
  });
  const gesturePoint = (event: ReactPointerEvent<HTMLDivElement>): GesturePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top, pointerType: event.pointerType || "mouse", time: event.timeStamp || performance.now() };
  };
  const toggleMute = () => { const element = video.current; if (!element) return; resumeAudioBoost(); element.muted = !element.muted; setMuted(element.muted); savePlayerAudio({ volume: element.volume, muted: element.muted }); };
  const selectTrack = (id: string) => { setSubtitleTrack(id); localStorage.setItem("open-easyx.subtitle-track", id); setCaptionMenu(false); };
  const toggleAutoplay = () => { const value = !autoplay; setAutoplay(value); localStorage.setItem("open-easyx.autoplay", String(value)); };
  const next = async () => {
    await save(true, true);
    if (!autoplay || deleting) return;
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
    const element = video.current; if (media.kind !== "video" || !element) return;
    const output = createPlayerAudioBoost(element); audioBoost.current = output;
    resumeAudioBoost();
    return () => { audioBoost.current = undefined; output.dispose(); };
  }, [media.kind]);
  useEffect(() => {
    lastSaved.current = 0; autoHide.current?.cancel();
    recoveryPosition.current = undefined; compatibilityPlayback.current = false; setPlaybackError("");
    if (media.kind === "video" && video.current) {
      video.current.src = media.streamUrl; video.current.load();
    }
    initialAudio.current = loadPlayerAudio(); setVolume(initialAudio.current.volume); setMuted(initialAudio.current.muted);
    setPlaying(false); setWaiting(false); setControls(true); setCurrentTime(media.progressSeconds || 0); setDuration(media.duration || 0); setBuffered(0);
    setPhotoRemaining(PHOTO_AUTOPLAY_SECONDS); setPhotoReady(false); setCaptionMenu(false); setZoom(NO_ZOOM); setSpeedHold(false); setSeekFlash(undefined);
    setSubtitles({ status: "disabled", progress: 0, sourceLanguage: "", error: "", tracks: [] });
  }, [media.id]);
  useEffect(() => {
    if (media.kind !== "image") return;
    setPhotoRemaining(PHOTO_AUTOPLAY_SECONDS);
    if (!autoplay || !photoReady || deleting) return;
    const startedAt = Date.now();
    const updateCountdown = () => setPhotoRemaining(Math.max(0, Math.ceil(PHOTO_AUTOPLAY_SECONDS - (Date.now() - startedAt) / 1000)));
    const interval = window.setInterval(updateCountdown, 250);
    const timer = window.setTimeout(() => { void next(); }, PHOTO_AUTOPLAY_SECONDS * 1000);
    return () => { window.clearInterval(interval); window.clearTimeout(timer); };
  }, [media.id, media.kind, autoplay, photoReady, deleting]);
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
    return monitorVideoStalls(element, {
      reload: reloadPlayback,
      failed: () => failPlayback("The video image is still frozen. Try reloading the video.", true),
    });
  }, [media.id, media.kind, retry]);
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
      reveal();
      if (event.code === "Space" || event.key.toLowerCase() === "k") { event.preventDefault(); togglePlayback(); }
      else if (event.key === "ArrowLeft") seek(shownTime - 10); else if (event.key === "ArrowRight") seek(shownTime + 10);
      else if (event.key.toLowerCase() === "m") toggleMute(); else if (event.key.toLowerCase() === "f") void toggleFullscreen();
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [captionMenu, currentTime, media.id, media.kind, fullscreen, pageFullscreen, cast.casting, cast.remoteTime]);
  // Reset timers and active holds when leaving this media, rather than on each timeupdate.
  useEffect(() => () => { autoHide.current?.cancel(); recognizer.current?.dispose(); window.clearTimeout(seekFlashTimer.current); }, [media.id]);
  useEffect(() => { if (!captionMenu) reveal(); }, [captionMenu]);
  useEffect(() => { reveal(); }, [fullscreen]);

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
  const progress = shownDuration ? Math.min(100, shownTime / shownDuration * 100) : 0; const bufferedProgress = duration && !cast.casting ? Math.min(100, buffered / duration * 100) : 0;

  return <article className="watch-page">
    <div className="theater-stage">{media.kind === "video" ? <div ref={player} className={`custom-player ${pageFullscreen ? "page-fullscreen" : ""} ${controls || !shownPlaying ? "controls-visible" : "controls-hidden"} ${zoom.scale > 1 ? "zoomed" : ""}`} tabIndex={0} onPointerMove={(event) => { if (event.pointerType === "mouse") reveal(); }} onMouseLeave={() => shownPlaying && !captionMenu && setControls(false)}>
      <div ref={surface} className="player-surface" onPointerDown={(event) => { if (event.button > 0) return; event.currentTarget.setPointerCapture?.(event.pointerId); recognizer.current?.down(gesturePoint(event)); }}
        onPointerMove={(event) => recognizer.current?.move(gesturePoint(event))} onPointerUp={(event) => recognizer.current?.up(gesturePoint(event))} onPointerCancel={(event) => recognizer.current?.cancel(gesturePoint(event))}
        onContextMenu={(event) => { if (speedHold) event.preventDefault(); }}><video ref={video} style={zoom.scale > 1 ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: "0 0" } : undefined} src={media.streamUrl} poster={media.thumbnailUrl} playsInline preload="metadata" autoPlay={autoStart}
        onLoadedMetadata={(event) => { const element = event.currentTarget; const resumeAt = recoveryPosition.current; recoveryPosition.current = undefined; setDuration(element.duration || media.duration || 0); element.volume = initialAudio.current.volume; element.muted = initialAudio.current.muted; element.currentTime = resumeAt !== undefined ? Math.min(resumeAt, Number.isFinite(element.duration) ? Math.max(0, element.duration - 0.1) : resumeAt) : !media.completed && media.progressSeconds > 0 && media.progressSeconds < element.duration - 5 ? media.progressSeconds : 0; if ((resumeAt !== undefined || autoStart) && element.paused) safePlay(element); }}
        onError={(event) => { const code = event.currentTarget.error?.code; failPlayback(code === 3 || code === 4 ? "This video could not be decoded. Its format may not be supported by this browser." : "The video could not be loaded. Check the connection and try again.", code === 3 || code === 4); }}
        onTimeUpdate={(event) => { setCurrentTime(event.currentTarget.currentTime); void save(); }} onProgress={(event) => { const element = event.currentTarget; if (element.buffered.length) setBuffered(element.buffered.end(element.buffered.length - 1)); }}
        onPlay={() => { resumeAudioBoost(); setPlaying(true); reveal(); }} onPlaying={() => { setPlaying(true); setWaiting(false); setPlaybackError(""); }} onPause={() => { setPlaying(false); setWaiting(false); void save(false, true); }} onWaiting={() => setWaiting(true)} onCanPlay={() => setWaiting(false)}
        onVolumeChange={(event) => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); initialAudio.current = { volume: event.currentTarget.volume, muted: event.currentTarget.muted }; savePlayerAudio(initialAudio.current); }} onEnded={() => void next()}>
        {subtitles.tracks.map((track) => <track key={`${track.id}-${track.url}`} kind="subtitles" src={track.url} srcLang={track.language} label={track.label}/>)}
      </video></div>
      {seekFlash && <div key={seekFlash.key} className={`player-seek-flash ${seekFlash.side}`} aria-live="polite">{seekFlash.side === "left" ? <ChevronsLeft/> : <ChevronsRight/>}<span>{seekFlash.side === "left" ? "-" : "+"}{seekFlash.seconds}s</span></div>}
      {speedHold && <div className="player-speed-badge" aria-live="polite"><FastForward fill="currentColor"/>{HOLD_PLAYBACK_RATE}× speed</div>}
      {zoom.scale > 1 && <button className="player-zoom-reset" onClick={() => setZoom(NO_ZOOM)} aria-label="Reset zoom"><ZoomOut/>{zoom.scale.toFixed(1)}×</button>}
      {cast.casting && <div className="player-cast-overlay"><Cast/><b>Casting to {cast.device}</b><button className="quiet" onClick={cast.stop}>Stop casting</button></div>}
      {playbackError && <div className="player-error" role="alert"><AlertTriangle/><b>Video playback interrupted</b><span>{playbackError}</span><button className="quiet" onClick={() => { reloadPlayback(); setRetry((value) => value + 1); }}><RefreshCw/>Try again</button></div>}
      {waiting && !playbackError && <div className="player-buffering"><LoaderCircle className="spin"/></div>}{!shownPlaying && !(waiting && !cast.casting) && !playbackError && <button className="player-center-play" onClick={togglePlayback} aria-label="Play"><Play fill="currentColor"/></button>}
      <div className="player-controls" onClick={(event) => event.stopPropagation()} onPointerDown={reveal}><div className="player-timeline"><span className="player-buffered" style={{ width: `${bufferedProgress}%` }}/><span className="player-elapsed" style={{ width: `${progress}%` }}/><input type="range" min="0" max={shownDuration || 0} step="0.1" value={Math.min(shownTime, shownDuration || 0)} onChange={(event) => seek(Number(event.target.value))} aria-label="Video position"/></div>
        <div className="player-control-row"><div className="player-controls-left"><button className="player-icon-button" onClick={togglePlayback} aria-label={shownPlaying ? "Pause" : "Play"}>{shownPlaying ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><div className="player-volume"><button className="player-icon-button" onClick={toggleMute} aria-label={muted || volume === 0 ? "Unmute" : "Mute"}>{muted || volume === 0 ? <VolumeX/> : <Volume2/>}</button><input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => { const element = video.current; if (!element) return; resumeAudioBoost(); element.volume = Number(event.target.value); element.muted = element.volume === 0; }}/></div><select className={`player-audio-boost ${boost > 1 ? "active" : ""}`} aria-label="Audio boost" title="Amplify quiet videos" value={boost} onChange={(event) => changeBoost(Number(event.target.value))}>{Array.from({ length: MAX_AUDIO_BOOST }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value === 1 ? "Boost off" : `Boost ${value * 100}%`}</option>)}</select><span className="player-time"><b>{playerTime(shownTime)}</b><i>/</i><span>{playerTime(shownDuration)}</span></span></div>
          <div className="player-controls-right"><button className={`player-autoplay ${autoplay ? "active" : ""}`} aria-label="Autoplay" aria-pressed={autoplay} onClick={toggleAutoplay}><span>Auto</span><i/></button>
            <div className="caption-control"><button className={`player-icon-button ${subtitleTrack !== "off" && subtitles.tracks.length ? "active" : ""}`} onClick={() => { setCaptionMenu(!captionMenu); setControls(true); autoHide.current?.cancel(); }} aria-label="Subtitles"><Captions/></button>{captionMenu && <div className="caption-menu"><strong>Subtitles</strong>{subtitles.tracks.map((track) => <button key={track.id} className={subtitleTrack === track.id ? "active" : ""} onClick={() => selectTrack(track.id)}><span>{track.label}<small>{track.origin === "original" ? "Detected original language" : track.origin === "manual" ? "Imported subtitle file" : "Local translation"}</small></span>{subtitleTrack === track.id && <Check/>}</button>)}<button className={subtitleTrack === "off" ? "active" : ""} onClick={() => selectTrack("off")}><span>Off<small>Hide subtitles</small></span>{subtitleTrack === "off" && <Check/>}</button>{!subtitles.tracks.length && <p>{subtitleText}</p>}<div className="caption-upload"><select value={uploadLanguage} onChange={(event) => setUploadLanguage(event.target.value)}>{languages.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select><label className={uploading ? "disabled" : ""}><Upload/>{uploading ? "Adding…" : "Add VTT or SRT"}<input type="file" accept=".vtt,.srt,text/vtt,application/x-subrip" disabled={uploading} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }}/></label></div></div>}</div>
            <button className={`player-icon-button player-cast-button ${cast.casting ? "active" : ""} ${cast.available ? "" : "unavailable"}`} onClick={() => cast.casting ? cast.stop() : void cast.start(shownTime)} aria-label={cast.casting ? `Stop casting to ${cast.device}` : "Cast to a TV"} title={cast.casting ? `Casting to ${cast.device}` : cast.available ? "Cast to a TV" : "Cast (see how to enable it)"}><Cast/></button>
            <button className="player-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize/> : <Maximize/>}</button></div></div></div>
    </div> : <div ref={player} className={`image-stage ${pageFullscreen ? "page-fullscreen" : ""}`}><img src={media.streamUrl} alt={media.title} onLoad={() => setPhotoReady(true)} onError={() => setPhotoReady(true)}/><div className="photo-controls"><div className="photo-timeline"><i style={{ width: `${autoplay && photoReady ? (PHOTO_AUTOPLAY_SECONDS - photoRemaining) / PHOTO_AUTOPLAY_SECONDS * 100 : 0}%` }}/></div><div className="photo-control-row"><span>{autoplay ? photoReady ? `Next item in ${photoRemaining}s` : "Loading photo…" : "Autoplay is off"}</span><div><button className={`player-autoplay ${autoplay ? "active" : ""}`} aria-label="Autoplay" aria-pressed={autoplay} onClick={toggleAutoplay}><span>Auto</span><i/></button><button className="player-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize/> : <Maximize/>}</button></div></div></div></div>}</div>
    <section className="watch-info">
      <div className="watch-heading"><div><span className="watch-eyebrow">{media.source || "Local library"} · {media.kind === "video" ? "Video" : "Photo"}</span><h1>{media.title}</h1><p>{media.performer || "Unsorted"}</p></div><div className="watch-actions"><button className="quiet" onClick={() => void favorite(media, !media.favorite)}><Heart className={media.favorite ? "filled" : ""}/>{media.favorite ? "In favorites" : "Add to favorites"}</button>{remove && <button className="quiet watch-delete" disabled={deleting} onClick={() => void deleteCurrent()}>{deleting ? <LoaderCircle className="spin"/> : <Trash2/>}Delete</button>}<button className="quiet" onClick={closeViewer}><ArrowLeft/>Back</button></div></div>
      <div className="watch-meta"><span><Clock3/>{media.completed ? "Completed" : media.progressSeconds > 0 ? `${Math.round(media.progressSeconds / Math.max(1, media.duration) * 100)}% watched` : "Not started"}</span><span>{media.viewCount} {media.viewCount === 1 ? "view" : "views"}</span>{duration > 0 && <span>{playerTime(duration)}</span>}{media.width > 0 && media.height > 0 && <span>{media.width}×{media.height}</span>}<span><Grid3X3/>{media.extension.replace(".", "").toUpperCase()} · {bytes(media.size)}</span></div>
      <div className="watch-file"><span>Local file</span><code title={media.relativePath}>{media.relativePath}</code></div>
    </section>
  </article>;
}
