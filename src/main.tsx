import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Box, Captions, Check, ChevronLeft, ChevronRight, CircleAlert, ClipboardPaste, CloudDownload, Database, Download, ExternalLink, FolderOpen, Gauge, Globe2, HardDrive, LayoutDashboard, Link2, LoaderCircle, PackagePlus, Pause, Pencil, Play, Plug, Plus, RefreshCw, Search, Settings, ShieldCheck, Sparkles, Square, Terminal, Trash2, UserRound, Users, X } from "lucide-react";
import { api } from "./api.js";
import { activitySourceDomains, confirmItemDeletion, downloadTime } from "./activity.js";
import { pluginFaviconUrl } from "./plugin-icon.js";
import { canonicalEntryPath, pageFromPath, pagePath, type PageKey } from "./routes.js";
import { LogsPage } from "./logs.js";
import { isLibraryRoute, LibraryApp } from "./library-app.js";
import { AppChrome } from "./AppChrome.js";
import { SettingsPage as SubtitleSettingsPage } from "./SettingsPage.js";
import "./styles.css";
import "./scraper.css";
import "./activity.css";
import "./repositories.css";
import "./unified-navigation.css";
import "./plugin-catalog.css";
import "./app-chrome.css";
import "./settings-navigation.css";
import "./performer-discovery.css";

type Plugin = { manifest: { id: string; name: string; version: string; description: string; author: string; homepage?: string; capabilities: string[]; settings?: Array<{ key: string; label: string; type: string; required?: boolean; default?: unknown; placeholder?: string; help?: string; cookieDomains?: string[]; sessionFormat?: "cookies" | "raw-json" }>; browserAuth?: { loginUrl: string; sessionSetting: string; capture?: "cookies" | "onlyfans" | "manyvids" | "authorization-header"; requestDomains?: string[] }; sourceUrlPatterns?: string[]; fallback?: boolean; polling?: { mode: "periodic" | "live"; defaultIntervalSeconds: number; minimumIntervalSeconds: number } }; installed: boolean; enabled: boolean; config: Record<string, unknown>; origin: string };
type PluginRepository = { id: string; name: string; url: string; official: boolean; removable: boolean; addedAt: string; updatedAt: string; pluginCount: number };
type Performer = { id: string; name: string; aliases: string[]; imageUrl?: string; externalRefs: Record<string, string> };
type LocalPerformerImage = { id: string; title: string; source: string; modifiedAt: string; thumbnailUrl: string };
type Source = { id: string; performerId: string; pluginId: string; label: string; profileUrl: string; domain: string; enabled: boolean; autoDownload: boolean; scraperPluginId?: string; scrapeEnabled: boolean; syncIntervalSeconds: number; lastSyncedAt?: string; lastError?: string };
type Item = { id: string; performerId: string; sourceId: string; pluginId: string; title?: string; mediaType: string; status: string; progress: number; downloadedBytes: number; qualityScore: number; expectedBytes?: number; storagePath?: string; outputPath?: string; error?: string; downloadStartedAt?: string; downloadFinishedAt?: string; updatedAt: string };
type ActivityData = { items: Item[]; page: number; pageSize: number; total: number; totalPages: number; statusCounts: Record<string, number>; mediaTypes: string[] };
type Dashboard = { stats: { performers: number; sources: number; available: number; queued: number; completed: number; bytes: number }; performers: Performer[]; sources: Source[]; items: Item[] };
type DiscoveryMatch = { pluginId: string; pluginName: string; candidate: { externalId: string; name: string; aliases?: string[]; imageUrl?: string; profileUrls?: string[]; metadata?: Record<string, unknown> } };
type DiscoveryResult = { key: string; name: string; aliases: string[]; imageUrl?: string; profileUrls: string[]; matches: DiscoveryMatch[] };
type DiscoveryProvider = { pluginId: string; pluginName: string; ok: boolean; resultCount: number; durationMs: number; error?: string };

const nav = [
  ["dashboard", "Home", LayoutDashboard], ["library", "Performers", Users],
  ["activity", "Activity", Activity], ["logs", "Logs", Terminal], ["plugins", "Plugins", Plug], ["settings", "Settings", Settings],
] as const;

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"]; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function timeAgo(value?: string) {
  if (!value) return "Never"; const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`;
}

function pluginSupportsUrl(plugin: Plugin, profileUrl: string): boolean {
  const patterns = plugin.manifest.sourceUrlPatterns;
  if (!patterns?.length) return true;
  return patterns.some((pattern) => {
    const expression = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${expression}$`, "i").test(profileUrl);
  });
}

function preferredScrapers(plugins: Plugin[], profileUrl: string): Plugin[] {
  const matching = plugins.filter((plugin) => plugin.manifest.capabilities.includes("media-listing") && pluginSupportsUrl(plugin, profileUrl));
  const specialized = matching.filter((plugin) => !plugin.manifest.fallback);
  return (specialized.length ? specialized : matching).filter((plugin) => plugin.installed && plugin.enabled);
}

function PluginLogo({ plugin }: { plugin: Plugin }) {
  const favicon = pluginFaviconUrl(plugin.manifest); const [failed, setFailed] = useState(false);
  return <span className="plugin-logo">{favicon && !failed ? <img alt="" src={favicon} onError={() => setFailed(true)}/> : plugin.manifest.name.slice(0, 2).toUpperCase()}</span>;
}

const scheduleChoices = [5, 10, 30, 60, 300, 900, 1800, 3600, 21600, 43200, 86400, 604800];
function intervalLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) { const minutes = seconds / 60; return `${minutes} minute${minutes === 1 ? "" : "s"}`; }
  if (seconds < 86400) { const hours = seconds / 3600; return `${hours} hour${hours === 1 ? "" : "s"}`; }
  const days = seconds / 86400; return `${days} day${days === 1 ? "" : "s"}`;
}

function App() {
  const [page, setPage] = useState<PageKey>(() => pageFromPath(window.location.pathname));
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [repositories, setRepositories] = useState<PluginRepository[]>([]);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const navigate = useCallback((nextPage: PageKey, replace = false) => {
    const nextPath = pagePath(nextPage);
    if (window.location.pathname !== nextPath) window.history[replace ? "replaceState" : "pushState"]({}, "", nextPath);
    setPage(nextPage);
  }, []);

  const refresh = async () => {
    const [nextDashboard, nextPlugins, nextSettings, nextRepositories] = await Promise.all([
      api<Dashboard>("/api/dashboard"), api<Plugin[]>("/api/plugins"), api<Record<string, any>>("/api/settings"), api<PluginRepository[]>("/api/plugin-repositories"),
    ]);
    setDashboard(nextDashboard); setPlugins(nextPlugins); setSettings(nextSettings); setRepositories(nextRepositories);
  };
  useEffect(() => { void refresh().catch((error) => setNotice({ kind: "error", text: error.message })); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 4500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    navigate(pageFromPath(window.location.pathname), true);
    const onPopState = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigate]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try { await operation(); await refresh(); setNotice({ kind: "ok", text: success }); }
    catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };

  const manualRefresh = async () => {
    setRefreshing(true);
    try { const result = await api<{ indexed: number }>("/api/scan", { method: "POST" }); await refresh(); setNotice({ kind: "ok", text: `Library refreshed — ${result.indexed} media files indexed.` }); }
    catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setRefreshing(false); }
  };

  const refreshAllPerformers = async () => {
    try {
      const result = await api<{ refreshed: number }>("/api/performers/refresh", { method: "POST" });
      await refresh();
      setNotice({ kind: "ok", text: `${result.refreshed} performer${result.refreshed === 1 ? "" : "s"} refreshed.` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const openPerformerDiscovery = () => {
    const target = "/performers?discover=1";
    if (`${window.location.pathname}${window.location.search}` !== target) window.history.pushState({}, "", target);
    setPage("library");
    window.dispatchEvent(new Event("easyx:refresh-performers"));
  };

  if (!dashboard) return <div className="boot"><div className="logo-mark">EX</div><LoaderCircle className="spin"/><span>Starting Open EasyX…</span></div>;
  if (!settings.legalAccepted) return <Welcome onAccept={() => run(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ legalAccepted: true }) }), "Open EasyX activated")} busy={busy}/>;

  const title = nav.find(([key]) => key === page)?.[1] ?? "Home";
  document.title = `${title} · Open EasyX`;
  return <AppChrome title={title} scanningLibrary={refreshing} onScanLibrary={() => void manualRefresh()} onRefreshPerformers={() => void refreshAllPerformers()}>
    <div className="content">
        {page === "dashboard" && <Overview dashboard={dashboard} plugins={plugins} go={navigate} discover={openPerformerDiscovery}/>}
        {page === "library" && <Library dashboard={dashboard} plugins={plugins} run={run}/>}
        {page === "activity" && <ActivityPage performers={dashboard.performers} sources={dashboard.sources} run={run}/>}
        {page === "logs" && <LogsPage/>}
        {page === "plugins" && <PluginsPage plugins={plugins} repositories={repositories} run={run}/>}
        {page === "settings" && <SettingsPage settings={settings} run={run} setNotice={(text) => setNotice({ kind: "ok", text })}/>}
    </div>
    {notice && <div className={`toast ${notice.kind}`}><span>{notice.kind === "ok" ? <Check size={17}/> : <CircleAlert size={17}/>}</span>{notice.text}<button onClick={() => setNotice(null)}><X size={15}/></button></div>}
  </AppChrome>;
}

function Welcome({ onAccept, busy }: { onAccept: () => void; busy: boolean }) {
  const [rights, setRights] = useState(false); const [adult, setAdult] = useState(false);
  return <div className="welcome"><div className="welcome-card">
    <div className="logo-mark big">OX</div><p className="eyebrow">WELCOME TO OPEN EASYX</p><h1>Download, organize, and watch.<br/><em>One private home.</em></h1>
    <p className="lede">Open EasyX unifies acquisition, media playback, live cams, and local features in one self-hosted application.</p>
    <div className="principles"><div><Plug/><span><strong>Plugin-first</strong><small>Add only the sources you trust.</small></span></div><div><HardDrive/><span><strong>Self-hosted</strong><small>Files and metadata stay with you.</small></span></div><div><ShieldCheck/><span><strong>Responsible use</strong><small>Built around explicit ownership.</small></span></div></div>
    <div className="agreement"><label><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)}/><span>I confirm that I am an adult in my jurisdiction.</span></label><label><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)}/><span>I will only download content I am legally allowed to access and retain.</span></label></div>
    <button className="primary wide" disabled={!adult || !rights || busy} onClick={onAccept}>{busy ? <LoaderCircle className="spin"/> : <ChevronRight/>}Open my private suite</button>
    <small className="fineprint">Plugins execute trusted server-side code. Review their source and permissions before installation.</small>
  </div></div>;
}

function Overview({ dashboard, plugins, go, discover }: { dashboard: Dashboard; plugins: Plugin[]; go: (page: PageKey) => void; discover: () => void }) {
  const cards = [["Performers", dashboard.stats.performers, Users, "people"], ["Sources", dashboard.stats.sources, Database, "connected"], ["Downloaded", dashboard.stats.completed, CloudDownload, formatBytes(dashboard.stats.bytes)], ["Queue", dashboard.stats.queued, Activity, `${dashboard.stats.available} available`]] as const;
  const installed = plugins.filter((plugin) => plugin.installed).length;
  const active = plugins.filter((plugin) => plugin.installed && plugin.enabled).length;
  return <>
    <section className="hero"><div><span className="pill"><Sparkles size={14}/>PLUGIN-FIRST AUTOMATION</span><h2>Build the media library<br/>you actually want.</h2><p>Discover a person once. Let your chosen plugins find, organize, and keep their content up to date.</p><button className="primary" onClick={discover}><Search size={17}/>Start discovering</button></div><div className="hero-orbit"><div className="orbit orbit-one"></div><div className="orbit orbit-two"></div><div className="core"><Download/><span>CORE</span></div><span className="satellite s1"><Plug/></span><span className="satellite s2"><Database/></span><span className="satellite s3"><FolderOpen/></span></div></section>
    <section className="stat-grid">{cards.map(([label, value, Icon, suffix]) => <div className="stat" key={label}><span className="stat-icon"><Icon/></span><div><small>{label}</small><strong>{value}</strong><p>{suffix}</p></div></div>)}</section>
    <div className="split"><section className="panel"><div className="panel-head"><div><p>RECENT ACTIVITY</p><h3>Download pipeline</h3></div><button className="text-button" onClick={() => go("activity")}>View all <ChevronRight size={15}/></button></div>{dashboard.items.length ? <ItemList items={dashboard.items.slice(0, 5)} performers={dashboard.performers}/> : <Empty icon={Download} title="Nothing in the pipeline yet" text="Discover a performer, add a source, and new items will appear here." action="Discover now" onAction={discover}/>}</section>
      <section className="panel compact"><div className="panel-head"><div><p>EXTENSIONS</p><h3>Plugin health</h3></div><span className="status-dot">{active}/{installed} active</span></div><div className="plugin-summary"><div className="plugin-health-counts"><div><strong>{installed}</strong><span>Installed</span></div><i/><div><strong>{active}</strong><span>Active</span></div></div><div className="bar"><i style={{ width: `${installed ? active / installed * 100 : 0}%` }}/></div><button className="secondary wide" onClick={() => go("plugins")}><PackagePlus size={17}/>Manage plugins</button></div></section></div>
  </>;
}

function Discover({ plugins, run }: { plugins: Plugin[]; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const [query, setQuery] = useState(""); const [searching, setSearching] = useState(false); const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [statuses, setStatuses] = useState<DiscoveryProvider[]>([]); const [searchError, setSearchError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const providers = plugins.filter((p) => p.enabled && p.manifest.capabilities.includes("identity-search"));
  const search = useCallback(async () => {
    const performerName = query.trim();
    if (performerName.length < 2) { inputRef.current?.focus(); return; }
    setSearching(true); setSearchError("");
    try {
      const data = await api<{ results: DiscoveryResult[]; providers: DiscoveryProvider[] }>(`/api/discover?q=${encodeURIComponent(performerName)}`);
      setResults(data.results); setStatuses(data.providers);
    } catch (error) { setSearchError(error instanceof Error ? error.message : String(error)); }
    finally { setSearching(false); }
  }, [query]);
  useEffect(() => {
    const refreshPerformers = () => void search();
    window.addEventListener("easyx:refresh-performers", refreshPerformers);
    return () => window.removeEventListener("easyx:refresh-performers", refreshPerformers);
  }, [search]);
  return <div className="discover-page"><section className="search-stage"><p>UNIFIED DISCOVERY</p><h2>Who are you looking for?</h2><span>Enabled plugins search their own indexes and return identities for you to review.</span><form onSubmit={(event) => { event.preventDefault(); void search(); }}><Search/><input ref={inputRef} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Enter a performer name…"/><button className="primary" disabled={searching || query.trim().length < 2}>{searching ? <LoaderCircle className="spin"/> : "Search"}</button></form><div className="providers">Searching with {providers.length ? providers.map((p) => <b key={p.manifest.id}>{p.manifest.name}</b>) : <b>no providers</b>}</div></section>
    {!providers.length && <div className="callout"><Plug/><div><strong>No discovery plugin is enabled</strong><p>Install and configure a plugin with identity search support first. The core never searches websites by itself.</p></div></div>}
    {searchError && <div className="callout error-callout"><CircleAlert/><div><strong>Discovery failed</strong><p>{searchError}</p></div></div>}
    {statuses.length > 0 && <div className="provider-report">{statuses.map((status) => <span className={status.ok ? "ok" : "failed"} key={status.pluginId} title={status.error}><i/>{status.pluginName}<small>{status.ok ? `${status.resultCount} found · ${status.durationMs} ms` : "unavailable"}</small></span>)}</div>}
    {statuses.some((status) => !status.ok) && <div className="callout provider-warning"><CircleAlert/><div><strong>Some providers could not be searched</strong><p>{statuses.filter((status) => !status.ok).map((status) => `${status.pluginName}: ${status.error}`).join(" · ")}</p></div></div>}
    <section className="results">{statuses.length > 0 && <div className="section-label"><span>{results.length} grouped result{results.length === 1 ? "" : "s"}</span><i/></div>}{results.map((result) => <article className="person-result" key={result.key}><div className="avatar"><PerformerImage src={result.imageUrl} alt={result.name}/></div><div className="person-copy"><h3>{result.name}</h3><p>{result.aliases.length ? `Also known as ${result.aliases.slice(0, 3).join(", ")}` : "No aliases listed"}</p><div>{result.matches.map((match) => <span className="source-chip" key={`${match.pluginId}:${match.candidate.externalId}`}><Database size={13}/>{match.pluginName}</span>)}{result.profileUrls.slice(0, 3).map((url) => <span className="url-chip" key={url}>{new URL(url).hostname.replace(/^www\./, "")}</span>)}</div></div><button className="secondary" onClick={() => void run(() => api("/api/performers/import", { method: "POST", body: JSON.stringify({ matches: result.matches.map(({ pluginId, candidate }) => ({ pluginId, candidate })) }) }), `${result.name} added with ${result.matches.length} provider${result.matches.length === 1 ? "" : "s"}`)}><PackagePlus size={17}/>Add</button></article>)}</section>
  </div>;
}

function Library({ dashboard, plugins, run }: { dashboard: Dashboard; plugins: Plugin[]; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const [filter, setFilter] = useState(""); const [selectedId, setSelectedId] = useState<string | null>(null); const [adding, setAdding] = useState(false);
  const [discovering, setDiscovering] = useState(() => new URLSearchParams(window.location.search).get("discover") === "1");
  const needle = filter.trim().toLowerCase();
  const people = dashboard.performers.filter((person) => [person.name, ...person.aliases].some((value) => value.toLowerCase().includes(needle)));
  const selected = dashboard.performers.find((person) => person.id === selectedId);
  useEffect(() => {
    const openDiscovery = () => setDiscovering(true);
    const syncDiscoveryWithLocation = () => setDiscovering(new URLSearchParams(window.location.search).get("discover") === "1");
    window.addEventListener("easyx:refresh-performers", openDiscovery);
    window.addEventListener("popstate", syncDiscoveryWithLocation);
    return () => {
      window.removeEventListener("easyx:refresh-performers", openDiscovery);
      window.removeEventListener("popstate", syncDiscoveryWithLocation);
    };
  }, []);
  const closeDiscovery = () => {
    setDiscovering(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("discover");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  useEffect(() => {
    if (!discovering) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeDiscovery(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [discovering]);
  return <>
    <div className="performer-intro"><div><p>PERFORMER DIRECTORY</p><h2>People and profiles</h2><span>Manage identities, images, URLs, plugin ownership, and local media from one place.</span></div><div className="performer-intro-actions"><button className="primary" onClick={() => setDiscovering(true)}><Search size={16}/>Find a performer</button><button className="secondary" onClick={() => setAdding(true)}><Plus size={16}/>Add manually</button></div></div>
    <div className="performer-toolbar"><div className="mini-search"><Search/><input aria-label="Search performers" placeholder="Search names or aliases…" value={filter} onChange={(event) => setFilter(event.target.value)}/></div><span><strong>{people.length}</strong> performer{people.length === 1 ? "" : "s"}</span></div>
    {people.length ? <div className="people-grid">{people.map((person) => {
      const sources = dashboard.sources.filter((source) => source.performerId === person.id); const items = dashboard.items.filter((item) => item.performerId === person.id);
      return <article className="person-card" key={person.id}><button className="cover cover-button" onClick={() => setSelectedId(person.id)} aria-label={`Manage ${person.name}`}><PerformerImage src={person.imageUrl} alt={person.name}/><span className="file-count">{items.filter((item) => item.status === "completed").length} files</span></button><div className="person-card-copy"><div className="person-card-title"><div><h3>{person.name}</h3><p>{person.aliases.slice(0, 3).join(" · ") || "No aliases"}</p></div><span>{sources.length} URL{sources.length === 1 ? "" : "s"}</span></div><div className="source-row">{sources.slice(0, 3).map((source) => <span key={source.id}>{source.domain}</span>)}{sources.length > 3 && <span>+{sources.length - 3}</span>}</div><button className="secondary wide" onClick={() => setSelectedId(person.id)}><Settings size={15}/>Manage performer</button></div></article>;
    })}</div> : <Empty icon={Users} title={needle ? "No performers match" : "Your performer directory is empty"} text={needle ? "Try another name or alias." : "Add someone manually or use Find a performer to import someone from an enabled plugin."}/>}
    {discovering && <div className="modal-backdrop performer-discovery-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeDiscovery()}><div className="modal performer-discovery-modal" role="dialog" aria-modal="true" aria-label="Find a performer"><div className="modal-head performer-discovery-head"><div><p>PERFORMER SEARCH</p><h2>Find a performer</h2></div><button className="icon-button" aria-label="Close performer search" onClick={closeDiscovery}><X/></button></div><Discover plugins={plugins} run={run}/></div></div>}
    {adding && <PerformerForm close={() => setAdding(false)} run={run}/>}
    {selected && <PerformerManager performer={selected} sources={dashboard.sources.filter((source) => source.performerId === selected.id)} items={dashboard.items.filter((item) => item.performerId === selected.id)} plugins={plugins} close={() => setSelectedId(null)} run={run}/>}
  </>;
}

function PerformerImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img src={src} alt={alt} referrerPolicy="no-referrer" onError={() => setFailed(true)}/> : <span className="image-fallback"><UserRound/><small>No image</small></span>;
}

function splitAliases(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((alias) => alias.trim()).filter(Boolean))];
}

async function loadLocalPerformerImages(performerName: string): Promise<LocalPerformerImage[]> {
  const params = new URLSearchParams({ performer: performerName, kind: "image", sort: "recent", pageSize: "100" });
  const first = await api<{ items: LocalPerformerImage[]; pages: number }>(`/api/library?${params}`);
  const images = [...first.items];
  for (let page = 2; page <= first.pages; page++) {
    params.set("page", String(page));
    images.push(...(await api<{ items: LocalPerformerImage[] }>(`/api/library?${params}`)).items);
  }
  return images;
}

function PerformerForm({ performer, close, run }: { performer?: Performer; close: () => void; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const [name, setName] = useState(performer?.name ?? ""); const [aliases, setAliases] = useState(performer?.aliases.join(", ") ?? ""); const [imageUrl, setImageUrl] = useState(performer?.imageUrl ?? "");
  const [pickerOpen, setPickerOpen] = useState(false); const [localImages, setLocalImages] = useState<LocalPerformerImage[]>([]);
  const [imagesLoaded, setImagesLoaded] = useState(false); const [imagesLoading, setImagesLoading] = useState(false); const [imagesError, setImagesError] = useState("");
  const selectedImageId = /^\/api\/media\/([a-f0-9]{24})\/thumbnail$/.exec(imageUrl)?.[1];
  const openImagePicker = async () => {
    setPickerOpen(true); setImagesError("");
    if (imagesLoaded || !performer) return;
    setImagesLoading(true);
    try { setLocalImages(await loadLocalPerformerImages(performer.name)); setImagesLoaded(true); }
    catch (error) { setImagesError(error instanceof Error ? error.message : String(error)); }
    finally { setImagesLoading(false); }
  };
  const save = () => void run(async () => {
    const result = await api(performer ? `/api/performers/${performer.id}` : "/api/performers", { method: performer ? "PATCH" : "POST", body: JSON.stringify({ name, aliases: splitAliases(aliases), imageUrl: imageUrl.trim() || null }) });
    close(); return result;
  }, performer ? `${name} updated` : `${name} created and media folder prepared`);
  return <><div className="modal-backdrop elevated" onMouseDown={(event) => event.target === event.currentTarget && close()}><div className="modal performer-form-modal"><div className="modal-head"><div><p>{performer ? "EDIT PERFORMER" : "NEW PERFORMER"}</p><h2>{performer ? performer.name : "Add someone manually"}</h2></div><button className="icon-button" aria-label="Close" onClick={close}><X/></button></div><div className="form-stack"><label><span>Name *</span><input autoFocus type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Performer name"/></label><label><span>Aliases</span><input type="text" value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="Separate aliases with commas"/></label>{performer ? <div className="performer-image-field"><span>Profile image</span><button className="performer-image-selector" type="button" onClick={() => void openImagePicker()}><span className="performer-image-preview"><PerformerImage src={imageUrl} alt={performer.name}/></span><span><b>Choose from local images</b><small>Click to browse every downloaded image for this performer.</small></span><ChevronRight/></button></div> : <label><span>Image URL</span><input type="text" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="https://…/portrait.jpg"/><small>Images are loaded with the referrer hidden; invalid or unavailable images use a safe placeholder.</small></label>}<div className="folder-preview"><FolderOpen/><span><b>Media folder</b><code>/media/{name.trim() || "Performer name"}</code></span></div></div><div className="modal-actions"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={save}><Check size={16}/>{performer ? "Save changes" : "Create performer"}</button></div></div></div>
    {pickerOpen && performer && <div className="modal-backdrop performer-image-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPickerOpen(false)}><div className="modal performer-image-picker" role="dialog" aria-modal="true" aria-label={`Choose image for ${performer.name}`}><div className="modal-head"><div><p>LOCAL IMAGES</p><h2>Choose a profile image</h2><span>{performer.name}</span></div><button className="icon-button" aria-label="Close image picker" onClick={() => setPickerOpen(false)}><X/></button></div>{imagesLoading ? <div className="performer-image-picker-state"><LoaderCircle className="spin"/><span>Loading local images…</span></div> : imagesError ? <div className="performer-image-picker-state error"><CircleAlert/><span>{imagesError}</span><button className="secondary" onClick={() => { setImagesLoaded(false); void openImagePicker(); }}>Try again</button></div> : localImages.length ? <div className="performer-image-grid">{localImages.map((image) => <button className={selectedImageId === image.id ? "selected" : ""} key={image.id} type="button" aria-label={`Use ${image.title} as profile image`} onClick={() => { setImageUrl(`/api/media/${image.id}/thumbnail`); setPickerOpen(false); }}><PerformerImage src={image.thumbnailUrl} alt={image.title}/><span><b>{image.title}</b><small>{image.source || "Local media"}</small></span>{selectedImageId === image.id && <i><Check/></i>}</button>)}</div> : <div className="performer-image-picker-state"><UserRound/><strong>No local images yet</strong><span>Download or add images for this performer, then scan the library.</span></div>}</div></div>}
  </>;
}

function PerformerManager({ performer, sources, items, plugins, close, run }: { performer: Performer; sources: Source[]; items: Item[]; plugins: Plugin[]; close: () => void; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const [mode, setMode] = useState<"details" | "edit" | "add-url" | "delete">("details");
  const [detail, setDetail] = useState<{ sources: Source[]; items: Item[] } | null>(null);
  useEffect(() => { void api<{ sources: Source[]; items: Item[] }>(`/api/performers/${performer.id}`).then(setDetail).catch(() => setDetail(null)); }, [performer.id, sources, items]);
  const managedSources = detail?.sources ?? sources; const managedItems = detail?.items ?? items;
  const scraperPlugins = plugins.filter((plugin) => plugin.installed && plugin.enabled && plugin.manifest.capabilities.includes("media-listing"));
  const pluginName = (pluginId: string) => pluginId === "org.easyx.manual" ? "Manual" : plugins.find((plugin) => plugin.manifest.id === pluginId)?.manifest.name ?? pluginId;
  if (mode === "edit") return <PerformerForm performer={performer} close={() => setMode("details")} run={run}/>;
  if (mode === "add-url") return <SourceForm performer={performer} plugins={plugins} close={() => setMode("details")} run={run}/>;
  if (mode === "delete") return <DeletePerformer performer={performer} fileCount={managedItems.filter((item) => item.storagePath).length} close={() => setMode("details")} deleted={close} run={run}/>;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><div className="modal performer-manager"><div className="modal-head"><div><p>PERFORMER</p><h2>Manage profile</h2></div><button className="icon-button" aria-label="Close" onClick={close}><X/></button></div>
    <section className="performer-profile-head"><div className="performer-portrait"><PerformerImage src={performer.imageUrl} alt={performer.name}/></div><div><h3>{performer.name}</h3><p>{performer.aliases.join(" · ") || "No aliases"}</p><div className="profile-actions"><button className="secondary" onClick={() => setMode("edit")}><Pencil size={14}/>Edit details</button></div></div></section>
    <section className="performer-stats"><div><strong>{managedSources.length}</strong><span>Profile URLs</span></div><div><strong>{Object.keys(performer.externalRefs).length}</strong><span>Connected plugins</span></div><div><strong>{managedItems.filter((item) => item.status === "completed").length}</strong><span>Downloaded files</span></div></section>
    <section className="manager-section"><div className="manager-section-head"><div><p>CONNECTED IDENTITIES</p><h3>Provider references</h3></div></div>{Object.entries(performer.externalRefs).length ? <div className="identity-list">{Object.entries(performer.externalRefs).map(([pluginId, externalId]) => <div key={pluginId}><span className="plugin-logo small">{pluginName(pluginId).slice(0, 2).toUpperCase()}</span><div><strong>{pluginName(pluginId)}</strong><code>{externalId}</code></div><span className="badge completed">Connected</span></div>)}</div> : <p className="manager-empty">This performer was added manually and has no provider identity yet.</p>}</section>
    <section className="manager-section"><div className="manager-section-head"><div><p>PROFILE URLS</p><h3>Sources and scraper selection</h3></div><button className="secondary" onClick={() => setMode("add-url")}><Plus size={14}/>Add URL</button></div>{!scraperPlugins.length && <div className="scraper-notice"><Plug size={16}/><span><strong>No scraper plugin is active</strong><small>URLs stay as references until you install a plugin with media-listing support.</small></span></div>}{managedSources.length ? <div className="profile-url-list">{managedSources.map((source) => {
      const compatibleScrapers = preferredScrapers(plugins, source.profileUrl);
      const scraper = compatibleScrapers.find((candidate) => candidate.manifest.id === source.scraperPluginId);
      const minimum = scraper?.manifest.polling?.minimumIntervalSeconds ?? 300;
      const intervals = [...new Set([...scheduleChoices, source.syncIntervalSeconds])].filter((seconds) => seconds >= minimum).sort((a, b) => a - b);
      return <div className="profile-url-row" key={source.id}><span className="source-favicon">{source.domain.slice(0, 2).toUpperCase()}</span><div className="profile-url-copy"><a href={source.profileUrl} target="_blank" rel="noreferrer">{source.label}<ExternalLink size={11}/></a><code title={source.profileUrl}>{source.profileUrl}</code><small>Found by {pluginName(source.pluginId)} · {compatibleScrapers.length} compatible scraper{compatibleScrapers.length === 1 ? "" : "s"} · never assigned automatically</small></div><div className="source-scraper-controls"><label><span>Scraper plugin</span><select aria-label={`Scraper for ${source.domain}`} value={source.scraperPluginId ?? ""} onChange={(event) => void run(() => api(`/api/sources/${source.id}`, { method: "PATCH", body: JSON.stringify({ scraperPluginId: event.target.value || null }) }), event.target.value ? `${source.domain} assigned to ${pluginName(event.target.value)}` : `${source.domain} scraper removed`)}><option value="">Reference only</option>{compatibleScrapers.map((candidate) => <option key={candidate.manifest.id} value={candidate.manifest.id}>{candidate.manifest.name}</option>)}</select></label>{scraper && <label><span>Check every</span><select aria-label={`Schedule for ${source.domain}`} value={source.syncIntervalSeconds} onChange={(event) => void run(() => api(`/api/sources/${source.id}`, { method: "PATCH", body: JSON.stringify({ syncIntervalSeconds: Number(event.target.value) }) }), `${source.domain} schedule updated`)}>{intervals.map((seconds) => <option key={seconds} value={seconds}>{intervalLabel(seconds)}</option>)}</select></label>}</div><button className={`scrape-toggle ${source.scrapeEnabled ? "active" : ""}`} disabled={!scraper} onClick={() => void run(() => api(`/api/sources/${source.id}`, { method: "PATCH", body: JSON.stringify({ scrapeEnabled: !source.scrapeEnabled }) }), `${source.domain} automatic scraping ${source.scrapeEnabled ? "disabled" : "enabled"}`)}><Check size={13}/>{source.scrapeEnabled ? "Auto scrape" : "Enable auto"}</button>{scraper ? <button className={source.autoDownload ? "badge queued" : "badge neutral"} onClick={() => void run(() => api(`/api/sources/${source.id}`, { method: "PATCH", body: JSON.stringify({ autoDownload: !source.autoDownload }) }), `Auto-download ${source.autoDownload ? "disabled" : "enabled"}`)}>{source.autoDownload ? "Download auto" : "Review first"}</button> : <span className="badge neutral">Reference</span>}{scraper && <button className="icon-button" title={`Scrape ${source.domain} now`} aria-label={`Scrape ${source.domain} now`} onClick={() => void run(() => api(`/api/sources/${source.id}/sync`, { method: "POST" }), `${source.domain} scraped`)}><RefreshCw size={14}/></button>}<button className="icon-button destructive-icon" title={`Remove ${source.domain}`} onClick={() => void run(() => api(`/api/sources/${source.id}`, { method: "DELETE" }), `${source.domain} removed`)}><Trash2 size={14}/></button></div>;
    })}</div> : <p className="manager-empty">No URLs yet. Add a profile, choose a compatible scraper, then enable its automatic schedule.</p>}</section>
    <div className="performer-danger"><div><strong>Delete performer</strong><span>Choose whether associated media should remain on disk.</span></div><button className="danger-soft" onClick={() => setMode("delete")}><Trash2 size={15}/>Delete…</button></div>
  </div></div>;
}

function SourceForm({ performer, plugins, close, run }: { performer: Performer; plugins: Plugin[]; close: () => void; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const [profileUrl, setProfileUrl] = useState(""); const [label, setLabel] = useState(""); const [scraperPluginId, setScraperPluginId] = useState(""); const [scrapeEnabled, setScrapeEnabled] = useState(false);
  const compatiblePlugins = /^https?:\/\//i.test(profileUrl) ? preferredScrapers(plugins, profileUrl) : [];
  useEffect(() => { if (scraperPluginId && !compatiblePlugins.some((plugin) => plugin.manifest.id === scraperPluginId)) { setScraperPluginId(""); setScrapeEnabled(false); } }, [profileUrl]);
  const save = () => void run(async () => { const result = await api(`/api/performers/${performer.id}/sources`, { method: "POST", body: JSON.stringify({ profileUrl, label: label.trim() || undefined, scraperPluginId: scraperPluginId || undefined, scrapeEnabled: scraperPluginId ? scrapeEnabled : false }) }); close(); return result; }, "Profile URL added");
  return <div className="modal-backdrop elevated" onMouseDown={(event) => event.target === event.currentTarget && close()}><div className="modal"><div className="modal-head"><div><p>NEW PROFILE URL</p><h2>Connect a source</h2></div><button className="icon-button" aria-label="Close" onClick={close}><X/></button></div><div className="form-stack"><label><span>URL *</span><input autoFocus type="text" value={profileUrl} onChange={(event) => setProfileUrl(event.target.value)} placeholder="https://example.com/profile"/></label><label><span>Label</span><input type="text" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Optional display name"/></label><label><span>Compatible scraper</span><select value={scraperPluginId} onChange={(event) => { setScraperPluginId(event.target.value); if (!event.target.value) setScrapeEnabled(false); }}><option value="">Reference only — no scraper</option>{compatiblePlugins.map((plugin) => <option key={plugin.manifest.id} value={plugin.manifest.id}>{plugin.manifest.name}</option>)}</select><small>{/^https?:\/\//i.test(profileUrl) ? `${compatiblePlugins.length} active plugin${compatiblePlugins.length === 1 ? "" : "s"} can scrape this URL. Reference only remains the default and nothing is assigned globally.` : "Enter the URL to see only plugins that support it."}</small></label><label className="toggle-row"><span><b>Enable automatic scraping</b><small>Off by default. You must select this URL's plugin first, and you can still use Scrape now without automation.</small></span><input type="checkbox" disabled={!scraperPluginId} checked={scrapeEnabled} onChange={(event) => setScrapeEnabled(event.target.checked)}/></label>{!plugins.length && <div className="scraper-notice"><Plug size={16}/><span><strong>No scraper plugin is active</strong><small>You can still save this URL as a reference.</small></span></div>}</div><div className="modal-actions"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={!/^https?:\/\//i.test(profileUrl)} onClick={save}><Link2 size={16}/>Add URL</button></div></div></div>;
}

function DeletePerformer({ performer, fileCount, close, deleted, run }: { performer: Performer; fileCount: number; close: () => void; deleted: () => void; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const remove = (deleteFiles: boolean) => void run(async () => { const result = await api(`/api/performers/${performer.id}`, { method: "DELETE", body: JSON.stringify({ deleteFiles }) }); deleted(); return result; }, deleteFiles ? `${performer.name} and associated files deleted` : `${performer.name} deleted; media files kept`);
  return <div className="modal-backdrop elevated"><div className="modal delete-modal"><span className="delete-icon"><Trash2/></span><h2>Delete {performer.name}?</h2><p>Choose exactly what EasyX should remove. Plugin URLs, provider references, and download history are removed with the local performer record in both cases.</p><div className="delete-choices"><button className="secondary" onClick={() => remove(false)}><Database/><span><strong>Delete performer only</strong><small>Keep every media file and folder on disk.</small></span></button><button className="danger-choice" onClick={() => remove(true)}><Trash2/><span><strong>Delete performer and files</strong><small>Permanently remove the performer folder and {fileCount} tracked file{fileCount === 1 ? "" : "s"}.</small></span></button></div><button className="text-button wide" onClick={close}>Cancel</button></div></div>;
}

function ActivityPage({ performers, sources, run }: { performers: Performer[]; sources: Source[]; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [category, setCategory] = useState("all"); const [status, setStatus] = useState(""); const [mediaType, setMediaType] = useState("");
  const [performerId, setPerformerId] = useState(""); const [sourceDomain, setSourceDomain] = useState(""); const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get("search") ?? "");
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(50); const [clock, setClock] = useState(Date.now());
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(""); const requestId = useRef(0);
  const loadActivity = useCallback(async () => {
    const currentRequest = ++requestId.current; const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (category !== "all") params.set("category", category); if (status) params.set("status", status); if (mediaType) params.set("mediaType", mediaType);
    if (performerId) params.set("performerId", performerId); if (sourceDomain) params.set("sourceDomain", sourceDomain); if (search.trim()) params.set("search", search.trim());
    try { const result = await api<ActivityData>(`/api/items?${params}`); if (currentRequest === requestId.current) { setData(result); setPage(result.page); setLoadError(""); } }
    catch (error) { if (currentRequest === requestId.current) setLoadError(error instanceof Error ? error.message : String(error)); }
    finally { if (currentRequest === requestId.current) setLoading(false); }
  }, [category, status, mediaType, performerId, sourceDomain, search, page, pageSize]);
  useEffect(() => { setLoading(true); void loadActivity(); const timer = window.setInterval(() => void loadActivity(), 1_500); return () => window.clearInterval(timer); }, [loadActivity]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const changeFilter = (setter: (value: string) => void, value: string) => { setter(value); setPage(1); };
  const counts = data?.statusCounts ?? {}; const totalTracked = Object.values(counts).reduce((sum, count) => sum + count, 0); const failedCount = counts.failed ?? 0;
  const categories = [
    ["all", "All", totalTracked], ["active", "Active", (counts.queued ?? 0) + (counts.downloading ?? 0) + (counts.paused ?? 0) + (counts.stopping ?? 0) + (counts.cancelling ?? 0)], ["ready", "Ready", counts.available ?? 0],
    ["downloaded", "Downloaded", counts.completed ?? 0], ["errors", "Errors", failedCount], ["other", "Other", (counts.cancelled ?? 0) + (counts.duplicate ?? 0) + (counts.superseded ?? 0) + (counts.deleted ?? 0)],
  ] as const;
  const sourceDomains = useMemo(() => activitySourceDomains(sources), [sources]);
  const resetFilters = () => { setCategory("all"); setStatus(""); setMediaType(""); setPerformerId(""); setSourceDomain(""); setSearch(""); setPage(1); };
  const retryAll = async () => { await run(() => api("/api/items/retry-failed", { method: "POST" }), `${failedCount} failed download${failedCount === 1 ? "" : "s"} queued again`); setPage(1); await loadActivity(); };
  const itemAction = async (item: Item, action: "pause" | "resume" | "stop" | "cancel" | "delete") => {
    if (action === "delete" && !confirmItemDeletion(item.status, (message) => window.confirm(message))) return;
    const effectiveAction = action === "resume" && ["available", "failed"].includes(item.status) ? "queue" : action;
    const method = effectiveAction === "delete" ? "DELETE" : "POST";
    const messages = { queue: item.status === "failed" ? "Download queued again" : "Download queued", pause: "Recording paused", resume: "Recording resumed", stop: "Recording is stopping and will be saved", cancel: "Recording cancelled", delete: item.status === "completed" ? "Recording and media file deleted" : "Activity item deleted" };
    await run(() => api(`/api/items/${item.id}${effectiveAction === "delete" ? "" : `/${effectiveAction}`}`, { method }), messages[effectiveAction]);
    await loadActivity();
  };
  return <section className="panel activity-panel">
    <div className="panel-head activity-heading"><div><p>LIVE PIPELINE</p><h3>Media items</h3></div><div><span className="status-dot">{totalTracked} tracked</span><button className="danger-soft" disabled={!failedCount} onClick={() => void retryAll()}><RefreshCw size={15}/>Retry all errors{failedCount ? ` (${failedCount})` : ""}</button></div></div>
    <div className="activity-categories" aria-label="Activity categories">{categories.map(([key, label, count]) => <button key={key} className={category === key ? "active" : ""} onClick={() => { setCategory(key); setStatus(""); setPage(1); }}><span>{label}</span><b>{count}</b></button>)}</div>
    <div className="activity-filters">
      <label className="activity-search"><Search size={15}/><input aria-label="Search activity" placeholder="Search item, performer or source…" value={search} onChange={(event) => changeFilter(setSearch, event.target.value)}/></label>
      <select aria-label="Filter by status" value={status} onChange={(event) => changeFilter(setStatus, event.target.value)}><option value="">All statuses</option>{Object.keys(counts).sort().map((value) => <option key={value} value={value}>{value} ({counts[value]})</option>)}</select>
      <select aria-label="Filter by media type" value={mediaType} onChange={(event) => changeFilter(setMediaType, event.target.value)}><option value="">All types</option>{(data?.mediaTypes ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <select aria-label="Filter by performer" value={performerId} onChange={(event) => changeFilter(setPerformerId, event.target.value)}><option value="">All performers</option>{performers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
      <select aria-label="Filter by source" value={sourceDomain} onChange={(event) => changeFilter(setSourceDomain, event.target.value)}><option value="">All sources</option>{sourceDomains.map((domain) => <option key={domain} value={domain}>{domain}</option>)}</select>
      <button className="text-button" onClick={resetFilters}>Clear filters</button>
    </div>
    {loadError && <div className="activity-load-error"><CircleAlert size={15}/>{loadError}</div>}
    {loading && !data ? <div className="activity-loading"><LoaderCircle className="spin"/>Loading activity…</div> : data?.items.length ? <>
      <div className="activity-table"><div className="table-head"><span>Item &amp; output</span><span>Source</span><span>Type</span><span>Status &amp; progress</span><span>Download time</span><span>Updated</span><span>Controls</span></div>{data.items.map((item) => { const source = sources.find((entry) => entry.id === item.sourceId); const performer = performers.find((p) => p.id === item.performerId); const percent = Math.max(0, Math.min(100, Math.round(item.progress * 100))); const downloadedBytes = Number(item.downloadedBytes ?? 0); return <div className="table-row" key={item.id}><div><strong>{item.title || item.id}</strong><small>{performer?.name}</small>{item.outputPath && <small className="output-path" title={item.outputPath}><FolderOpen size={11}/>{item.outputPath}</small>}</div><span className="activity-source"><span>{source?.label || source?.domain || "Unknown source"}</span>{source?.domain && source.label !== source.domain && <small>{source.domain}</small>}</span><span className="capitalize">{item.mediaType}</span><span className="activity-status"><span className={`badge ${item.status}`}>{item.status}</span>{["downloading", "paused", "stopping", "cancelling"].includes(item.status) && <span className="progress-wrap"><span className={`download-progress ${percent === 0 && item.status === "downloading" ? "indeterminate" : ""}`} role="progressbar" aria-label={`Download progress for ${item.title || item.id}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent || undefined}><i style={percent ? { width: `${percent}%` } : undefined}/></span><small>{item.status === "paused" ? "Paused" : percent ? downloadedBytes ? `${percent}% · ${formatBytes(downloadedBytes)}` : `Preparing · ${percent}%` : downloadedBytes ? formatBytes(downloadedBytes) : "Preparing extractor…"}</small></span>}</span><span className="download-time">{downloadTime(item, clock)}</span><span>{timeAgo(item.updatedAt)}</span><span className="activity-actions">{["available", "failed"].includes(item.status) && <button className="icon-button" title={item.status === "failed" ? "Retry download" : "Queue download"} onClick={() => void itemAction(item, "resume").catch(async () => { await run(() => api(`/api/items/${item.id}/queue`, { method: "POST" }), "Download queued"); await loadActivity(); })}><Download size={16}/></button>}{item.status === "failed" && <button className="danger-soft activity-delete-error" title="Delete error" aria-label={`Delete error for ${item.title || item.id}`} onClick={() => void itemAction(item, "delete")}><Trash2 size={14}/>Delete error</button>}{item.status === "downloading" && <button className="icon-button" title="Pause recording" onClick={() => void itemAction(item, "pause")}><Pause size={15}/></button>}{item.status === "paused" && <button className="icon-button" title="Resume recording" onClick={() => void itemAction(item, "resume")}><Play size={15}/></button>}{["downloading", "paused"].includes(item.status) && <button className="icon-button" title="Stop and save recording" onClick={() => void itemAction(item, "stop")}><Square size={14}/></button>}{["queued", "downloading", "paused"].includes(item.status) && <button className="icon-button" title="Cancel recording" onClick={() => void itemAction(item, "cancel")}><X size={15}/></button>}{["queued", "downloading", "paused", "cancelled"].includes(item.status) && <button className="icon-button danger" title="Delete item" onClick={() => void itemAction(item, "delete")}><Trash2 size={15}/></button>}{item.status === "completed" && <><a className="icon-button" title="Open in library" href={`/library?performer=${encodeURIComponent(performer?.name ?? "")}&kind=${item.mediaType === "video" ? "video" : "image"}`}><FolderOpen size={15}/></a><button className="icon-button danger" title="Delete completed recording" aria-label={`Delete completed recording ${item.title || item.id}`} onClick={() => void itemAction(item, "delete")}><Trash2 size={15}/></button></>}</span>{item.error && <p className="row-error">{item.error}</p>}</div>; })}</div>
      <div className="activity-pagination"><span>Showing <strong>{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)}</strong> of <strong>{data.total}</strong></span><label>Per page <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><div><button className="icon-button" aria-label="Previous page" disabled={data.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17}/></button><span>Page <strong>{data.page}</strong> / {data.totalPages}</span><button className="icon-button" aria-label="Next page" disabled={data.page >= data.totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17}/></button></div></div>
    </> : <Empty icon={Activity} title={totalTracked ? "No items match these filters" : "No activity yet"} text={totalTracked ? "Change or clear the filters to see more items." : "Items discovered by source plugins will appear in this pipeline."}/>}
  </section>;
}

function PluginsPage({ plugins, repositories, run }: { plugins: Plugin[]; repositories: PluginRepository[]; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const [configuring, setConfiguring] = useState<{ plugin: Plugin; installing: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [installationFilter, setInstallationFilter] = useState<"installed" | "available">("installed");
  const [categoryFilter, setCategoryFilter] = useState<"all" | "sources" | "live" | "features">("all");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const installed = plugins.filter((plugin) => plugin.installed).length;
  const active = plugins.filter((plugin) => plugin.installed && plugin.enabled).length;
  const needle = query.trim().toLowerCase();
  const pluginCategory = (plugin: Plugin) => plugin.manifest.capabilities.includes("live-cam") ? "live"
    : plugin.manifest.capabilities.some((capability) => ["identity-search", "source-discovery", "media-listing", "download-resolver"].includes(capability)) ? "sources" : "features";
  const searched = plugins.filter((plugin) => !needle || [plugin.manifest.name, plugin.manifest.description, plugin.manifest.author, ...plugin.manifest.capabilities, ...(plugin.manifest.sourceUrlPatterns ?? [])].some((value) => value.toLowerCase().includes(needle)));
  const byInstallation = searched.filter((plugin) => installationFilter === "installed" ? plugin.installed : !plugin.installed);
  const categoryOptions = [
    { key: "all", label: "All", count: byInstallation.length },
    { key: "sources", label: "Sources & discovery", count: byInstallation.filter((plugin) => pluginCategory(plugin) === "sources").length },
    { key: "live", label: "Live cam", count: byInstallation.filter((plugin) => pluginCategory(plugin) === "live").length },
    { key: "features", label: "Features & addons", count: byInstallation.filter((plugin) => pluginCategory(plugin) === "features").length },
  ] as const;
  const visible = byInstallation
    .filter((plugin) => categoryFilter === "all" || pluginCategory(plugin) === categoryFilter)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  const row = (plugin: Plugin) => {
    const needsSetup = (plugin.manifest.settings ?? []).some((field) => field.required && plugin.config[field.key] === undefined && field.default === undefined);
    const install = () => needsSetup ? setConfiguring({ plugin, installing: true }) : void run(() => api(`/api/plugins/${plugin.manifest.id}/install`, { method: "POST" }), `${plugin.manifest.name} installed and active`);
    return <article className={`plugin-row ${plugin.installed ? "is-installed" : ""}`} key={plugin.manifest.id}>
      <PluginLogo plugin={plugin}/>
      <div className="plugin-row-copy"><div className="plugin-row-title"><h3>{plugin.manifest.name}</h3>{plugin.manifest.homepage && <a href={plugin.manifest.homepage} target="_blank" rel="noreferrer" title={`${plugin.manifest.name} homepage`}><ExternalLink size={13}/></a>}<span>v{plugin.manifest.version}</span></div><p>{plugin.manifest.description}</p></div>
      <div className="plugin-row-details"><div className="capabilities">{plugin.manifest.capabilities.map((cap) => <span key={cap}>{cap.replaceAll("-", " ")}</span>)}</div>{plugin.manifest.capabilities.includes("media-listing") && <small>{plugin.manifest.sourceUrlPatterns?.length || "Any"} URL patterns · {plugin.manifest.polling ? intervalLabel(plugin.manifest.polling.defaultIntervalSeconds) : "Default schedule"}</small>}</div>
      <div className="plugin-row-status"><span className={`badge ${plugin.installed ? "completed" : "neutral"}`}>{plugin.installed ? "Active" : "Available"}</span><small>{plugin.origin === "official" ? "Official store" : "Community repo"} · by {plugin.manifest.author}</small></div>
      <div className="plugin-row-actions">{!plugin.installed ? <button className="primary" onClick={install}><PackagePlus size={15}/>{needsSetup ? "Set up" : "Install"}</button> : <button className="secondary" onClick={() => setConfiguring({ plugin, installing: false })}><Settings size={15}/>Config</button>}</div>
    </article>;
  };
  return <>
    <div className="plugin-intro"><div><p>TRUSTED EXTENSIONS</p><h2>Choose what Open EasyX<br/>can do.</h2></div><div className="plugin-page-stats"><span><strong>{installed}</strong> installed</span><i/><span><strong>{active}</strong> active</span></div></div>
    <section className="repository-store"><div className="repository-head"><div><p>PLUGIN STORES</p><h3>Repositories</h3><span>The official store is built in. Add any compatible GitHub, Gitea, Forgejo, GitLab, or generic Git repository.</span></div></div>
      <div className="repository-list">{repositories.map((repository) => <article key={repository.id}><span className={`repository-mark ${repository.official ? "official" : ""}`}><Plug/></span><div><strong>{repository.name}{repository.official && <i>Official</i>}</strong><code>{repository.url}</code><small>{repository.pluginCount} {repository.pluginCount === 1 ? "plugin" : "plugins"}</small></div><div>{!repository.official && <><button className="secondary" onClick={() => void run(() => api(`/api/plugin-repositories/${repository.id}/refresh`, { method: "POST" }), `${repository.name} updated`)}><RefreshCw size={14}/>Update</button><button className="danger-soft" onClick={() => void run(() => api(`/api/plugin-repositories/${repository.id}`, { method: "DELETE" }), `${repository.name} removed`)}><Trash2 size={14}/>Remove</button></>}</div></article>)}</div>
      <div className="repository-add"><input aria-label="Repository name" placeholder="Name (optional)" value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)}/><input aria-label="Git repository URL" placeholder="https://gitea.example/user/open-easyx-plugins.git" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)}/><button className="primary" disabled={!repositoryUrl.trim()} onClick={async () => { await run(() => api("/api/plugin-repositories", { method: "POST", body: JSON.stringify({ url: repositoryUrl, name: repositoryName }) }), "Plugin repository installed"); setRepositoryUrl(""); setRepositoryName(""); }}><Plus size={15}/>Install new repository</button></div>
    </section>
    <section className="plugin-browser">
      <div className="plugin-browser-head"><div><p>PLUGIN CATALOG</p><h3>Browse plugins</h3></div><span>{visible.length} shown</span></div>
      <div className="plugin-toolbar"><div className="plugin-search"><Search size={18}/><input aria-label="Search plugins" placeholder="Search by name, capability, or author…" value={query} onChange={(event) => setQuery(event.target.value)}/>{query && <button aria-label="Clear plugin search" onClick={() => setQuery("")}><X size={15}/></button>}</div></div>
      <nav className="plugin-menu installation-menu" aria-label="Plugin installation status">
        <button className={installationFilter === "installed" ? "active" : ""} aria-pressed={installationFilter === "installed"} onClick={() => setInstallationFilter("installed")}><span>Installed</span><b>{installed}</b></button>
        <button className={installationFilter === "available" ? "active" : ""} aria-pressed={installationFilter === "available"} onClick={() => setInstallationFilter("available")}><span>Not installed</span><b>{plugins.length - installed}</b></button>
      </nav>
      <nav className="plugin-menu category-menu" aria-label="Plugin categories">
        {categoryOptions.map((category) => <button key={category.key} className={categoryFilter === category.key ? "active" : ""} aria-pressed={categoryFilter === category.key} onClick={() => setCategoryFilter(category.key)}><span>{category.label}</span><b>{category.count}</b></button>)}
      </nav>
      {visible.length ? <div className="plugin-list plugin-browser-list">{visible.map(row)}</div> : query ? <Empty icon={Plug} title="No plugins match" text="Try another search or category." action="Clear search" onAction={() => setQuery("")}/> : <Empty icon={Plug} title={installationFilter === "installed" ? "No installed plugins here" : "No uninstalled plugins here"} text="Choose another category to continue browsing." action={categoryFilter !== "all" ? "Show all categories" : undefined} onAction={categoryFilter !== "all" ? () => setCategoryFilter("all") : undefined}/>}
    </section>
    {configuring && <PluginConfig plugin={configuring.plugin} installing={configuring.installing} close={() => setConfiguring(null)} run={run}/>} {/* Plugin configuration */}
  </>;
}

function PluginConfig({ plugin, installing, close, run }: { plugin: Plugin; installing: boolean; close: () => void; run: (op: () => Promise<unknown>, msg: string) => Promise<void> }) {
  const initial = Object.fromEntries((plugin.manifest.settings ?? []).map((field) => [field.key, plugin.config[field.key] ?? field.default ?? (field.type === "boolean" ? false : "")]));
  const [values, setValues] = useState(initial); const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null); const [testing, setTesting] = useState(false);
  const [browserSession, setBrowserSession] = useState<{ active: boolean; viewerPath?: string; expiresAt?: string } | null>(null); const [browserBusy, setBrowserBusy] = useState(false); const [browserError, setBrowserError] = useState("");
  const [manualSessionOpen, setManualSessionOpen] = useState(false);
  const [clipboardStatus, setClipboardStatus] = useState(""); const browserWindowRef = useRef<Window | null>(null);
  const save = async () => { await run(() => api(installing ? `/api/plugins/${plugin.manifest.id}/install` : `/api/plugins/${plugin.manifest.id}/config`, { method: installing ? "POST" : "PUT", body: JSON.stringify(values) }), installing ? `${plugin.manifest.name} installed and active` : "Plugin settings saved"); close(); };
  const remove = async () => { await run(() => api(`/api/plugins/${plugin.manifest.id}`, { method: "DELETE" }), `${plugin.manifest.name} uninstalled`); close(); };
  const testConnection = async () => {
    setTesting(true); setTest(null);
    try { setTest(await api<{ ok: boolean; message: string }>(`/api/plugins/${plugin.manifest.id}/test`, { method: "POST" })); }
    catch (error) { setTest({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
    finally { setTesting(false); }
  };
  const startBrowser = async () => {
    setBrowserBusy(true); setBrowserError(""); setTest(null);
    try { setBrowserSession(await api(`/api/plugins/${plugin.manifest.id}/browser-login/start`, { method: "POST" })); }
    catch (error) { setBrowserError(error instanceof Error ? error.message : String(error)); }
    finally { setBrowserBusy(false); }
  };
  const stopBrowser = async () => {
    setBrowserBusy(true);
    try { await api(`/api/plugins/${plugin.manifest.id}/browser-login`, { method: "DELETE" }); setBrowserSession(null); setBrowserError(""); }
    catch (error) { setBrowserError(error instanceof Error ? error.message : String(error)); }
    finally { setBrowserBusy(false); }
  };
  const captureBrowser = async () => {
    setBrowserBusy(true); setBrowserError(""); setTest(null);
    try {
      const result = await api<{ test: { ok: boolean; message: string } }>(`/api/plugins/${plugin.manifest.id}/browser-login/capture`, { method: "POST", body: JSON.stringify(values) });
      await run(() => Promise.resolve(result), `${plugin.manifest.name} session verified, captured, and activated`);
      setBrowserSession(null); setTest(result.test); close();
    } catch (error) { setBrowserError(error instanceof Error ? error.message : String(error)); }
    finally { setBrowserBusy(false); }
  };
  const sendClipboard = useCallback(async (text: string) => {
    if (!text) return;
    setClipboardStatus("Pasting…");
    try {
      const result = await api<{ characters: number }>(`/api/plugins/${plugin.manifest.id}/browser-login/paste`, { method: "POST", body: JSON.stringify({ text }) });
      setClipboardStatus(`Pasted ${result.characters} character${result.characters === 1 ? "" : "s"}`);
    } catch (error) { setClipboardStatus(error instanceof Error ? error.message : String(error)); }
  }, [plugin.manifest.id]);
  const handleBrowserPaste = useCallback((event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain"); if (!text) return;
    event.preventDefault(); event.stopPropagation(); void sendClipboard(text);
  }, [sendClipboard]);
  const attachClipboardBridge = (frame: HTMLIFrameElement) => {
    if (browserWindowRef.current) browserWindowRef.current.removeEventListener("paste", handleBrowserPaste, true);
    browserWindowRef.current = frame.contentWindow;
    browserWindowRef.current?.addEventListener("paste", handleBrowserPaste, true);
  };
  useEffect(() => () => browserWindowRef.current?.removeEventListener("paste", handleBrowserPaste, true), [handleBrowserPaste]);
  const pasteFromMac = async () => {
    try {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard access is unavailable here. Paste into the fallback box instead.");
      const text = await navigator.clipboard.readText();
      if (!text) throw new Error("The Mac clipboard contains no text.");
      await sendClipboard(text);
    } catch (error) { setClipboardStatus(error instanceof Error ? error.message : String(error)); }
  };
  const browserCard = (fieldKey: string) => plugin.manifest.browserAuth?.sessionSetting === fieldKey ? <div className="integrated-browser-card"><span><Globe2 size={21}/></span><div><strong>Connect in EasyX browser</strong><p>Open the official site inside EasyX, sign in normally, then let EasyX capture the active session.</p></div><button className="primary" disabled={browserBusy} onClick={() => void startBrowser()}>{browserBusy ? <LoaderCircle className="spin" size={15}/> : <Globe2 size={15}/>}Open browser</button></div> : null;
  const closeConfig = () => { if (browserSession?.active) void api(`/api/plugins/${plugin.manifest.id}/browser-login`, { method: "DELETE" }); close(); };
  return <><div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeConfig()}><div className="modal">
    <div className="modal-head"><div><p>{installing ? "SET UP PLUGIN" : "PLUGIN SETTINGS"}</p><h2>{plugin.manifest.name}</h2></div><button className="icon-button" onClick={closeConfig}><X/></button></div>
    <div className="form-stack">{!plugin.manifest.settings?.length && <div className="plugin-no-settings"><Settings size={20}/><div><strong>No setup required</strong><p>This plugin uses safe built-in defaults.</p></div></div>}{plugin.manifest.settings?.map((field) => field.type === "session" ? <div className="session-field" key={field.key}>
      <div className="session-field-head"><span>{field.label}{field.required && " *"}</span>{Boolean(plugin.config[field.key]) && <b><ShieldCheck size={13}/>Session connected</b>}</div>
      {browserCard(field.key)}
      <details className={plugin.manifest.browserAuth?.sessionSetting === field.key ? "manual-session" : "manual-session open-session"} open={plugin.manifest.browserAuth?.sessionSetting === field.key ? manualSessionOpen : true} onToggle={(event) => { if (plugin.manifest.browserAuth?.sessionSetting === field.key) setManualSessionOpen(event.currentTarget.open); }}><summary>{plugin.manifest.browserAuth?.sessionSetting === field.key ? "Manual session import (fallback)" : "Session import"}</summary><textarea aria-label={field.label} value={values[field.key] === "••••••••" ? "" : String(values[field.key] ?? "")} placeholder={plugin.config[field.key] ? "Paste here to replace the connected session" : field.placeholder ?? "Paste the Cookie header from your signed-in browser"} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}/><div className="session-actions"><label className="secondary"><FolderOpen size={15}/>Import session file<input type="file" accept={field.sessionFormat === "raw-json" ? ".json,application/json,text/plain" : ".txt,text/plain"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then((content) => setValues((current) => ({ ...current, [field.key]: content }))); }}/></label>{!field.required && Boolean(plugin.config[field.key]) && <button className="text-button" onClick={() => setValues({ ...values, [field.key]: "" })}>Remove session</button>}</div></details>
      {field.help && <small>{field.help}</small>}<small className="session-security"><ShieldCheck size={12}/>Stored only in EasyX data with private file permissions. Passwords and pasted text are not logged or saved; only the captured session is retained.</small>
    </div> : <React.Fragment key={field.key}>{browserCard(field.key)}<label><span>{field.label}{field.required && " *"}</span>{field.type === "boolean" ? <input type="checkbox" checked={!!values[field.key]} onChange={(event) => setValues({ ...values, [field.key]: event.target.checked })}/> : <input type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"} value={String(values[field.key] ?? "")} placeholder={field.placeholder} onChange={(event) => setValues({ ...values, [field.key]: field.type === "number" ? Number(event.target.value) : event.target.value })}/>} {field.help && <small>{field.help}</small>}</label></React.Fragment>)}</div>
    {browserError && <div className="connection-result error"><span><X size={24}/></span><div><strong>Browser session not completed</strong><p>{browserError}</p></div></div>}
    {test && <div className={`connection-result ${test.ok ? "ok" : "error"}`}><span>{test.ok ? <Check size={24}/> : <X size={24}/>}</span><div><strong>{test.ok ? "Plugin ready" : "Connection failed"}</strong><p>{test.message}</p></div></div>}
    <div className={`modal-actions ${!installing ? "plugin-config-actions" : ""}`}>{!installing && <button className="danger-soft uninstall-in-config" onClick={remove}><Trash2 size={16}/>Uninstall</button>}{!installing && <button className="secondary" disabled={testing} onClick={testConnection}>{testing ? <LoaderCircle className="spin" size={16}/> : <Gauge size={16}/>}Test connection</button>}<button className="primary" onClick={save}><Check size={16}/>{installing ? "Install & activate" : "Save settings"}</button></div>
  </div></div>{browserSession?.active && browserSession.viewerPath && <div className="modal-backdrop browser-backdrop"><div className="browser-modal"><div className="browser-modal-head"><div><p>INTEGRATED SECURE BROWSER</p><h2>Sign in to {plugin.manifest.name}</h2><span>EasyX captures the session only when you confirm below. This window closes automatically after 15 minutes.</span></div><button className="icon-button" aria-label="Close integrated browser" disabled={browserBusy} onClick={() => void stopBrowser()}><X/></button></div>{browserError && <div className="browser-error"><CircleAlert size={16}/><span><strong>Session not captured</strong>{browserError}</span></div>}<div className="browser-clipboard"><button className="secondary" onClick={() => void pasteFromMac()}><ClipboardPaste size={15}/>Paste from Mac</button><input aria-label="Clipboard fallback" placeholder="Fallback: click the site field, then paste here with ⌘V" onPaste={(event) => { const text = event.clipboardData.getData("text/plain"); if (text) { event.preventDefault(); void sendClipboard(text); } }}/><span>{clipboardStatus || "Click a field in the site, then press ⌘V directly."}</span></div><div className="browser-frame"><iframe title={`${plugin.manifest.name} sign-in browser`} src={browserSession.viewerPath} onLoad={(event) => attachClipboardBridge(event.currentTarget)}/></div><div className="browser-modal-foot"><p><ShieldCheck size={15}/>Keep this EasyX server private: anyone who can access this page can interact with the open browser.</p><div><button className="secondary" disabled={browserBusy} onClick={() => void stopBrowser()}>Cancel</button><button className="primary" disabled={browserBusy} onClick={() => void captureBrowser()}>{browserBusy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}I’m signed in — capture session</button></div></div></div></div>}</>;
}

function SettingsPage({ settings, run, setNotice }: { settings: Record<string, any>; run: (op: () => Promise<unknown>, msg: string) => Promise<void>; setNotice: (text: string) => void }) {
  const [values, setValues] = useState(settings);
  const [category, setCategory] = useState<"automation" | "storage" | "subtitles">("automation");
  const categories = [
    { key: "automation", label: "Automation", description: "Discovery and downloads", icon: Gauge },
    { key: "storage", label: "Storage", description: "Media location", icon: HardDrive },
    { key: "subtitles", label: "Subtitles", description: "Local transcription", icon: Captions },
  ] as const;
  const saveAutomation = () => void run(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ defaultScrapeIntervalMinutes: values.defaultScrapeIntervalMinutes, defaultLiveIntervalSeconds: values.defaultLiveIntervalSeconds, maxConcurrentDownloads: values.maxConcurrentDownloads, autoQueueDiscovered: values.autoQueueDiscovered, retentionDays: values.retentionDays }) }), "Settings saved");
  return <section className="categorized-settings">
    <div className="settings-page-heading"><p>APPLICATION SETTINGS</p><h2>Settings</h2><span>Configure each part of Open EasyX from its own category.</span></div>
    <div className="categorized-settings-layout">
      <nav className="settings-category-menu" aria-label="Settings categories"><p>CATEGORIES</p>{categories.map(({ key, label, description, icon: Icon }) => <button key={key} className={category === key ? "active" : ""} aria-pressed={category === key} onClick={() => setCategory(key)}><Icon/><span><b>{label}</b><small>{description}</small></span><ChevronRight/></button>)}</nav>
      <div className="settings-category-content">
        {category === "automation" && <section className="panel"><div className="panel-head"><div><p>AUTOMATION</p><h3>Scraping and downloads</h3></div></div><div className="form-stack"><label><span>Default periodic scrape interval (minutes)</span><input type="number" min="5" value={values.defaultScrapeIntervalMinutes ?? 360} onChange={(e) => setValues({ ...values, defaultScrapeIntervalMinutes: Number(e.target.value) })}/><small>Fallback for plugins that do not publish a recommended schedule. Each performer URL can override it.</small></label><label><span>Default live check interval (seconds)</span><input type="number" min="5" max="3600" value={values.defaultLiveIntervalSeconds ?? 10} onChange={(e) => setValues({ ...values, defaultLiveIntervalSeconds: Number(e.target.value) })}/><small>Reserved for live-aware plugins. A plugin can enforce a safer minimum interval.</small></label><label><span>Maximum concurrent downloads</span><input type="number" min="1" max="8" value={values.maxConcurrentDownloads ?? 2} onChange={(e) => setValues({ ...values, maxConcurrentDownloads: Number(e.target.value) })}/><small>Keep this low on slower storage or connections.</small></label><label className="toggle-row"><span><b>Automatically queue discovered media</b><small>New items from every source are queued without review.</small></span><input type="checkbox" checked={!!values.autoQueueDiscovered} onChange={(e) => setValues({ ...values, autoQueueDiscovered: e.target.checked })}/></label><label><span>Retention period (days)</span><input type="number" min="0" value={values.retentionDays ?? 0} onChange={(e) => setValues({ ...values, retentionDays: Number(e.target.value) })}/><small>Reserved for retention policies. Use 0 to keep files indefinitely.</small></label></div><button className="primary" onClick={saveAutomation}><Check size={16}/>Save changes</button></section>}
        {category === "storage" && <section className="panel"><div className="panel-head"><div><p>STORAGE</p><h3>Media volume</h3></div></div><div className="path-box"><FolderOpen/><code>{settings.mediaRoot}</code></div><p className="muted">Files are organized as <code>Performer / source-domain / filename</code>. Mount this path into media managers that should index completed downloads.</p></section>}
        {category === "subtitles" && <div className="library-mode embedded-subtitle-settings"><SubtitleSettingsPage setNotice={setNotice} embedded/></div>}
      </div>
    </div>
  </section>;
}

function ItemList({ items, performers }: { items: Item[]; performers: Performer[] }) { return <div className="item-list">{items.map((item) => <div key={item.id}><span className={`media-icon ${item.mediaType}`}><Download/></span><div><strong>{item.title || item.id}</strong><small>{performers.find((p) => p.id === item.performerId)?.name ?? "Unknown performer"}</small></div><span className={`badge ${item.status}`}>{item.status}</span><time>{timeAgo(item.updatedAt)}</time></div>)}</div>; }
function Empty({ icon: Icon, title, text, action, onAction }: { icon: any; title: string; text: string; action?: string; onAction?: () => void }) { return <div className="empty"><span><Icon/></span><h3>{title}</h3><p>{text}</p>{action && <button className="secondary" onClick={onAction}>{action}</button>}</div>; }

const normalizedEntryPath = window.location.pathname.length > 1 ? window.location.pathname.replace(/\/+$/, "") : window.location.pathname;
const entryPath = canonicalEntryPath(window.location.pathname);
if (entryPath !== window.location.pathname) {
  const params = new URLSearchParams(window.location.search);
  if (normalizedEntryPath === "/discover") params.set("discover", "1");
  const search = params.toString();
  window.history.replaceState(window.history.state, "", `${entryPath}${search ? `?${search}` : ""}${window.location.hash}`);
}
createRoot(document.getElementById("root")!).render(<React.StrictMode>{isLibraryRoute(window.location.pathname) ? <LibraryApp/> : <App/>}</React.StrictMode>);
