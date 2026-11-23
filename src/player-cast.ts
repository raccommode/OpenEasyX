import { useEffect, useRef, useState, type RefObject } from "react";

// Casting from the web player.
//
// - Chromecast / Google TV: the Google Cast Web Sender SDK, loaded on demand. Chrome only
//   offers it on a secure page (HTTPS, or localhost), so over plain http://NAS:3210 it is
//   not available and the browser's own "Cast…" menu (tab casting) remains the fallback.
// - AirPlay: Safari's own picker for the <video> element; works over plain HTTP.
// - Remote Playback API: Chrome on Android (and other browsers that support it) can send
//   the <video> element to a nearby device.
// The receiver fetches the file itself, so the stream URL must be reachable from the TV:
// open Open EasyX by the NAS address or host name, not via localhost.

const CAST_SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
const SDK_TIMEOUT_MS = 8_000;

type CastMedia = { title: string; performer: string; streamUrl: string; thumbnailUrl: string; mimeType: string; duration: number };
// The Cast SDK has no bundled types; only the members used here are described.
type CastWindow = Window & {
  __onGCastApiAvailable?: (available: boolean) => void;
  cast?: any; chrome?: any;
  WebKitPlaybackTargetAvailabilityEvent?: unknown;
};
type RemoteVideo = HTMLVideoElement & {
  remote?: { state: string; prompt: () => Promise<void>; watchAvailability: (callback: (available: boolean) => void) => Promise<number>; cancelWatchAvailability: (id?: number) => Promise<void> };
  webkitShowPlaybackTargetPicker?: () => void;
};

let sdk: Promise<boolean> | undefined;

/** Chrome (desktop or Android) on a secure page: the only place the Cast SDK works. */
export function chromecastSupported(win: CastWindow = window as CastWindow, userAgent = navigator.userAgent): boolean {
  return Boolean(win.isSecureContext) && /\b(?:Chrome|CriOS|Edg)\//.test(userAgent) && !/\bOPR\//.test(userAgent);
}

export function loadCastSdk(win: CastWindow = window as CastWindow): Promise<boolean> {
  if (win.cast?.framework) return Promise.resolve(true);
  sdk ??= new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), SDK_TIMEOUT_MS);
    win.__onGCastApiAvailable = (available) => { clearTimeout(timer); resolve(available && Boolean(win.cast?.framework)); };
    const script = document.createElement("script");
    script.src = CAST_SDK; script.async = true;
    script.onerror = () => { clearTimeout(timer); resolve(false); };
    document.head.appendChild(script);
  });
  return sdk;
}

/** Absolute address of a library URL, as the receiver needs it. */
export function receiverUrl(path: string, base = window.location.href): string {
  return new URL(path, base).href;
}

/** A TV cannot reach "localhost" on the computer that opened the page. */
export function unreachableFromTv(url: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname); } catch { return true; }
}

export type CastState = {
  /** Some cast route exists for this browser and page. */
  available: boolean;
  /** Playing on a Chromecast; local playback is paused and the controls drive the TV. */
  casting: boolean;
  device: string;
  remoteTime: number; remoteDuration: number; remotePaused: boolean;
  start: (localTime: number) => Promise<void>;
  replaceSource: (streamUrl: string, mimeType: string, seconds: number, playing: boolean) => Promise<void>;
  stop: () => void;
  togglePlay: () => void;
  seek: (seconds: number) => void;
};

type RemoteSnapshot = { time: number; duration: number; paused: boolean; device: string };

/** Observe only this video's session, and release SDK listeners when its viewer leaves. */
export function observeCastPlayer(framework: any, context: any, url: string, callbacks: {
  update: (snapshot: RemoteSnapshot | undefined) => void;
  pauseLocal: () => void;
  resumeLocal: (seconds: number, playing: boolean) => void;
}) {
  const player = new framework.RemotePlayer();
  const controller = new framework.RemotePlayerController(player);
  let last: RemoteSnapshot | undefined;
  let disposed = false;
  const update = () => {
    if (disposed) return;
    if (!player.isConnected) {
      if (last) {
        const previous = last; last = undefined;
        callbacks.update(undefined);
        callbacks.resumeLocal(previous.time, !previous.paused);
      }
      return;
    }
    if (!player.isMediaLoaded) return;
    const session = context.getCurrentSession();
    if (session?.getMediaSession()?.media?.contentId !== url) {
      if (last) { last = undefined; callbacks.update(undefined); }
      return;
    }
    if (!last) callbacks.pauseLocal();
    last = { time: player.currentTime, duration: player.duration, paused: player.isPaused, device: session.getCastDevice()?.friendlyName ?? "TV" };
    callbacks.update(last);
  };
  controller.addEventListener(framework.RemotePlayerEventType.ANY_CHANGE, update);
  update(); // Also synchronize an already connected session after reopening the viewer.
  return { player, controller, dispose: () => {
    disposed = true;
    controller.removeEventListener(framework.RemotePlayerEventType.ANY_CHANGE, update);
  } };
}

function castRequest(chrome: any, media: CastMedia, seconds: number, playing: boolean) {
  const info = new chrome.cast.media.MediaInfo(receiverUrl(media.streamUrl), media.mimeType || "video/mp4");
  info.streamType = chrome.cast.media.StreamType.BUFFERED;
  if (media.duration > 0) info.duration = media.duration;
  info.metadata = new chrome.cast.media.GenericMediaMetadata();
  info.metadata.title = media.title; info.metadata.subtitle = media.performer;
  if (media.thumbnailUrl) info.metadata.images = [new chrome.cast.Image(receiverUrl(media.thumbnailUrl))];
  const request = new chrome.cast.media.LoadRequest(info);
  request.currentTime = seconds; request.autoplay = playing;
  return request;
}

export function usePlayerCast(video: RefObject<HTMLVideoElement | null>, media: CastMedia, notice: (message: string) => void, resumeLocal: (seconds: number, playing: boolean) => void): CastState {
  const [chromecast, setChromecast] = useState(false);
  const [airplay, setAirplay] = useState(false);
  const [remotePlayback, setRemotePlayback] = useState(false);
  const [casting, setCasting] = useState(false);
  const [device, setDevice] = useState("");
  const [remoteTime, setRemoteTime] = useState(0); const [remoteDuration, setRemoteDuration] = useState(0); const [remotePaused, setRemotePaused] = useState(true);
  const remote = useRef<{ player: any; controller: any } | undefined>(undefined);
  const resume = useRef(resumeLocal); resume.current = resumeLocal;

  // Chromecast: load the SDK once on a page where it can work.
  useEffect(() => {
    const win = window as CastWindow;
    if (!chromecastSupported(win)) return;
    let active = true;
    let dispose: (() => void) | undefined;
    setCasting(false);
    void loadCastSdk(win).then((ready) => {
      if (!ready || !active) return;
      const framework = win.cast.framework; const chrome = win.chrome;
      const context = framework.CastContext.getInstance();
      context.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      const update = () => setChromecast(context.getCastState() !== framework.CastState.NO_DEVICES_AVAILABLE);
      update();
      context.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, update);
      const binding = observeCastPlayer(framework, context, receiverUrl(media.streamUrl), {
        pauseLocal: () => video.current?.pause(),
        resumeLocal: (seconds, playing) => resume.current(seconds, playing),
        update: (snapshot) => {
          setCasting(Boolean(snapshot));
          if (!snapshot) return;
          setRemoteTime(snapshot.time); setRemoteDuration(snapshot.duration); setRemotePaused(snapshot.paused); setDevice(snapshot.device);
        },
      });
      remote.current = binding;
      dispose = () => {
        context.removeEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, update);
        binding.dispose();
        if (remote.current === binding) remote.current = undefined;
      };
    });
    return () => { active = false; dispose?.(); };
  }, [media.streamUrl]);

  // AirPlay (Safari) and the Remote Playback API work on the <video> element itself.
  useEffect(() => {
    const element = video.current as RemoteVideo | null; if (!element) return;
    const win = window as CastWindow;
    const onAirplay = (event: Event) => setAirplay((event as Event & { availability?: string }).availability === "available");
    if (win.WebKitPlaybackTargetAvailabilityEvent) element.addEventListener("webkitplaybacktargetavailabilitychanged", onAirplay);
    let watchId: number | undefined;
    let active = true;
    if (element.remote && !win.WebKitPlaybackTargetAvailabilityEvent) {
      element.remote.watchAvailability((available) => { if (active) setRemotePlayback(available); }).then((id) => {
        if (active) watchId = id;
        else void element.remote?.cancelWatchAvailability(id).catch(() => {});
      }).catch(() => { if (active) setRemotePlayback(false); });
    }
    return () => {
      active = false;
      element.removeEventListener("webkitplaybacktargetavailabilitychanged", onAirplay);
      if (watchId !== undefined) void element.remote?.cancelWatchAvailability(watchId).catch(() => {});
    };
  }, [media.streamUrl]);

  const start = async (localTime: number) => {
    const win = window as CastWindow;
    const element = video.current as RemoteVideo | null;
    if (chromecast && remote.current) {
      const binding = remote.current;
      const url = receiverUrl(media.streamUrl);
      if (unreachableFromTv(url)) { notice("The TV cannot reach this page's address (localhost). Open Open EasyX by the NAS address to cast."); return; }
      const framework = win.cast.framework; const chrome = win.chrome;
      const context = framework.CastContext.getInstance();
      try { await context.requestSession(); }
      catch (error) { if (String(error) !== "cancel") notice("No cast session could be started."); return; }
      if (remote.current !== binding || video.current !== element) return;
      const session = context.getCurrentSession(); if (!session) return;
      const request = castRequest(chrome, media, localTime, true);
      try { await session.loadMedia(request); if (remote.current === binding && video.current === element) element?.pause(); }
      catch { notice("The TV could not play this file. Chromecast plays MP4 (H.264/AAC) and WebM; other formats need a re-encoding preset."); }
      return;
    }
    if (element?.webkitShowPlaybackTargetPicker && airplay) { element.webkitShowPlaybackTargetPicker(); return; }
    if (element?.remote && remotePlayback) {
      try { await element.remote.prompt(); }
      catch (error) { if ((error as DOMException)?.name !== "AbortError") notice("This browser could not start casting for this video."); }
      return;
    }
    notice(win.isSecureContext
      ? "No cast device was found. Make sure the TV or Chromecast is on the same network."
      : "Casting from the player needs Chrome over HTTPS (for example via the Synology reverse proxy) or Safari (AirPlay). In Chrome you can also use ⋮ → Cast… to cast this tab.");
  };

  const replaceSource = async (streamUrl: string, mimeType: string, seconds: number, playing: boolean) => {
    const win = window as CastWindow;
    const session = win.cast?.framework?.CastContext.getInstance().getCurrentSession();
    if (session?.getMediaSession()?.media?.contentId !== receiverUrl(media.streamUrl)) throw new Error("The Cast session changed. Select the audio language again.");
    await session.loadMedia(castRequest(win.chrome, { ...media, streamUrl, mimeType }, seconds, playing));
  };

  const stop = () => { (window as CastWindow).cast?.framework?.CastContext.getInstance().endCurrentSession(true); };
  const togglePlay = () => remote.current?.controller.playOrPause();
  const seek = (seconds: number) => {
    const current = remote.current; if (!current) return;
    current.player.currentTime = Math.max(0, Math.min(current.player.duration || seconds, seconds));
    current.controller.seek(); setRemoteTime(current.player.currentTime);
  };

  return { available: chromecast || airplay || remotePlayback, casting, device, remoteTime, remoteDuration, remotePaused, start, replaceSource, stop, togglePlay, seek };
}
