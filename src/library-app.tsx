import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture, BarChart3, ChevronLeft, ChevronRight, Clock3, Eye, Film, FolderSearch2, HardDrive, Heart, History, Image as ImageIcon,
  Library as LibraryIcon, ListChecks, LoaderCircle, Play, Search, SlidersHorizontal, Sparkles,
  Radio, Settings as SettingsIcon, Square, CheckSquare, Trash2, UserRound, Users, X,
} from "lucide-react";
import { api } from "./api";
import { PlayerViewer, type PlaybackContext } from "./Player";
import { autoplayOnOpen } from "./playback";
import { playbackAutoStart, playbackLocationState, type EasyXLocationState } from "./playbackRoute";
import { SettingsPage } from "./SettingsPage";
import { LiveCamPage, LiveCamViewer, liveCamListUrl, liveCamPresetFromSearch, liveCamUrl, type LiveCam } from "./LiveCamPage";
import { AppChrome } from "./AppChrome";
import "./library.css";

type Media = {
  id: string; relativePath: string; kind: "video" | "image"; title: string; performer: string; source: string;
  extension: string; mimeType: string; size: number; modifiedAt: string; duration: number; width: number; height: number;
  favorite: boolean; progressSeconds: number; completed: boolean; viewCount: number; lastViewedAt?: string; thumbnailUrl: string; previewUrl: string; streamUrl: string;
};
type Stats = {
  total: number; videos: number; images: number; bytes: number; videoBytes: number; imageBytes: number;
  viewed: number; viewedVideos: number; viewedImages: number; libraryDurationSeconds: number; watchedSeconds: number;
  views: number; performers: number; favorites: number; inProgress: number; completed: number;
};
type Dashboard = { stats: Stats; scan: Scan; featured?: Media; featuredReason: "continue" | "recent"; continueWatching: Media[]; oldestUnfinished: Media[]; recentContent: Media[]; recentVideos: Media[]; recentImages: Media[]; favorites: Media[] };
type Scan = { running: boolean; indexed: number; lastScanAt: string; error: string };
type LibraryResult = { items: Media[]; total: number; page: number; pageSize: number; pages: number };
type Performer = { name: string; count: number; videos: number; images: number; coverId?: string; coverUrl?: string };
type Facets = { performers: Performer[]; sources: Array<{ name: string; count: number }> };
type LibraryPreset = { query?: string; performer?: string; source?: string; kind?: "video" | "image" | ""; watched?: "unseen" | "progress" | "unfinished" | "completed" | ""; sort?: string; page?: number };
type Page = "home" | "live-cam" | "library" | "performers" | "favorites" | "history" | "statistics" | "settings";
type OpenMedia = (media: Media, context?: PlaybackContext) => void;
type DeletionResult = { deleted: Array<{ id: string; bytes: number; downloaderTracked: boolean }>; failed: Array<{ id: string; error: string }> };
type DeleteMedia = (ids: string[]) => Promise<DeletionResult>;
type Selection = { media: Media; context: PlaybackContext; autoStart: boolean };
type LocationState = { pathname: string; search: string; state: EasyXLocationState | null };

let previewBlockedUntil = 0;

const pagePaths: Record<Page, string> = { home: "/media", "live-cam": "/live-cam", library: "/library", performers: "/library-performers", favorites: "/favorites", history: "/history", statistics: "/statistics", settings: "/media-settings" };

export function isLibraryRoute(pathname: string) {
  return Object.values(pagePaths).some((route) => pathname === route || pathname.startsWith(`${route}/`)) || /^\/(watch|photos)\/[a-f0-9]{24}\/?$/.test(pathname);
}

function currentLocation(): LocationState {
  return { pathname: window.location.pathname, search: window.location.search, state: window.history.state as LocationState["state"] };
}
function pageFromPath(pathname: string): Page {
  const match = (Object.entries(pagePaths) as Array<[Page, string]>).find(([, value]) => value !== "/" && pathname.startsWith(value));
  return match?.[0] ?? "home";
}
function mediaRoute(pathname: string) {
  const match = /^\/(watch|photos)\/([a-f0-9]{24})\/?$/.exec(pathname);
  return match ? { kind: match[1] === "watch" ? "video" as const : "image" as const, id: match[2] } : undefined;
}
function liveCamRoute(pathname: string) {
  const match = /^\/live-cam\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try { return { providerId: decodeURIComponent(match[1]), camId: decodeURIComponent(match[2]) }; }
  catch { return undefined; }
}
function mediaUrl(media: Pick<Media, "id" | "kind">) { return `/${media.kind === "video" ? "watch" : "photos"}/${media.id}`; }
function presetFromSearch(search: string): LibraryPreset {
  const params = new URLSearchParams(search); const kind = params.get("kind") ?? ""; const watched = params.get("watched") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  return {
    query: params.get("q") ?? "", performer: params.get("performer") ?? "", source: params.get("source") ?? "",
    kind: (["video", "image"].includes(kind) ? kind : "") as LibraryPreset["kind"],
    watched: (["unseen", "progress", "unfinished", "completed"].includes(watched) ? watched : "") as LibraryPreset["watched"],
    sort: params.get("sort") ?? "", page,
  };
}
function pageUrl(page: Page, preset: LibraryPreset = {}) {
  const params = new URLSearchParams();
  if (preset.query) params.set("q", preset.query); if (preset.kind) params.set("kind", preset.kind);
  if (preset.performer) params.set("performer", preset.performer); if (preset.source) params.set("source", preset.source);
  if (preset.watched) params.set("watched", preset.watched); if (preset.sort) params.set("sort", preset.sort);
  if ((preset.page ?? 1) > 1) params.set("page", String(preset.page));
  const query = params.toString(); return `${pagePaths[page]}${query ? `?${query}` : ""}`;
}
function internalLink(event: React.MouseEvent, action: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); action();
}

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"]; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}
function formatDuration(seconds = 0) {
  if (!seconds) return ""; const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}` : `${minutes} min`;
}
function formatLongDuration(seconds = 0) {
  const whole = Math.max(0, Math.floor(seconds)); const hours = Math.floor(whole / 3600); const minutes = Math.floor((whole % 3600) / 60);
  return `${hours.toLocaleString()} h ${String(minutes).padStart(2, "0")} min ${String(whole % 60).padStart(2, "0")} s`;
}
function sourceDomain(value = "") {
  const source = value.trim();
  if (!source || (!source.includes(".") && !source.includes("://") && !source.includes("/"))) return source;
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(source) ? source : `https://${source}`);
    return parsed.hostname.replace(/^www\./i, "") || source;
  } catch {
    return source.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0] || source;
  }
}
function timeAgo(value?: string) {
  if (!value) return "Never"; const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`;
}

const nav: Array<[Page, string, React.ElementType]> = [
  ["home", "Home", Aperture], ["live-cam", "Live Cam", Radio], ["library", "Library", LibraryIcon], ["performers", "Performers", Users],
  ["favorites", "Favorites", Heart], ["history", "History", History], ["statistics", "Statistics", BarChart3], ["settings", "Settings", SettingsIcon],
];

export function LibraryApp() {
  const [location, setLocation] = useState<LocationState>(currentLocation);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [performers, setPerformers] = useState<Performer[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [notice, setNotice] = useState("");
  const routeMedia = mediaRoute(location.pathname);
  const routeLiveCam = liveCamRoute(location.pathname);
  const page = routeMedia ? pageFromPath(location.state?.easyx?.from?.split("?")[0] ?? "/library") : pageFromPath(location.pathname);
  const routePreset = useMemo(() => presetFromSearch(routeMedia ? (location.state?.easyx?.from?.split("?")[1] ? `?${location.state.easyx.from.split("?")[1]}` : "") : location.search), [location, routeMedia]);
  const liveCamPreset = useMemo(() => liveCamPresetFromSearch(routeLiveCam ? (location.state?.easyx?.from?.split("?")[1] ? `?${location.state.easyx.from.split("?")[1]}` : "") : location.search), [location, routeLiveCam]);

  const navigate = useCallback((url: string, options: { replace?: boolean; state?: LocationState["state"]; scroll?: boolean } = {}) => {
    const current = `${window.location.pathname}${window.location.search}`;
    if (current === url && options.state === undefined) return;
    window.history[options.replace ? "replaceState" : "pushState"](options.state ?? null, "", url);
    setLocation(currentLocation());
    if (options.scroll ?? !options.replace) window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  useEffect(() => { const changed = () => setLocation(currentLocation()); window.addEventListener("popstate", changed); return () => window.removeEventListener("popstate", changed); }, []);
  useEffect(() => {
    const blockHoverPreviews = () => { previewBlockedUntil = Date.now() + 220; };
    window.addEventListener("scroll", blockHoverPreviews, { capture: true, passive: true });
    window.addEventListener("wheel", blockHoverPreviews, { passive: true });
    window.addEventListener("touchmove", blockHoverPreviews, { passive: true });
    return () => {
      window.removeEventListener("scroll", blockHoverPreviews, true);
      window.removeEventListener("wheel", blockHoverPreviews);
      window.removeEventListener("touchmove", blockHoverPreviews);
    };
  }, []);

  const refresh = async () => {
    const [nextDashboard, nextPerformers] = await Promise.all([api<Dashboard>("/api/library-dashboard"), api<Performer[]>("/api/library-performers")]);
    setDashboard(nextDashboard); setPerformers(nextPerformers);
  };
  useEffect(() => { void refresh().catch((error) => setNotice(error.message)); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 4500); return () => clearTimeout(timer); }, [notice]);

  const go = (next: Page, preset: LibraryPreset = {}) => {
    navigate(pageUrl(next, preset)); if (next === "live-cam") window.dispatchEvent(new Event("easyx:navigate"));
  };
  const openMedia: OpenMedia = (media, context = {}) => {
    const from = `${window.location.pathname}${window.location.search}`;
    const autoStart = autoplayOnOpen(media.kind, localStorage.getItem("open-easyx.autoplay"));
    setSelected({ media, context, autoStart }); navigate(mediaUrl(media), { state: playbackLocationState(from, context, autoStart) });
  };
  const openLiveCam = (cam: LiveCam) => {
    const from = `${window.location.pathname}${window.location.search}`;
    navigate(liveCamUrl(cam), { state: { easyx: { from } } });
  };
  const rescan = async () => {
    setNotice("Scanning your media folders…");
    try { const result = await api<{ indexed: number }>("/api/scan", { method: "POST" }); await refresh(); setNotice(`Library refreshed — ${result.indexed} media files indexed.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const updateFavorite = async (media: Media, favorite: boolean) => {
    try {
      const updated = await api<Media>(`/api/media/${media.id}/favorite`, { method: "PUT", body: JSON.stringify({ favorite }) });
      if (selected?.media.id === media.id) setSelected({ ...selected, media: updated }); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const deleteMedia: DeleteMedia = async (ids) => {
    try {
      const result = await api<DeletionResult>("/api/media/delete", { method: "POST", body: JSON.stringify({ ids }) });
      await refresh();
      const count = result.deleted.length; const remembered = result.deleted.filter((item) => item.downloaderTracked).length;
      if (!count) setNotice(`${result.failed.length} ${result.failed.length === 1 ? "file could" : "files could"} not be deleted · ${result.failed[0]?.error ?? "Unknown error"}`);
      else {
        const summary = `${count} ${count === 1 ? "file" : "files"} permanently deleted${remembered ? ` · ${remembered} blocked from future downloads` : ""}`;
        setNotice(result.failed.length ? `${summary} · ${result.failed.length} failed` : summary);
      }
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  useEffect(() => {
    if (!routeMedia) { setSelected(null); return; }
    if (selected?.media.id === routeMedia.id) return;
    let cancelled = false;
    void api<Media>(`/api/media/${routeMedia.id}`).then((media) => {
      if (!cancelled) setSelected({ media, context: location.state?.easyx?.context ?? {}, autoStart: playbackAutoStart(location.state) });
    }).catch(() => { if (!cancelled) { setNotice("This media is no longer available."); navigate("/library", { replace: true }); } });
    return () => { cancelled = true; };
  }, [routeMedia?.id]);
  useEffect(() => { document.title = selected ? `${selected.media.title} · Open EasyX` : `${nav.find(([key]) => key === page)?.[1]} · Open EasyX`; }, [page, selected?.media.id, routeLiveCam?.camId]);

  if (!dashboard) return <div className="boot"><span className="logo">EX</span><LoaderCircle className="spin"/><p>Opening your private library…</p></div>;
  return <div className="library-mode"><AppChrome title={selected || routeLiveCam ? "Now playing" : nav.find(([key]) => key === page)?.[1] ?? "Home"} scanningLibrary={dashboard.scan.running} onScanLibrary={() => void rescan()}>
      {routeMedia ? selected ? <PlayerViewer media={selected.media} context={selected.context} autoStart={selected.autoStart} close={() => { const target = location.state?.easyx?.from ?? "/library"; setSelected(null); navigate(target, { replace: true }); void refresh(); }} favorite={updateFavorite} advance={(media) => { const from = location.state?.easyx?.from ?? "/library"; setSelected({ media, context: selected.context, autoStart: true }); navigate(mediaUrl(media), { state: playbackLocationState(from, selected.context, true) }); }} setNotice={setNotice}/> : <div className="loading"><LoaderCircle className="spin"/>Loading media…</div> : routeLiveCam ? <LiveCamViewer providerId={routeLiveCam.providerId} camId={routeLiveCam.camId} close={() => navigate(location.state?.easyx?.from ?? "/live-cam", { replace: true })}/> : <div className="content">
        {page === "home" && <Home dashboard={dashboard} open={openMedia} go={go} favorite={updateFavorite}/>}
        {page === "live-cam" && <LiveCamPage preset={liveCamPreset} open={openLiveCam} route={(preset) => navigate(liveCamListUrl(preset), { replace: true })}/>}
        {page === "library" && <Library preset={routePreset} open={openMedia} favorite={updateFavorite} remove={deleteMedia} route={(preset) => navigate(pageUrl("library", preset), { replace: true })}/>}
        {page === "performers" && <Performers performers={performers} go={go} query={routePreset.query ?? ""} route={(query) => navigate(pageUrl("performers", { query }), { replace: true })}/>}
        {page === "favorites" && <Library preset={routePreset} favoriteOnly open={openMedia} favorite={updateFavorite} remove={deleteMedia} route={(preset) => navigate(pageUrl("favorites", preset), { replace: true })}/>}
        {page === "history" && <Library preset={routePreset} historyOnly open={openMedia} favorite={updateFavorite} remove={deleteMedia} route={(preset) => navigate(pageUrl("history", preset), { replace: true })}/>}
        {page === "statistics" && <Statistics stats={dashboard.stats}/>}
        {page === "settings" && <SettingsPage setNotice={setNotice}/>}
      </div>}
    {notice && <div className="toast">{notice}<button onClick={() => setNotice("")}><X/></button></div>}
  </AppChrome></div>;
}

function Home({ dashboard, open, go, favorite }: { dashboard: Dashboard; open: OpenMedia; go: (page: Page, preset?: LibraryPreset) => void; favorite: (media: Media, value: boolean) => void }) {
  return <>
    {dashboard.recentContent.length ? <RecentCarousel items={dashboard.recentContent} open={open} favorite={favorite}/> : <EmptyLibrary scan={dashboard.scan}/>}
    <section className="stat-row"><Stat icon={Film} label="Videos" value={dashboard.stats.videos}/><Stat icon={ImageIcon} label="Photos" value={dashboard.stats.images}/></section>
    <Shelf title="Continue watching" subtitle="Videos you started but have not finished" items={dashboard.continueWatching} open={open} favorite={favorite} all={() => go("library", { kind: "video", watched: "progress", sort: "history" })}/>
    <Shelf title="Oldest unfinished videos" subtitle="Work through the oldest videos that are not completed yet" items={dashboard.oldestUnfinished} open={open} favorite={favorite} all={() => go("library", { kind: "video", watched: "unfinished", sort: "oldest" })}/>
    <Shelf title="Recently added videos" subtitle="The newest videos in your collection" items={dashboard.recentVideos} open={open} favorite={favorite} all={() => go("library", { kind: "video", sort: "recent" })}/>
    <Shelf title="Recently added photos" subtitle="The newest photos in your collection" items={dashboard.recentImages} open={open} favorite={favorite} all={() => go("library", { kind: "image", sort: "recent" })}/>
    {dashboard.favorites.length > 0 && <Shelf title="Your favorites" subtitle="Saved for later" items={dashboard.favorites} open={open} favorite={favorite} all={() => go("favorites")}/>}
  </>;
}

export function RecentCarousel({ items, open, favorite }: { items: Media[]; open: OpenMedia; favorite: (media: Media, value: boolean) => void }) {
  const [index, setIndex] = useState(0); const [paused, setPaused] = useState(false);
  useEffect(() => { setIndex((current) => Math.min(current, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => {
    if (paused || items.length < 2) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % items.length), 8000);
    return () => window.clearInterval(timer);
  }, [items.length, paused]);
  if (!items.length) return null;
  const current = items[index]; const ids = items.map((item) => item.id);
  const move = (direction: number) => setIndex((value) => (value + direction + items.length) % items.length);
  return <section className="hero home-carousel" aria-roledescription="carousel" aria-label="Latest content" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
    <img key={current.id} src={current.thumbnailUrl} alt="" decoding="async" fetchPriority="high"/>
    <div className="hero-shade"></div><div className="hero-copy"><span><Sparkles/>LATEST CONTENT · {current.kind === "video" ? "VIDEO" : "PHOTO"}</span><h2>{current.title}</h2><p>{current.performer || "Unsorted"}{current.source ? ` - ${sourceDomain(current.source)}` : ""}</p>
    <div><button className="primary big" onClick={() => open(current, { ids })}>{current.kind === "video" ? <Play/> : <ImageIcon/>}{current.kind === "video" ? "Play now" : "View photo"}</button><button className="glass" onClick={() => void favorite(current, !current.favorite)}><Heart className={current.favorite ? "filled" : ""}/>{current.favorite ? "Saved" : "Add to favorites"}</button></div></div>
    {items.length > 1 && <><div className="home-carousel-controls"><button aria-label="Previous latest content" onClick={() => move(-1)}><ChevronLeft/></button><span>{index + 1} / {items.length}</span><button aria-label="Next latest content" onClick={() => move(1)}><ChevronRight/></button></div><div className="home-carousel-dots">{items.map((item, itemIndex) => <button key={item.id} className={itemIndex === index ? "active" : ""} aria-label={`Show slide ${itemIndex + 1}: ${item.title}`} aria-current={itemIndex === index ? "true" : undefined} onClick={() => setIndex(itemIndex)}/>)}</div></>}
  </section>;
}

function Stat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
  return <div className="stat-card"><span><Icon/></span><div><b>{value.toLocaleString()}</b><small>{label}</small></div></div>;
}

function Statistics({ stats }: { stats: Stats }) {
  const storageTotal = Math.max(1, stats.bytes); const watchedPercent = stats.total ? Math.round(stats.viewed / stats.total * 100) : 0;
  return <section className="statistics-page">
    <div className="library-intro"><div><p>LIBRARY INSIGHTS</p><h2>Statistics</h2><span>A complete snapshot of your local collection and viewing activity</span></div></div>
    <div className="statistics-highlights">
      <article><span><LibraryIcon/></span><div><small>Total content</small><b>{stats.total.toLocaleString()}</b><p>{stats.videos.toLocaleString()} {stats.videos === 1 ? "video" : "videos"} · {stats.images.toLocaleString()} {stats.images === 1 ? "photo" : "photos"}</p></div></article>
      <article><span><Eye/></span><div><small>Content viewed</small><b>{stats.viewed.toLocaleString()}</b><p>{watchedPercent}% of your collection</p></div></article>
      <article className="wide-stat"><span><Clock3/></span><div><small>Accumulated watch time</small><b>{formatLongDuration(stats.watchedSeconds)}</b><p>Completed runtime plus saved progress</p></div></article>
      <article><span><HardDrive/></span><div><small>Total storage</small><b>{formatBytes(stats.bytes)}</b><p>Videos and photos combined</p></div></article>
    </div>
    <div className="statistics-panels">
      <section className="statistics-panel"><div className="statistics-panel-head"><div><p>STORAGE</p><h3>Space by media type</h3></div><HardDrive/></div>
        <div className="storage-total"><b>{formatBytes(stats.bytes)}</b><small>Total indexed size</small></div>
        <div className="storage-bar" aria-label={`${formatBytes(stats.videoBytes)} of videos and ${formatBytes(stats.imageBytes)} of photos`}><i style={{ width: `${stats.videoBytes / storageTotal * 100}%` }}/><i style={{ width: `${stats.imageBytes / storageTotal * 100}%` }}/></div>
        <div className="storage-legend"><div><span className="video-dot"/><p><b>Videos</b><small>{stats.videos.toLocaleString()} {stats.videos === 1 ? "file" : "files"}</small></p><strong>{formatBytes(stats.videoBytes)}</strong></div><div><span className="photo-dot"/><p><b>Photos</b><small>{stats.images.toLocaleString()} {stats.images === 1 ? "file" : "files"}</small></p><strong>{formatBytes(stats.imageBytes)}</strong></div></div>
      </section>
      <section className="statistics-panel"><div className="statistics-panel-head"><div><p>VIEWING</p><h3>Your activity</h3></div><Eye/></div>
        <div className="activity-grid"><div><b>{stats.viewedVideos.toLocaleString()}</b><small>Videos viewed</small></div><div><b>{stats.viewedImages.toLocaleString()}</b><small>Photos viewed</small></div><div><b>{stats.completed.toLocaleString()}</b><small>Completed</small></div><div><b>{stats.inProgress.toLocaleString()}</b><small>In progress</small></div></div>
        <div className="activity-foot"><span><b>{stats.views.toLocaleString()}</b> counted views</span><span><Heart/>{stats.favorites.toLocaleString()} favorites</span></div>
      </section>
      <section className="statistics-panel runtime-panel"><div className="statistics-panel-head"><div><p>VIDEO LIBRARY</p><h3>Total available runtime</h3></div><Film/></div><b className="runtime-value">{formatLongDuration(stats.libraryDurationSeconds)}</b><p>Combined duration of indexed videos whose runtime is available.</p></section>
      <section className="statistics-panel collection-panel"><div className="statistics-panel-head"><div><p>COLLECTION</p><h3>At a glance</h3></div><BarChart3/></div><div><span><Users/>Performers</span><b>{stats.performers.toLocaleString()}</b></div><div><span><Film/>Videos</span><b>{stats.videos.toLocaleString()}</b></div><div><span><ImageIcon/>Photos</span><b>{stats.images.toLocaleString()}</b></div></section>
    </div>
  </section>;
}

function Shelf({ title, subtitle, items, open, favorite, all }: { title: string; subtitle: string; items: Media[]; open: OpenMedia; favorite: (media: Media, value: boolean) => void; all: () => void }) {
  if (!items.length) return null;
  return <section className="shelf"><div className="section-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={all}>View all</button></div><div className="media-row">{items.map((media) => <MediaCard key={media.id} media={media} open={(item) => open(item, { ids: items.map((entry) => entry.id) })} favorite={favorite}/>)}</div></section>;
}

function Library({ preset = {}, favoriteOnly = false, historyOnly = false, open, favorite, remove, route }: { preset?: LibraryPreset; favoriteOnly?: boolean; historyOnly?: boolean; open: OpenMedia; favorite: (media: Media, value: boolean) => void; remove: DeleteMedia; route: (preset: LibraryPreset) => void }) {
  const [query, setQuery] = useState(preset.query ?? "");
  const [kind, setKind] = useState(preset.kind ?? "");
  const [performer, setPerformer] = useState(preset.performer ?? "");
  const [source, setSource] = useState(preset.source ?? "");
  const [watched, setWatched] = useState(preset.watched ?? "");
  const [sort, setSort] = useState(preset.sort ?? (historyOnly ? "history" : "recent"));
  const [facets, setFacets] = useState<Facets>({ performers: [], sources: [] });
  const [result, setResult] = useState<LibraryResult | null>(null);
  const [page, setPage] = useState(preset.page ?? 1); const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false); const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()); const [deleting, setDeleting] = useState(false);
  const params = useMemo(() => new URLSearchParams({
    q: query, kind, performer, source, watched, sort, page: String(page), pageSize: "48",
    favorite: favoriteOnly ? "true" : "", history: historyOnly ? "true" : "",
  }), [query, kind, performer, source, watched, sort, page, favoriteOnly, historyOnly]);
  const playlistQuery = useMemo(() => new URLSearchParams({ q: query, kind, performer, source, watched, sort, favorite: favoriteOnly ? "true" : "", history: historyOnly ? "true" : "" }).toString(), [query, kind, performer, source, watched, sort, favoriteOnly, historyOnly]);
  const facetParams = useMemo(() => new URLSearchParams({ performer, watched }).toString(), [performer, watched]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<Facets>(`/api/facets?${facetParams}`, { signal: controller.signal }).then(setFacets).catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    }, 100);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [facetParams]);
  useEffect(() => {
    setQuery(preset.query ?? ""); setKind(preset.kind ?? ""); setPerformer(preset.performer ?? ""); setSource(preset.source ?? "");
    setWatched(preset.watched ?? ""); setSort(preset.sort || (historyOnly ? "history" : "recent")); setPage(preset.page ?? 1);
  }, [preset.query, preset.kind, preset.performer, preset.source, preset.watched, preset.sort, preset.page, historyOnly]);
  useEffect(() => { route({ query, kind, performer, source, watched, sort, page }); }, [query, kind, performer, source, watched, sort, page]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      void api<LibraryResult>(`/api/library?${params}`).then(setResult).finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [params]);
  useEffect(() => { setSelectionMode(false); setSelectedIds(new Set()); }, [params]);
  const title = favoriteOnly ? "Favorite media" : historyOnly ? "Watch history" : performer || "Media library";
  const resetPage = <T,>(setter: (value: T) => void, value: T) => { setter(value); setPage(1); };
  const clearFilters = () => { setQuery(""); setKind(""); setPerformer(""); setSource(""); setWatched(""); setSort(historyOnly ? "history" : "recent"); setPage(1); };
  const toggleSelected = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectPage = () => setSelectedIds((current) => result?.items.every((item) => current.has(item.id)) ? new Set() : new Set(result?.items.map((item) => item.id) ?? []));
  const cancelSelection = () => { setSelectionMode(false); setSelectedIds(new Set()); };
  const deleteSelected = async () => {
    if (!selectedIds.size || !window.confirm(`Permanently delete ${selectedIds.size} selected ${selectedIds.size === 1 ? "file" : "files"}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const response = await remove([...selectedIds]); const removed = new Set(response.deleted.map((item) => item.id));
      setResult((current) => current && ({ ...current, items: current.items.filter((item) => !removed.has(item.id)), total: Math.max(0, current.total - removed.size), pages: Math.max(1, Math.ceil((current.total - removed.size) / current.pageSize)) }));
      setSelectedIds((current) => new Set([...current].filter((id) => !removed.has(id))));
      if (!response.failed.length) cancelSelection();
    } catch { /* The app-level notice reports request failures. */ }
    finally { setDeleting(false); }
  };
  return <section className="library-page"><div className="library-intro"><div><p>COLLECTION</p><h2>{title}</h2><span>{result?.total ?? 0} matching items</span></div><div className="selection-actions">{selectionMode ? <><span>{selectedIds.size} selected</span><button className="quiet" onClick={selectPage}>{result?.items.every((item) => selectedIds.has(item.id)) ? "Clear page" : "Select page"}</button><button className="delete-selection" disabled={!selectedIds.size || deleting} onClick={() => void deleteSelected()}>{deleting ? <LoaderCircle className="spin"/> : <Trash2/>}Delete</button><button className="quiet" disabled={deleting} onClick={cancelSelection}><X/>Cancel</button></> : <button className="quiet" disabled={!result?.items.length} onClick={() => setSelectionMode(true)}><ListChecks/>Select</button>}</div></div>
    <div className="filters">
      <label><Search/><input value={query} onChange={(event) => resetPage(setQuery, event.target.value)} placeholder="Search titles, performers, or sources…"/></label>
      <div className="filter-buttons"><button className={!kind ? "active" : ""} onClick={() => resetPage(setKind, "")}>All</button><button className={kind === "video" ? "active" : ""} onClick={() => resetPage(setKind, "video")}><Film/>Videos</button><button className={kind === "image" ? "active" : ""} onClick={() => resetPage(setKind, "image")}><ImageIcon/>Photos</button></div>
      <label className="sort"><SlidersHorizontal/><select aria-label="Sort media" value={sort} onChange={(event) => resetPage(setSort, event.target.value)}><option value="recent">Recently added</option><option value="oldest">Oldest first</option><option value="history">Last viewed</option><option value="title">Title A–Z</option><option value="largest">Largest files</option><option value="most-viewed">Most viewed</option></select></label>
      <div className="advanced-filters">
        <label><UserRound/><select aria-label="Filter by performer" value={performer} onChange={(event) => resetPage(setPerformer, event.target.value)}><option value="">All performers</option>{facets.performers.map((item) => <option value={item.name} key={item.name}>{item.name} ({item.count})</option>)}</select></label>
        <label><HardDrive/><select aria-label="Filter by source" value={source} onChange={(event) => resetPage(setSource, event.target.value)}><option value="">All sources</option>{source && !facets.sources.some((item) => item.name === source) && <option value={source}>{source} (0)</option>}{facets.sources.map((item) => <option value={item.name} key={item.name}>{item.name} ({item.count})</option>)}</select></label>
        <label><Play/><select aria-label="Filter by watch state" value={watched} onChange={(event) => resetPage(setWatched, event.target.value as Exclude<LibraryPreset["watched"], undefined>)}><option value="">Any watch state</option><option value="unseen">Never opened</option><option value="progress">In progress</option><option value="unfinished">Not completed</option><option value="completed">Completed</option></select></label>
        <button className="clear-filters" onClick={clearFilters}>Clear filters</button>
      </div>
    </div>
    {loading ? <div className="loading"><LoaderCircle className="spin"/>Loading media…</div> : result?.items.length ? <div className={`media-grid ${selectionMode ? "selecting" : ""}`}>{result.items.map((media) => <MediaCard key={media.id} media={media} open={(item) => open(item, { query: playlistQuery })} favorite={favorite} selectionMode={selectionMode} selected={selectedIds.has(media.id)} toggleSelected={toggleSelected}/>)}</div> : <div className="empty-state"><FolderSearch2/><h3>No media found</h3><p>Try another filter or scan the mounted media folder.</p></div>}
    {result && result.pages > 1 && <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {result.pages}</span><button disabled={page >= result.pages} onClick={() => setPage(page + 1)}>Next</button></div>}
  </section>;
}

function Performers({ performers, go, query, route }: { performers: Performer[]; go: (page: Page, preset?: LibraryPreset) => void; query: string; route: (query: string) => void }) {
  const filtered = performers.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  return <section className="performers-page"><div className="library-intro"><div><p>PEOPLE</p><h2>Performers</h2><span>Folders and metadata discovered in your library</span></div><label className="performer-search"><Search/><input value={query} onChange={(event) => route(event.target.value)} placeholder="Find a performer…"/></label></div><div className="performer-grid">{filtered.map((performer) => { const href = pageUrl("library", { performer: performer.name }); return <a href={href} key={performer.name} className="performer-card" onClick={(event) => internalLink(event, () => go("library", { performer: performer.name }))}><span className="performer-avatar"><UserRound/>{performer.coverUrl && <LazyImage src={performer.coverUrl} alt="" onError={(event) => { event.currentTarget.hidden = true; }}/>}</span><div><h3>{performer.name}</h3><p>{performer.count} media files</p><small><Film/>{performer.videos}<ImageIcon/>{performer.images}</small></div></a>; })}</div></section>;
}

function LazyImage({ src, className, alt, onLoad, onError }: { src: string; className?: string; alt: string; onLoad?: () => void; onError?: React.ReactEventHandler<HTMLImageElement> }) {
  const image = useRef<HTMLImageElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = image.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true); observer.disconnect();
    }, { rootMargin: "240px 180px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <img ref={image} className={className} src={visible ? src : undefined} loading="lazy" decoding="async" fetchPriority="low" alt={alt} onLoad={onLoad} onError={onError}/>;
}

function MediaCard({ media, open, favorite, selectionMode = false, selected = false, toggleSelected }: { media: Media; open: OpenMedia; favorite: (media: Media, value: boolean) => void; selectionMode?: boolean; selected?: boolean; toggleSelected?: (id: string) => void }) {
  const viewed = media.completed || (media.kind === "image" && media.viewCount > 0);
  const progress = viewed ? 100 : media.duration ? Math.min(100, media.progressSeconds / media.duration * 100) : 0;
  const timer = useRef<number | undefined>(undefined); const [preview, setPreview] = useState(false); const [previewReady, setPreviewReady] = useState(false); const [unavailable, setUnavailable] = useState(false);
  const startPreview = () => {
    if (selectionMode || Date.now() < previewBlockedUntil || preview || media.kind !== "video" || !media.previewUrl || !window.matchMedia("(hover: hover)").matches) return;
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { setPreviewReady(false); setPreview(true); }, 320);
  };
  const stopPreview = () => { window.clearTimeout(timer.current); setPreview(false); setPreviewReady(false); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { setPreview(false); setPreviewReady(false); setUnavailable(false); }, [media.id]);
  const href = mediaUrl(media);
  const activate = () => selectionMode ? toggleSelected?.(media.id) : open(media);
  if (unavailable) return null;
  return <article className={`media-card ${selected ? "selected" : ""}`}>{selectionMode && <button className="selection-control" aria-label={selected ? `Deselect ${media.title}` : `Select ${media.title}`} aria-pressed={selected} onClick={() => toggleSelected?.(media.id)}>{selected ? <CheckSquare/> : <Square/>}</button>}<a className="poster" href={href} aria-label={selectionMode ? `${selected ? "Deselect" : "Select"} ${media.title}` : `Open ${media.kind}: ${media.title}`} onClick={(event) => internalLink(event, activate)} onMouseMove={startPreview} onMouseLeave={stopPreview} onFocus={startPreview} onBlur={stopPreview} onWheel={stopPreview}>
    <span className="media-art"><LazyImage className="poster-still" src={media.thumbnailUrl} alt="" onError={() => setUnavailable(true)}/>{preview && <img className={`poster-preview ${previewReady ? "ready" : ""}`} src={media.previewUrl} decoding="async" alt="" onLoad={() => setPreviewReady(true)} onError={stopPreview}/>}</span>
    <span className="play">{media.kind === "video" ? <Play/> : <Search/>}</span><span className="type">{media.kind === "video" ? <Film/> : <ImageIcon/>}</span>{media.duration > 0 && <time>{formatDuration(media.duration)}</time>}{progress > 0 && <span className={`watch-label ${viewed ? "complete" : ""}`}>{viewed ? "Completed" : `${Math.round(progress)}%`}</span>}{progress > 0 && <i className={viewed ? "completed" : ""} style={{ width: `${progress}%` }}></i>}</a>
    <div className="media-copy"><a className="media-title" href={href} onClick={(event) => internalLink(event, activate)}>{media.title}</a><p>{media.performer || "Unsorted"}{media.source ? ` - ${sourceDomain(media.source)}` : ""}{media.viewCount ? ` · ${media.viewCount} ${media.viewCount === 1 ? "view" : "views"}` : ""}</p></div>{!selectionMode && <button className="heart-button" aria-label={media.favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => void favorite(media, !media.favorite)}><Heart className={media.favorite ? "filled" : ""}/></button>}</article>;
}

function EmptyLibrary({ scan }: { scan: Scan }) {
  return <section className="empty-library"><span><FolderSearch2/></span><p>READY FOR YOUR COLLECTION</p><h2>{scan.running ? "Indexing your media…" : "Your library is empty"}</h2><small>Mount your collection at <code>/media</code>. Files are modified only when you explicitly delete selected media.</small></section>;
}
