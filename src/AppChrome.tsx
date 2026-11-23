import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { api } from "./api";
import { UnifiedNavigation } from "./UnifiedNavigation";
import { idleOperation, watchOperationStatus, type LiveOperationStatus } from "./operation-status";

export function operationLabel(label: string, operation: LiveOperationStatus): string {
  return operation.running ? `${label} · ${Math.max(0, Math.min(100, Math.round(operation.percent)))}%` : label;
}

function useLiveOperation(endpoint: string) {
  const [status, setStatus] = useState<LiveOperationStatus>(idleOperation);
  const watcher = useRef<ReturnType<typeof watchOperationStatus> | null>(null);
  useEffect(() => {
    const operation = watchOperationStatus(endpoint, setStatus);
    watcher.current = operation;
    return () => {
      operation.dispose();
      watcher.current = null;
    };
  }, [endpoint]);
  return { ...status, begin: () => watcher.current?.begin() };
}

export function AppChrome({ title, scanningLibrary = false, onScanLibrary, onRefreshPerformers, children }: { title: string; scanningLibrary?: boolean; onScanLibrary: () => void; onRefreshPerformers: () => void; children: ReactNode }) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(false);
  const sidebar = useRef<HTMLElement>(null); const menu = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const update = () => { setCompactNavigation(query.matches); if (!query.matches) setMobileNavigationOpen(false); };
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    sidebar.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMobileNavigationOpen(false); }
      if (event.key !== "Tab") return;
      const targets = sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])');
      if (!targets?.length) return;
      const first = targets[0]; const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", key); menu.current?.focus(); };
  }, [mobileNavigationOpen]);
  const [version, setVersion] = useState("...");
  const pathname = typeof window === "undefined" ? "/media" : window.location.pathname;
  const scan = useLiveOperation("/api/scan/status");
  const performers = useLiveOperation("/api/performers/refresh/status");
  const scanRunning = scanningLibrary || scan.running;
  useEffect(() => { void api<{ version: string }>("/api/version").then((result) => setVersion(result.version || "unknown")).catch(() => setVersion("unknown")); }, []);

  return <div className="easyx-shell">
    <aside ref={sidebar} id="primary-navigation" aria-label="Main navigation" role={compactNavigation ? "dialog" : undefined} aria-modal={compactNavigation && mobileNavigationOpen ? true : undefined} inert={compactNavigation && !mobileNavigationOpen} className={`sidebar easyx-sidebar ${mobileNavigationOpen ? "open" : ""}`} onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setMobileNavigationOpen(false); }}>
      <div className="easyx-brand-row">
        <a className="brand brand-wordmark" href="/media"><span><strong>Open EasyX</strong><small>ONE PRIVATE SUITE</small></span></a>
        <button className="easyx-sidebar-close" aria-label="Close navigation" onClick={() => setMobileNavigationOpen(false)}><X size={18}/></button>
      </div>
      <UnifiedNavigation pathname={pathname}/>
      <div className="easyx-sidebar-footer">
        <ShieldCheck size={18}/>
        <span><strong>Private by design</strong><small>Your data stays on this server.</small></span>
        <em>v{version}</em>
      </div>
    </aside>
    {mobileNavigationOpen && <button className="easyx-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNavigationOpen(false)}/>}
    <main className="easyx-main" inert={mobileNavigationOpen}>
      <header className="easyx-header">
        <button ref={menu} className="easyx-menu-button" aria-label="Open navigation" aria-expanded={mobileNavigationOpen} aria-controls="primary-navigation" onClick={() => setMobileNavigationOpen(true)}><Menu size={20}/></button>
        <div className="easyx-header-title"><p>OPEN EASYX</p><h1>{title}</h1></div>
        <div className="easyx-header-actions">
          <button className="easyx-scan-button easyx-header-operation" aria-label={operationLabel("Scan library", { running: scanRunning, percent: scan.percent })} disabled={scanRunning} aria-busy={scanRunning} onClick={() => { onScanLibrary(); scan.begin(); }}><RefreshCw className={scanRunning ? "spin" : ""} size={17}/><span>{operationLabel("Scan library", { running: scanRunning, percent: scan.percent })}</span></button>
          <button className="primary easyx-header-operation" aria-label={operationLabel("Refresh performers", performers)} disabled={performers.running} aria-busy={performers.running} onClick={() => { onRefreshPerformers(); performers.begin(); }}><Search className={performers.running ? "spin" : ""} size={17}/><span>{operationLabel("Refresh performers", performers)}</span></button>
        </div>
      </header>
      {children}
    </main>
  </div>;
}
