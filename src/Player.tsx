import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, ArrowLeft, Cast, ChevronsLeft, ChevronsRight, FastForward, ZoomOut, Clock3, Grid3X3, Heart, LoaderCircle, Maximize, Minimize, Pause, Play, RefreshCw, Trash2, Volume2, VolumeX } from "lucide-react";
import { dubbingStreamUrl, readyDub, PlayerDubbing, useMediaDubbing } from "./PlayerDubbing";
import { PlayerSubtitles, readSubtitlePreference, selectedSubtitleTrack, useMediaSubtitles } from "./PlayerSubtitles";
import { api } from "./api";
import { initialAutoplay, nextMediaId, PHOTO_AUTOPLAY_SECONDS } from "./playback";
import { loadPlayerAudio, savePlayerAudio } from "./player-audio";
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
export type PlaybackContext = { query?: string; ids?: string[] };

function readPlayerPreference(key: string) {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(key); }
  catch { return null; }
}
function writePlayerPreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
}
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
  const recovery = useRef<{ seconds: number; playing: boolean } | undefined>(undefined);
  const [preferredDub, setPreferredDub] = useState(() => readPlayerPreference("open-easyx.dubbing-language") || "");
  const [dub, setDub] = useState<{ id: string; language: string; version?: string; failed?: boolean }>();
  const [compatibleId, setCompatibleId] = useState("");
  const [switchingDub, setSwitchingDub] = useState(false);
  const dubRequest = useRef(0);
  const dubbing = useMediaDubbing(media.kind === "video" ? media.id : undefined);
  const currentDub = dub?.id === media.id ? dub : undefined;
  const language = currentDub?.language ?? "";
  const choosingInitialDub = !!preferredDub && !currentDub && media.kind === "video";
  const streamUrl = dubbingStreamUrl(media.streamUrl, language, compatibleId === media.id, currentDub?.version);
  const mimeType = language || compatibleId === media.id ? "video/mp4" : media.mimeType;
  const [playbackError, setPlaybackError] = useState("");
  const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false); const [waiting, setWaiting] = useState(false); const [controls, setControls] = useState(true);
  const [currentTime, setCurrentTime] = useState(media.progressSeconds || 0); const [duration, setDuration] = useState(media.duration || 0); const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(initialAudio.current.volume); const [muted, setMuted] = useState(initialAudio.current.muted);
  const { fullscreen, pageFullscreen, toggleFullscreen } = usePlayerFullscreen(player, video, media.id);
  const [autoplay, setAutoplay] = useState(() => initialAutoplay(media.kind, autoStart, readPlayerPreference("open-easyx.autoplay")));
  const [photoRemaining, setPhotoRemaining] = useState(PHOTO_AUTOPLAY_SECONDS); const [photoReady, setPhotoReady] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<"audio" | "subtitles" | null>(null);
  const menuOpen = useRef(false); menuOpen.current = !!menu;
  const [preferredTrack, setPreferredTrack] = useState(() => readSubtitlePreference(readPlayerPreference("open-easyx.subtitle-track")));
  const { state: subtitles, update: updateSubtitles } = useMediaSubtitles(media.kind === "video" ? media.id : undefined);
  const subtitleTrack = selectedSubtitleTrack(preferredTrack, subtitles?.tracks ?? [], subtitles?.targetLanguages);
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM); const zoomRef = useRef(zoom); zoomRef.current = zoom; const zoomStart = useRef<ZoomState | undefined>(undefined);
  const [speedHold, setSpeedHold] = useState(false); const holdRate = useRef(1);
  const [seekFlash, setSeekFlash] = useState<{ side: GestureSide; seconds: number; key: number } | undefined>(undefined); const seekFlashTimer = useRef<number | undefined>(undefined);
  const cast = usePlayerCast(video, { ...media, streamUrl, mimeType }, setNotice, (seconds, resumePlaying) => {
    const element = video.current; if (!element) return;
    if (recovery.current || element.readyState === 0) {
      recovery.current = { seconds, playing: resumePlaying };
      return;
    }
    element.currentTime = seconds; setCurrentTime(seconds);
    if (resumePlaying) safePlay(element);
  });

  const restorePoint = (element: HTMLVideoElement) => recovery.current ?? {
    seconds: Number.isFinite(element.currentTime) ? element.currentTime : currentTime,
    playing: !element.paused,
  };
  const useCompatiblePlayback = () => {
    const element = video.current;
    if (!element || (!language && compatibleId === media.id)) return false;
    recovery.current ??= { seconds: Number.isFinite(element.currentTime) ? element.currentTime : 0, playing: true };
    element.autoplay = false;
    setPlaybackError(""); setWaiting(true); setPlaying(false);
    if (language) {
      setDub({ id: media.id, language: "", failed: true });
      setNotice("This dubbed version could not be played. Returning to original audio.");
    } else {
      setCompatibleId(media.id);
      setNotice("Preparing a browser-compatible video. This can take a while for long recordings.");
    }
    return true;
  };
  const failPlayback = (message: string, tryCompatibility = false) => { if (tryCompatibility && useCompatiblePlayback()) return; setPlaybackError(message); setWaiting(false); setPlaying(false); video.current?.pause(); };
  const safePlay = (element: HTMLVideoElement) => {
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
    recovery.current = { seconds: Number.isFinite(element.currentTime) ? element.currentTime : currentTime, playing: true };
    setPlaybackError(""); setWaiting(true); setPlaying(false);
    element.load();
  };

  const save = (completed = false, force = false) => {
    const element = video.current; if (!element || recovery.current || !Number.isFinite(element.duration)) return Promise.resolve();
    if (!force && !completed && Math.abs(element.currentTime - lastSaved.current) < 8) return Promise.resolve();
    lastSaved.current = element.currentTime;
    return api(`/api/media/${media.id}/progress`, { method: "PUT", body: JSON.stringify({ position: element.currentTime, duration: element.duration || media.duration || 0, completed }) }).catch((error) => setNotice(error.message));
  };
  const closeViewer = () => { void save(false, true); close(); };
  const autoHide = useRef<ReturnType<typeof createControlsAutoHide>>(undefined);
  autoHide.current ??= createControlsAutoHide({ show: () => setControls(true), hide: () => setControls(false), paused: () => video.current?.paused ?? true, pinned: () => menuOpen.current });
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
  const toggleMute = () => { const element = video.current; if (!element) return; element.muted = !element.muted; setMuted(element.muted); savePlayerAudio({ volume: element.volume, muted: element.muted }); };
  const selectTrack = (id: string) => {
    const track = subtitles?.tracks.find((entry) => entry.id === id);
    const choice = track ? { id: track.id, language: track.language } : id;
    setPreferredTrack(choice);
    writePlayerPreference("open-easyx.subtitle-track", typeof choice === "string" ? choice : JSON.stringify(choice));
    setMenu(null);
  };
  const switchDub = async (nextLanguage: string, remember = false) => {
    const element = video.current;
    if (!element) return;
    const nextVersion = readyDub(dubbing, nextLanguage)?.playbackVersion;
    const rememberChoice = () => {
      if (!remember) return;
      setPreferredDub(nextLanguage);
      writePlayerPreference("open-easyx.dubbing-language", nextLanguage);
    };
    if (nextLanguage === language && nextVersion === currentDub?.version) {
      rememberChoice(); setMenu(null); return;
    }
    const request = ++dubRequest.current;
    const point = cast.casting ? { seconds: cast.remoteTime, playing: !cast.remotePaused } : restorePoint(element);
    if (cast.casting) {
      setSwitchingDub(true);
      try {
        const nextUrl = dubbingStreamUrl(media.streamUrl, nextLanguage, compatibleId === media.id, nextVersion);
        await cast.replaceSource(nextUrl, nextLanguage || compatibleId === media.id ? "video/mp4" : media.mimeType, point.seconds, point.playing);
      } catch (err) {
        if (request === dubRequest.current) setNotice(err instanceof Error ? err.message : "The TV could not switch audio languages.");
        return;
      } finally { if (request === dubRequest.current) setSwitchingDub(false); }
    }
    if (request !== dubRequest.current) return;
    // Before the first metadata event the new source should use the video's saved progress and autoplay.
    if (cast.casting || recovery.current || element.readyState > 0) {
      recovery.current = { seconds: point.seconds, playing: !cast.casting && point.playing };
    }
    element.autoplay = false;
    rememberChoice();
    setDub({ id: media.id, language: nextLanguage, version: nextVersion }); setPlaybackError(""); setWaiting(true); setMenu(null);
  };
  const toggleAutoplay = () => { const value = !autoplay; setAutoplay(value); writePlayerPreference("open-easyx.autoplay", String(value)); };
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
    lastSaved.current = 0; autoHide.current?.cancel();
    recovery.current = undefined; setDub(undefined); setCompatibleId(""); setPlaybackError(""); setSwitchingDub(false);
    if (media.kind === "video" && video.current) {
      video.current.autoplay = autoStart;
      if (!video.current.hasAttribute("src")) video.current.load();
    }
    initialAudio.current = loadPlayerAudio(); setVolume(initialAudio.current.volume); setMuted(initialAudio.current.muted);
    setPlaying(false); setWaiting(false); setControls(true); setCurrentTime(media.progressSeconds || 0); setDuration(media.duration || 0); setBuffered(0);
    setPhotoRemaining(PHOTO_AUTOPLAY_SECONDS); setPhotoReady(false); setMenu(null); setZoom(NO_ZOOM); setSpeedHold(false); setSeekFlash(undefined);
    return () => { dubRequest.current++; };
  }, [media.id]);
  useEffect(() => {
    if (media.kind !== "video") return;
    const variant = readyDub(dubbing, preferredDub);
    if (!currentDub) {
      const initial = { id: media.id, language: variant?.code ?? "", version: variant?.playbackVersion };
      if (preferredDub && !dubbing) {
        // Keep playback available if looking up audio versions takes too long.
        const timer = window.setTimeout(() => setDub(initial), 2500);
        return () => window.clearTimeout(timer);
      }
      setDub(initial);
    } else if (dubbing && !currentDub.failed && (language !== (variant?.code ?? "") || currentDub.version !== variant?.playbackVersion)) {
      void switchDub(variant?.code ?? "");
    }
  }, [media.id, media.kind, currentDub, preferredDub, dubbing]);
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
    const element = video.current;
    if (media.kind !== "video" || !element) return;
    return monitorVideoStalls(element, {
      reload: reloadPlayback,
      failed: () => failPlayback("The video image is still frozen. Try reloading the video.", true),
    });
  }, [media.id, media.kind, streamUrl, retry]);
  useEffect(() => {
    video.current?.querySelectorAll("track").forEach((element) => {
      element.track.mode = element.dataset.trackId === subtitleTrack ? "showing" : "disabled";
    });
  }, [subtitleTrack, subtitles?.tracks, streamUrl]);
  useEffect(() => {
    if (!subtitles?.pluginEnabled && !subtitles?.tracks.length) setMenu((open) => open === "subtitles" ? null : open);
  }, [subtitles]);
  useEffect(() => {
    if (!dubbing?.variants.length) setMenu((open) => open === "audio" ? null : open);
  }, [dubbing]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu) { setMenu(null); return; }
      if (media.kind !== "video" || ["INPUT", "SELECT", "BUTTON"].includes((event.target as HTMLElement).tagName)) return;
      reveal();
      if (event.code === "Space" || event.key.toLowerCase() === "k") { event.preventDefault(); togglePlayback(); }
      else if (event.key === "ArrowLeft") seek(shownTime - 10); else if (event.key === "ArrowRight") seek(shownTime + 10);
      else if (event.key.toLowerCase() === "m") toggleMute(); else if (event.key.toLowerCase() === "f") void toggleFullscreen();
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [menu, currentTime, media.id, media.kind, fullscreen, pageFullscreen, cast.casting, cast.remoteTime]);
  // Reset timers and active holds when leaving this media, rather than on each timeupdate.
  useEffect(() => () => { autoHide.current?.cancel(); recognizer.current?.dispose(); window.clearTimeout(seekFlashTimer.current); }, [media.id]);
  useEffect(() => { if (!menu) reveal(); }, [menu]);
  useEffect(() => { reveal(); }, [fullscreen]);

  const progress = shownDuration ? Math.min(100, shownTime / shownDuration * 100) : 0; const bufferedProgress = duration && !cast.casting ? Math.min(100, buffered / duration * 100) : 0;

  return <article className="watch-page">
    <div className="theater-stage">{media.kind === "video" ? <div ref={player} className={`custom-player ${pageFullscreen ? "page-fullscreen" : ""} ${controls || !shownPlaying ? "controls-visible" : "controls-hidden"} ${zoom.scale > 1 ? "zoomed" : ""}`} tabIndex={0} onPointerMove={(event) => { if (event.pointerType === "mouse") reveal(); }} onMouseLeave={() => shownPlaying && !menu && setControls(false)}>
      <div ref={surface} className="player-surface" onPointerDown={(event) => { if (event.button > 0) return; event.currentTarget.setPointerCapture?.(event.pointerId); recognizer.current?.down(gesturePoint(event)); }}
        onPointerMove={(event) => recognizer.current?.move(gesturePoint(event))} onPointerUp={(event) => recognizer.current?.up(gesturePoint(event))} onPointerCancel={(event) => recognizer.current?.cancel(gesturePoint(event))}
        onContextMenu={(event) => { if (speedHold) event.preventDefault(); }}><video ref={video} style={zoom.scale > 1 ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: "0 0" } : undefined} src={choosingInitialDub ? undefined : streamUrl} poster={media.thumbnailUrl} playsInline preload="metadata" autoPlay={autoStart}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          const pending = recovery.current; recovery.current = undefined;
          setDuration(element.duration || media.duration || 0);
          element.volume = initialAudio.current.volume; element.muted = initialAudio.current.muted;
          if (pending) element.currentTime = Math.min(pending.seconds, Number.isFinite(element.duration) ? Math.max(0, element.duration - 0.1) : pending.seconds);
          else element.currentTime = !media.completed && media.progressSeconds > 0 && media.progressSeconds < element.duration - 5 ? media.progressSeconds : 0;
          if ((pending ? pending.playing : autoStart) && element.paused) safePlay(element);
          else if (pending && !pending.playing) { element.pause(); setWaiting(false); }
        }}
        onError={(event) => { const code = event.currentTarget.error?.code; failPlayback(code === 3 || code === 4 ? "This video could not be decoded. Its format may not be supported by this browser." : "The video could not be loaded. Check the connection and try again.", code === 3 || code === 4); }}
        onTimeUpdate={(event) => { setCurrentTime(event.currentTarget.currentTime); void save(); }} onProgress={(event) => { const element = event.currentTarget; if (element.buffered.length) setBuffered(element.buffered.end(element.buffered.length - 1)); }}
        onPlay={() => { setPlaying(true); reveal(); }} onPlaying={() => { setPlaying(true); setWaiting(false); setPlaybackError(""); }} onPause={() => { setPlaying(false); setWaiting(false); void save(false, true); }} onWaiting={() => setWaiting(true)} onCanPlay={() => setWaiting(false)}
        onVolumeChange={(event) => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); initialAudio.current = { volume: event.currentTarget.volume, muted: event.currentTarget.muted }; savePlayerAudio(initialAudio.current); }} onEnded={() => void next()}>
        {subtitles?.tracks.map((track) => <track key={`${track.id}-${track.updatedAt}`} data-track-id={track.id} kind="subtitles" src={track.url} srcLang={track.language} label={track.label}/>)}
      </video></div>
      {seekFlash && <div key={seekFlash.key} className={`player-seek-flash ${seekFlash.side}`} aria-live="polite">{seekFlash.side === "left" ? <ChevronsLeft/> : <ChevronsRight/>}<span>{seekFlash.side === "left" ? "-" : "+"}{seekFlash.seconds}s</span></div>}
      {speedHold && <div className="player-speed-badge" aria-live="polite"><FastForward fill="currentColor"/>{HOLD_PLAYBACK_RATE}× speed</div>}
      {zoom.scale > 1 && <button className="player-zoom-reset" onClick={() => setZoom(NO_ZOOM)} aria-label="Reset zoom"><ZoomOut/>{zoom.scale.toFixed(1)}×</button>}
      {cast.casting && <div className="player-cast-overlay"><Cast/><b>Casting to {cast.device}</b><button className="quiet" onClick={cast.stop}>Stop casting</button></div>}
      {playbackError && <div className="player-error" role="alert"><AlertTriangle/><b>Video playback interrupted</b><span>{playbackError}</span><button className="quiet" onClick={() => { reloadPlayback(); setRetry((value) => value + 1); }}><RefreshCw/>Try again</button></div>}
      {(choosingInitialDub || waiting) && !playbackError && <div className="player-buffering"><LoaderCircle className="spin"/></div>}{!choosingInitialDub && !shownPlaying && !(waiting && !cast.casting) && !playbackError && <button className="player-center-play" onClick={togglePlayback} aria-label="Play"><Play fill="currentColor"/></button>}
      <div className="player-controls" onClick={(event) => event.stopPropagation()} onPointerDown={reveal}><div className="player-timeline"><span className="player-buffered" style={{ width: `${bufferedProgress}%` }}/><span className="player-elapsed" style={{ width: `${progress}%` }}/><input type="range" min="0" max={shownDuration || 0} step="0.1" value={Math.min(shownTime, shownDuration || 0)} onChange={(event) => seek(Number(event.target.value))} aria-label="Video position"/></div>
        <div className="player-control-row"><div className="player-controls-left"><button className="player-icon-button" onClick={togglePlayback} aria-label={shownPlaying ? "Pause" : "Play"}>{shownPlaying ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><div className="player-volume"><button className="player-icon-button" onClick={toggleMute} aria-label={muted || volume === 0 ? "Unmute" : "Mute"}>{muted || volume === 0 ? <VolumeX/> : <Volume2/>}</button><input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => { const element = video.current; if (!element) return; element.volume = Number(event.target.value); element.muted = element.volume === 0; }}/></div><span className="player-time"><b>{playerTime(shownTime)}</b><i>/</i><span>{playerTime(shownDuration)}</span></span></div>
          <div className="player-controls-right"><button className={`player-autoplay ${autoplay ? "active" : ""}`} aria-label="Autoplay" aria-pressed={autoplay} onClick={toggleAutoplay}><span>Auto</span><i/></button>
            <PlayerDubbing state={dubbing} selected={language} busy={switchingDub} open={menu === "audio"} toggle={() => { setMenu(menu === "audio" ? null : "audio"); setControls(true); autoHide.current?.cancel(); }} select={(code) => void switchDub(code, true)}/>
            {subtitles && <PlayerSubtitles key={media.id} mediaId={media.id} state={subtitles} selected={subtitleTrack} automatic={preferredTrack === "auto"} open={menu === "subtitles"} toggle={() => { setMenu(menu === "subtitles" ? null : "subtitles"); setControls(true); autoHide.current?.cancel(); }} select={selectTrack} update={updateSubtitles} setNotice={setNotice}/>}
            <button disabled={choosingInitialDub} className={`player-icon-button player-cast-button ${cast.casting ? "active" : ""} ${cast.available ? "" : "unavailable"}`} onClick={() => cast.casting ? cast.stop() : void cast.start(shownTime)} aria-label={cast.casting ? `Stop casting to ${cast.device}` : "Cast to a TV"} title={cast.casting ? `Casting to ${cast.device}` : cast.available ? "Cast to a TV" : "Cast (see how to enable it)"}><Cast/></button>
            <button className="player-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize/> : <Maximize/>}</button></div></div></div>
    </div> : <div ref={player} className={`image-stage ${pageFullscreen ? "page-fullscreen" : ""}`}><img src={media.streamUrl} alt={media.title} onLoad={() => setPhotoReady(true)} onError={() => setPhotoReady(true)}/><div className="photo-controls"><div className="photo-timeline"><i style={{ width: `${autoplay && photoReady ? (PHOTO_AUTOPLAY_SECONDS - photoRemaining) / PHOTO_AUTOPLAY_SECONDS * 100 : 0}%` }}/></div><div className="photo-control-row"><span>{autoplay ? photoReady ? `Next item in ${photoRemaining}s` : "Loading photo…" : "Autoplay is off"}</span><div><button className={`player-autoplay ${autoplay ? "active" : ""}`} aria-label="Autoplay" aria-pressed={autoplay} onClick={toggleAutoplay}><span>Auto</span><i/></button><button className="player-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize/> : <Maximize/>}</button></div></div></div></div>}</div>
    <section className="watch-info">
      <div className="watch-heading"><div><span className="watch-eyebrow">{media.source || "Local library"} · {media.kind === "video" ? "Video" : "Photo"}</span><h1>{media.title}</h1><p>{media.performer || "Unsorted"}</p></div><div className="watch-actions"><button className="quiet" onClick={() => void favorite(media, !media.favorite)}><Heart className={media.favorite ? "filled" : ""}/>{media.favorite ? "In favorites" : "Add to favorites"}</button>{remove && <button className="quiet watch-delete" disabled={deleting} onClick={() => void deleteCurrent()}>{deleting ? <LoaderCircle className="spin"/> : <Trash2/>}Delete</button>}<button className="quiet" onClick={closeViewer}><ArrowLeft/>Back</button></div></div>
      <div className="watch-meta"><span><Clock3/>{media.completed ? "Completed" : media.progressSeconds > 0 ? `${Math.round(media.progressSeconds / Math.max(1, media.duration) * 100)}% watched` : "Not started"}</span><span>{media.viewCount} {media.viewCount === 1 ? "view" : "views"}</span>{duration > 0 && <span>{playerTime(duration)}</span>}{media.width > 0 && media.height > 0 && <span>{media.width}×{media.height}</span>}<span><Grid3X3/>{media.extension.replace(".", "").toUpperCase()} · {bytes(media.size)}</span></div>
      <div className="watch-file"><span>Local file</span><code title={media.relativePath}>{media.relativePath}</code></div>
    </section>
  </article>;
}
