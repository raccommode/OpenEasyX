import React, { useEffect, useMemo, useRef, useState } from "react";
import type HlsInstance from "hls.js";
import { AlertTriangle, ArrowLeft, Download, Eye, LoaderCircle, Maximize, Minimize, Pause, Play, Radio, RefreshCw, Search, Server, Star, Users, Volume2, VolumeX } from "lucide-react";
import { api } from "./api";
import { loadPlayerAudio, savePlayerAudio } from "./player-audio";
import { monitorVideoStalls } from "./video-stall-recovery";
import "./player.css";
import "./watch-page.css";
import "./live-player.css";

export type LiveCam = {
  id: string; username: string; title?: string; pageUrl: string; thumbnailUrl?: string; viewers?: number; age?: number; gender?: string; tags?: string[];
  providerId: string; providerName: string; favorite?: boolean; online?: boolean;
};
type LiveCamFavorite = Pick<LiveCam, "providerId" | "id" | "username" | "title" | "pageUrl" | "thumbnailUrl">;
type Provider = { id: string; name: string; ok: boolean; count: number; pending?: boolean; error?: string };
type LiveCamResult = { available: boolean; reason?: string; items: LiveCam[]; total: number; page: number; pageSize: number; pages: number; providers: Provider[]; complete?: boolean };
export type LiveCamPreset = { query?: string; providerId?: string; gender?: "female" | "male" | "couple" | "trans" | ""; favoritesOnly?: boolean; page?: number };

export function liveCamPresetFromSearch(search: string): LiveCamPreset {
  const params = new URLSearchParams(search); const gender = params.get("gender") ?? "";
  return {
    query: params.get("q") ?? "", providerId: params.get("source") ?? "",
    gender: (["female", "male", "couple", "trans"].includes(gender) ? gender : "") as LiveCamPreset["gender"],
    favoritesOnly: params.get("favorites") === "1",
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
  };
}

export function liveCamListUrl(preset: LiveCamPreset = {}) {
  const params = new URLSearchParams();
  if (preset.query) params.set("q", preset.query); if (preset.providerId) params.set("source", preset.providerId);
  if (preset.gender) params.set("gender", preset.gender); if (preset.favoritesOnly) params.set("favorites", "1"); if ((preset.page ?? 1) > 1) params.set("page", String(preset.page));
  const query = params.toString(); return `/live-cam${query ? `?${query}` : ""}`;
}

export function liveCamUrl(cam: Pick<LiveCam, "providerId" | "id">) {
  return `/live-cam/${encodeURIComponent(cam.providerId)}/${encodeURIComponent(cam.id)}`;
}

export function LiveCamUnavailable({ reason }: { reason: string }) {
  return <div className="live-unavailable"><span><Server/></span><p>OPEN EASYX SOURCES</p><h2>No live-cam plugin is ready</h2><small>{reason}</small><code>Plugins → Sources &amp; live</code></div>;
}

export function shouldRecoverNativeLiveMediaError(code: number | undefined, hidden: boolean, foregroundedAt: number, currentTime: number): boolean {
  return code === 4 && (hidden || (foregroundedAt > 0 && currentTime - foregroundedAt < 5_000));
}

export function LivePlayer({ cam, close }: { cam: LiveCam; close: () => void }) {
  const video = useRef<HTMLVideoElement>(null); const player = useRef<HTMLDivElement>(null); const hideTimer = useRef<number | undefined>(undefined);
  const initialAudio = useRef(loadPlayerAudio(localStorage, { volume: 1, muted: true }));
  const [streamUrl, setStreamUrl] = useState(""); const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false); const [waiting, setWaiting] = useState(true); const [controls, setControls] = useState(true);
  const [volume, setVolume] = useState(initialAudio.current.volume); const [muted, setMuted] = useState(initialAudio.current.muted); const [fullscreen, setFullscreen] = useState(false);
  const reveal = () => {
    setControls(true); window.clearTimeout(hideTimer.current);
    if (!video.current?.paused) hideTimer.current = window.setTimeout(() => setControls(false), 2400);
  };
  const togglePlayback = () => {
    const element = video.current; if (!element) return;
    if (element.paused) void element.play().catch(() => setWaiting(false)); else element.pause();
  };
  const toggleMute = () => {
    const element = video.current; if (!element) return;
    element.muted = !element.muted; setMuted(element.muted); savePlayerAudio({ volume: element.volume, muted: element.muted });
  };
  const toggleFullscreen = async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await player.current?.requestFullscreen(); };
  useEffect(() => {
    const element = video.current; if (!element) return;
    element.volume = initialAudio.current.volume; element.muted = initialAudio.current.muted;
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); return; }
      if (["INPUT", "SELECT", "BUTTON"].includes((event.target as HTMLElement).tagName)) return;
      if (event.code === "Space" || event.key.toLowerCase() === "k") { event.preventDefault(); togglePlayback(); }
      else if (event.key.toLowerCase() === "m") toggleMute();
      else if (event.key.toLowerCase() === "f") void toggleFullscreen();
    };
    const onFullscreen = () => setFullscreen(document.fullscreenElement === player.current);
    window.addEventListener("keydown", onKey); document.addEventListener("fullscreenchange", onFullscreen);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("fullscreenchange", onFullscreen); window.clearTimeout(hideTimer.current); };
  }, [close]);
  useEffect(() => {
    let active = true; setStreamUrl(""); setError(""); setWaiting(true);
    void api<{ streamUrl: string }>("/api/live-cams/stream", { method: "POST", body: JSON.stringify({ providerId: cam.providerId, cam }) })
      .then((result) => { if (active) setStreamUrl(result.streamUrl); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [cam, retry]);
  useEffect(() => {
    const element = video.current; if (!element || !streamUrl) return;
    let hls: HlsInstance | undefined; let active = true; let nativeHls = false; let wasPlayingBeforeHidden = false; let needsNativeRecovery = false; let recoveryQueued = false; let foregroundedAt = 0;
    const recoverNativeStream = () => {
      if (!active || recoveryQueued) return;
      recoveryQueued = true; setError(""); setWaiting(true); setPlaying(false); setRetry((value) => value + 1);
    };
    const mediaError = () => {
      if (!active) return;
      const code = element.error?.code;
      if (nativeHls && shouldRecoverNativeLiveMediaError(code, document.hidden, foregroundedAt, Date.now())) {
        needsNativeRecovery = true; setError(""); setWaiting(true); setPlaying(false);
        if (!document.hidden) recoverNativeStream();
        return;
      }
      setWaiting(false); setPlaying(false);
      setError(code ? `Safari could not play this live stream (media error ${code}).` : "The live stream could not be played.");
    };
    const visibilityChanged = () => {
      if (!nativeHls) return;
      if (document.hidden) { wasPlayingBeforeHidden = !element.paused; return; }
      foregroundedAt = Date.now();
      if (!wasPlayingBeforeHidden) return;
      if (needsNativeRecovery || element.error?.code === 4) { recoverNativeStream(); return; }
      void element.play().catch(() => { if (element.error?.code === 4) recoverNativeStream(); });
    };
    element.addEventListener("error", mediaError);
    document.addEventListener("visibilitychange", visibilityChanged);
    const start = async () => {
      if (element.canPlayType("application/vnd.apple.mpegurl")) {
        nativeHls = true;
        element.src = streamUrl; element.load();
        await element.play().catch((reason) => { if (reason instanceof DOMException && reason.name === "NotAllowedError") setWaiting(false); else throw reason; });
        return;
      }
      const { default: Hls } = await import("hls.js"); if (!active) return;
      if (!Hls.isSupported()) { setError("This browser cannot play HLS live streams."); return; }
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30, highBufferWatchdogPeriod: 2, nudgeMaxRetry: 5 }); hls.loadSource(streamUrl); hls.attachMedia(element);
      hls.on(Hls.Events.MANIFEST_PARSED, () => void element.play().catch(() => setWaiting(false)));
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || !hls) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        setError("The live stream stopped or could not be decoded.");
      });
    };
    void start().catch(() => setError("The live player could not be initialized."));
    return () => { active = false; element.removeEventListener("error", mediaError); document.removeEventListener("visibilitychange", visibilityChanged); hls?.destroy(); element.pause(); element.removeAttribute("src"); element.load(); };
  }, [streamUrl]);
  useEffect(() => {
    const element = video.current;
    if (!element || !streamUrl) return;
    return monitorVideoStalls(element);
  }, [streamUrl]);
  return <div className="live-stage live-watch-stage">
    <div ref={player} className={`custom-player live-custom-player ${controls || !playing ? "controls-visible" : "controls-hidden"}`} tabIndex={0} onMouseMove={reveal} onTouchStart={reveal} onMouseLeave={() => playing && setControls(false)}>
      <div className="player-surface" onClick={togglePlayback} onDoubleClick={() => void toggleFullscreen()}><video ref={video} playsInline muted={muted} preload="auto"
        onPlay={() => { setPlaying(true); setWaiting(false); setError(""); reveal(); }} onPlaying={() => { setPlaying(true); setWaiting(false); setError(""); }} onPause={() => { setPlaying(false); setWaiting(false); }} onWaiting={() => setWaiting(true)} onCanPlay={() => setWaiting(false)}
        onVolumeChange={(event) => { const audio = { volume: event.currentTarget.volume, muted: event.currentTarget.muted }; setVolume(audio.volume); setMuted(audio.muted); initialAudio.current = audio; savePlayerAudio(audio); }}/></div>
      {waiting && !error && <div className="player-buffering"><LoaderCircle className="spin"/></div>}
      {!playing && !waiting && !error && <button className="player-center-play" onClick={togglePlayback} aria-label="Play live stream"><Play fill="currentColor"/></button>}
      <div className="player-controls" onClick={(event) => event.stopPropagation()}><div className="player-control-row"><div className="player-controls-left">
        <button className="player-icon-button" onClick={togglePlayback} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button>
        <div className="player-volume"><button className="player-icon-button" onClick={toggleMute} aria-label={muted || volume === 0 ? "Unmute" : "Mute"}>{muted || volume === 0 ? <VolumeX/> : <Volume2/>}</button><input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => { const element = video.current; if (!element) return; element.volume = Number(event.target.value); element.muted = element.volume === 0; }}/></div>
        <span className="player-live-status"><Radio/><i/>ON AIR</span>
      </div><div className="player-controls-right"><button className="player-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize/> : <Maximize/>}</button></div></div></div>
    </div>
    {!streamUrl && !error && <div className="live-stage-status"><LoaderCircle className="spin"/><b>Opening live stream…</b><small>Open EasyX is resolving a fresh provider URL.</small></div>}
    {error && <div className="live-stage-status error"><AlertTriangle/><b>Live player unavailable</b><small>{error}</small><button className="quiet" onClick={() => setRetry((value) => value + 1)}><RefreshCw/>Try again</button></div>}
  </div>;
}

export function LiveCamRecordButton({ cam }: { cam: LiveCam }) {
  const [recording, setRecording] = useState<"idle" | "queueing" | "queued">("idle"); const [itemId, setItemId] = useState(""); const [recordError, setRecordError] = useState("");
  const record = async () => {
    if (recording !== "idle") return;
    setRecording("queueing"); setRecordError("");
    try { const item = await api<{ itemId: string }>("/api/live-cams/record", { method: "POST", body: JSON.stringify({ providerId: cam.providerId, cam }) }); setItemId(item.itemId); setRecording("queued"); }
    catch (reason) { setRecording("idle"); setRecordError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <>{recording === "queued" ? <a className="quiet" href={`/activity?search=${encodeURIComponent(itemId)}`}><Download/>Manage recording</a> : <button className="quiet" onClick={() => void record()} disabled={recording === "queueing"}><Download/>{recording === "queueing" ? "Queuing…" : "Record live"}</button>}{recordError && <p className="row-error">{recordError}</p>}</>;
}

export function LiveCamFavoriteButton({ cam }: { cam: LiveCam }) {
  const [favorite, setFavorite] = useState(Boolean(cam.favorite)); const [saving, setSaving] = useState(false); const [favoriteError, setFavoriteError] = useState("");
  useEffect(() => setFavorite(Boolean(cam.favorite)), [cam.favorite]);
  const toggle = async () => {
    if (saving) return;
    const next = !favorite; setSaving(true); setFavoriteError("");
    try {
      await api("/api/live-cams/favorites", { method: "PUT", body: JSON.stringify({ providerId: cam.providerId, cam, favorite: next }) });
      setFavorite(next); window.dispatchEvent(new CustomEvent("easyx:live-favorites"));
    } catch (reason) { setFavoriteError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <>{<button className={`quiet live-favorite-button${favorite ? " active" : ""}`} onClick={() => void toggle()} disabled={saving} aria-pressed={favorite}><Star fill={favorite ? "currentColor" : "none"}/>{saving ? "Saving…" : favorite ? "Favorited" : "Favorite creator"}</button>}{favoriteError && <p className="row-error">{favoriteError}</p>}</>;
}

export function LiveCamCard({ cam, open }: { cam: LiveCam; open: (cam: LiveCam) => void }) {
  const offline = cam.online === false;
  return <a className={`live-card${offline ? " offline" : ""}`} href={offline ? undefined : liveCamUrl(cam)} aria-disabled={offline || undefined} onClick={(event) => {
    if (offline) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); open(cam);
  }}>
    <span className="live-thumb">{cam.thumbnailUrl ? <img src={cam.thumbnailUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/> : <Users/>}<i>{offline ? "OFFLINE" : "LIVE"}</i><em>{offline ? "Offline" : <><Eye/>{Number(cam.viewers ?? 0).toLocaleString()}</>}</em><strong>{cam.providerName}</strong>{!offline && <span><Play/></span>}</span>
    <span className="live-copy"><b>{cam.username}</b>{cam.age ? <i>{cam.age}</i> : null}<small>{cam.title && cam.title !== cam.username ? cam.title : (cam.tags?.slice(0, 3).map((tag) => `#${tag}`).join(" ") || (offline ? "Not broadcasting right now" : "Public live broadcast"))}</small></span>
  </a>;
}

export function LiveCamViewer({ providerId, camId, close }: { providerId: string; camId: string; close: () => void }) {
  const [cam, setCam] = useState<LiveCam | null>(null); const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setCam(null); setError("");
    void api<LiveCam>(`/api/live-cams/${encodeURIComponent(providerId)}/${encodeURIComponent(camId)}`, { signal: controller.signal })
      .then(setCam).catch((reason) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [providerId, camId]);
  useEffect(() => { if (cam) document.title = `${cam.username} live · Open EasyX`; }, [cam]);
  if (error) return <article className="watch-page"><div className="live-unavailable compact"><span><Radio/></span><h2>This cam is no longer live</h2><small>{error}</small><button className="quiet" onClick={close}><ArrowLeft/>Back to Live Cam</button></div></article>;
  if (!cam) return <article className="watch-page"><div className="loading"><LoaderCircle className="spin"/>Opening live cam…</div></article>;
  return <article className="watch-page live-watch-page">
    <section className="theater-stage"><LivePlayer cam={cam} close={close}/></section>
    <section className="watch-info">
      <div className="watch-heading"><div><span className="watch-eyebrow">LIVE · {cam.providerName}</span><h1>{cam.username}</h1><p>{cam.title && cam.title !== cam.username ? cam.title : "Public live broadcast"}</p></div><div className="watch-actions"><LiveCamFavoriteButton cam={cam}/><LiveCamRecordButton cam={cam}/><button className="quiet" onClick={close}><ArrowLeft/>Back to Live Cam</button></div></div>
      <div className="watch-meta"><span className="live-meta-on-air"><Radio/>ON AIR</span><span><Eye/>{Number(cam.viewers ?? 0).toLocaleString()} viewers</span><span><Radio/>{cam.providerName}</span>{cam.age ? <span>{cam.age} years old</span> : null}</div>
      {cam.tags?.length ? <div className="live-watch-tags">{cam.tags.slice(0, 12).map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}
    </section>
  </article>;
}

export function LiveCamPage({ preset, route, open }: { preset: LiveCamPreset; route: (preset: LiveCamPreset) => void; open: (cam: LiveCam) => void }) {
  const [result, setResult] = useState<LiveCamResult | null>(null);
  const searchInput = useRef<HTMLInputElement>(null); const searchTimer = useRef<number | undefined>(undefined);
  const [search, setSearch] = useState(preset.query ?? ""); const [providerId, setProviderId] = useState(preset.providerId ?? "");
  const [gender, setGender] = useState<LiveCamPreset["gender"]>(preset.gender ?? ""); const [favoritesOnly, setFavoritesOnly] = useState(Boolean(preset.favoritesOnly)); const [page, setPage] = useState(preset.page ?? 1);
  const [favorites, setFavorites] = useState<LiveCamFavorite[]>([]);
  const [loading, setLoading] = useState(true); const [refresh, setRefresh] = useState(0);
  const params = useMemo(() => new URLSearchParams({ page: String(page), pageSize: "24", search, providerId, gender: gender ?? "", favoritesOnly: favoritesOnly ? "1" : "" }), [page, search, providerId, gender, favoritesOnly]);
  useEffect(() => {
    const syncFromLocation = () => {
      const next = liveCamPresetFromSearch(window.location.search);
      if (searchInput.current) searchInput.current.value = next.query ?? "";
      setSearch(next.query ?? ""); setProviderId(next.providerId ?? ""); setGender(next.gender ?? ""); setFavoritesOnly(Boolean(next.favoritesOnly)); setPage(next.page ?? 1);
    };
    window.addEventListener("popstate", syncFromLocation); window.addEventListener("easyx:navigate", syncFromLocation);
    return () => { window.removeEventListener("popstate", syncFromLocation); window.removeEventListener("easyx:navigate", syncFromLocation); window.clearTimeout(searchTimer.current); };
  }, []);
  useEffect(() => { route({ query: search, providerId, gender, favoritesOnly, page }); }, [search, providerId, gender, favoritesOnly, page]);
  useEffect(() => {
    const loadFavorites = () => void api<{ items: LiveCamFavorite[] }>("/api/live-cams/favorites").then((value) => setFavorites(value.items)).catch(() => undefined);
    loadFavorites(); window.addEventListener("easyx:live-favorites", loadFavorites);
    return () => window.removeEventListener("easyx:live-favorites", loadFavorites);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let events: EventSource | undefined; let complete = false; const timer = window.setTimeout(() => {
      setLoading(true); setResult(null);
      const fallback = () => void api<LiveCamResult>(`/api/live-cams?${params}`, { signal: controller.signal }).then(setResult).catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setResult({ available: false, reason: reason instanceof Error ? reason.message : String(reason), items: [], total: 0, page, pageSize: 24, pages: 1, providers: [] });
      }).finally(() => setLoading(false));
      if (!("EventSource" in window)) { fallback(); return; }
      events = new EventSource(`/api/live-cams/events?${params}`);
      events.onmessage = (event) => {
        const next = JSON.parse(event.data) as Omit<LiveCamResult, "available">;
        setResult({ available: true, ...next });
        if (next.complete) { complete = true; setLoading(false); events?.close(); }
      };
      events.onerror = () => { events?.close(); if (!complete) fallback(); };
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); events?.close(); };
  }, [params, refresh]);
  useEffect(() => {
    if (loading) return;
    const timer = window.setInterval(() => { if (!document.hidden) setRefresh((value) => value + 1); }, 30_000);
    return () => window.clearInterval(timer);
  }, [loading]);
  const reset = (action: () => void) => { action(); setPage(1); };
  const providers = result?.providers ?? []; const allCount = providers.filter((provider) => provider.ok && !provider.pending).reduce((sum, provider) => sum + provider.count, 0);
  const loadedProviders = providers.filter((provider) => !provider.pending).length;
  const onlineFavorites = favoritesOnly ? result?.items.filter((cam) => cam.online !== false) ?? [] : [];
  const offlineFavorites = favoritesOnly ? result?.items.filter((cam) => cam.online === false) ?? [] : [];
  const camGrid = (items: LiveCam[]) => <div className="live-grid">{items.map((cam) => <LiveCamCard cam={cam} open={open} key={`${cam.providerId}:${cam.id}`}/>)}</div>;
  return <section className="live-page">
    <div className="library-intro live-intro"><div><p>LIVE NOW</p><h2>Live Cam</h2><span>Public live rooms aggregated by your installed Open EasyX source plugins</span></div><button className="quiet" onClick={() => setRefresh((value) => value + 1)} disabled={loading}><RefreshCw className={loading ? "spin" : ""}/>Refresh</button></div>
    {result?.available !== false && <div className="live-filters">
      <label><Search/><input ref={searchInput} defaultValue={search} onChange={(event) => { const value = event.currentTarget.value; window.clearTimeout(searchTimer.current); searchTimer.current = window.setTimeout(() => { setSearch(value); setPage(1); }, 300); }} placeholder="Search live cams or tags…"/></label>
      <label><Radio/><select aria-label="Filter live provider" value={providerId} onChange={(event) => reset(() => setProviderId(event.target.value))}><option value="">All live sources ({allCount.toLocaleString()}{loading ? "+" : ""})</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} ({provider.pending ? "loading…" : provider.count.toLocaleString()})</option>)}</select></label>
      <div className="live-genders"><button className={favoritesOnly ? "active favorite" : "favorite"} onClick={() => reset(() => setFavoritesOnly((value) => !value))}><Star fill={favoritesOnly ? "currentColor" : "none"}/>Favorites</button><button className={!gender ? "active" : ""} onClick={() => reset(() => setGender(""))}>All</button>{[["female", "Women"], ["male", "Men"], ["couple", "Couples"], ["trans", "Trans"]].map(([value, label]) => <button key={value} className={gender === value ? "active" : ""} onClick={() => reset(() => setGender(value as LiveCamPreset["gender"]))}>{label}</button>)}</div>
    </div>}
    {loading && !result ? <div className="loading"><LoaderCircle className="spin"/>Loading live cams…</div>
      : result?.available === false ? <LiveCamUnavailable reason={result.reason ?? "No live-cam provider is available in Open EasyX."}/>
      : result && !result.providers.length ? <div className="live-unavailable compact"><span><Radio/></span><h2>No live-cam plugin installed</h2><small>Install a live provider such as Chaturbate Live from Plugins. It will appear here automatically.</small></div>
      : result?.items.length ? <>
        <div className="live-summary"><b>{result.total.toLocaleString()}{loading ? "+" : ""} {favoritesOnly ? (result.total === 1 ? "favorite creator" : "favorite creators") : (result.total === 1 ? "live cam" : "live cams")}</b><span>{loading ? `Loading sources ${loadedProviders}/${result.providers.length}` : favoritesOnly ? `${onlineFavorites.length} live on this page` : `${result.providers.filter((provider) => provider.ok && provider.count > 0).length} active sources`}</span></div>
        {favoritesOnly ? <div className="favorite-live-sections">{onlineFavorites.length > 0 && <section><h3><i/>Live now</h3>{camGrid(onlineFavorites)}</section>}{offlineFavorites.length > 0 && <section className="offline"><h3><i/>Offline</h3>{camGrid(offlineFavorites)}</section>}</div> : camGrid(result.items)}
        {result.pages > 1 && <div className="pagination"><button disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {result.pages}</span><button disabled={page >= result.pages || loading} onClick={() => setPage(page + 1)}>Next</button></div>}
      </> : loading && result ? <div className="loading"><LoaderCircle className="spin"/>Loading sources {loadedProviders}/{result.providers.length}… {result.total.toLocaleString()} live cams found</div>
      : <div className="live-unavailable compact"><span>{favoritesOnly ? <Star/> : <Radio/>}</span><h2>{favoritesOnly ? (favorites.length ? "Your favorite creators are offline" : "No favorite creators yet") : "No public cams are live"}</h2><small>{favoritesOnly ? (favorites.length ? "They will appear here automatically when they go live again." : "Open a live stream and select Favorite creator to add it here.") : "Try another source or filter. Installed providers are refreshed every 30 seconds."}</small>{result?.providers.filter((provider) => !provider.ok).map((provider) => <p key={provider.id}>{provider.name}: {provider.error}</p>)}</div>}
  </section>;
}
