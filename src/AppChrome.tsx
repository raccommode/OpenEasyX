import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { api } from "./api";
import { UnifiedNavigation } from "./UnifiedNavigation";

type RemoteOperationStatus = { running: boolean; progress: number; error?: string };
type LiveOperationStatus = { running: boolean; percent: number };
const idleOperation: LiveOperationStatus = { running: false, percent: 0 };

export function operationLabel(label: string, operation: LiveOperationStatus): string {
  return operation.running ? `${label} · ${Math.max(0, Math.min(100, Math.round(operation.percent)))}%` : label;
}

function useLiveOperation(endpoint: string) {
  const [status, setStatus] = useState<LiveOperationStatus>(idleOperation);
  const statusRef = useRef(status); const startedAt = useRef(0); const seenRunning = useRef(false);
  const completing = useRef(false); const completionTimer = useRef<number | undefined>(undefined);
  const update = (next: LiveOperationStatus) => { statusRef.current = next; setStatus(next); };
  const begin = () => {
    if (completionTimer.current !== undefined) window.clearTimeout(completionTimer.current);
    startedAt.current = Date.now(); seenRunning.current = false; completing.current = false;
    update({ running: true, percent: 0 });
  };
  useEffect(() => {
    let disposed = false; let polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const remote = await api<RemoteOperationStatus>(endpoint);
        if (disposed) return;
        if (remote.running) {
          if (completionTimer.current !== undefined) window.clearTimeout(completionTimer.current);
          seenRunning.current = true; completing.current = false;
          update({ running: true, percent: remote.progress });
        } else if (statusRef.current.running && !completing.current) {
          if (!seenRunning.current && Date.now() - startedAt.current < 650) return;
          if (remote.error) { update(idleOperation); return; }
          completing.current = true; update({ running: true, percent: 100 });
          completionTimer.current = window.setTimeout(() => {
            completing.current = false; update(idleOperation);
          }, 550);
        }
      } catch { /* The action itself reports API errors to the page. */ }
      finally { polling = false; }
    };
    void poll(); const interval = window.setInterval(() => void poll(), 300);
    return () => {
      disposed = true; window.clearInterval(interval);
      if (completionTimer.current !== undefined) window.clearTimeout(completionTimer.current);
    };
  }, [endpoint]);
  return { ...status, begin };
}

export function AppChrome({ title, scanningLibrary = false, onScanLibrary, onRefreshPerformers, children }: { title: string; scanningLibrary?: boolean; onScanLibrary: () => void; onRefreshPerformers: () => void; children: ReactNode }) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [version, setVersion] = useState("...");
  const pathname = typeof window === "undefined" ? "/media" : window.location.pathname;
  const scan = useLiveOperation("/api/scan/status");
  const performers = useLiveOperation("/api/performers/refresh/status");
  const scanRunning = scanningLibrary || scan.running;
  useEffect(() => { void api<{ version: string }>("/api/version").then((result) => setVersion(result.version || "unknown")).catch(() => setVersion("unknown")); }, []);

  return <div className="easyx-shell">
    <aside className={`sidebar easyx-sidebar ${mobileNavigationOpen ? "open" : ""}`}>
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
    <main className="easyx-main">
      <header className="easyx-header">
        <button className="easyx-menu-button" aria-label="Open navigation" onClick={() => setMobileNavigationOpen(true)}><Menu size={20}/></button>
        <div className="easyx-header-title"><p>OPEN EASYX</p><h1>{title}</h1></div>
        <div className="easyx-header-actions">
          <button className="easyx-scan-button easyx-header-operation" disabled={scanRunning} aria-busy={scanRunning} onClick={() => { scan.begin(); onScanLibrary(); }}><RefreshCw className={scanRunning ? "spin" : ""} size={17}/><span>{operationLabel("Scan library", { running: scanRunning, percent: scan.percent })}</span></button>
          <button className="primary easyx-header-operation" disabled={performers.running} aria-busy={performers.running} onClick={() => { performers.begin(); onRefreshPerformers(); }}><Search className={performers.running ? "spin" : ""} size={17}/><span>{operationLabel("Refresh performers", performers)}</span></button>
        </div>
      </header>
      {children}
    </main>
  </div>;
}
