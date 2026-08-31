import { useState, type ReactNode } from "react";
import { Menu, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { UnifiedNavigation } from "./UnifiedNavigation";

export function AppChrome({ title, scanningLibrary = false, onScanLibrary, onRefreshPerformers, children }: { title: string; scanningLibrary?: boolean; onScanLibrary: () => void; onRefreshPerformers: () => void; children: ReactNode }) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const pathname = typeof window === "undefined" ? "/media" : window.location.pathname;

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
        <em>v1.0.0</em>
      </div>
    </aside>
    {mobileNavigationOpen && <button className="easyx-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNavigationOpen(false)}/>}
    <main className="easyx-main">
      <header className="easyx-header">
        <button className="easyx-menu-button" aria-label="Open navigation" onClick={() => setMobileNavigationOpen(true)}><Menu size={20}/></button>
        <div className="easyx-header-title"><p>OPEN EASYX</p><h1>{title}</h1></div>
        <div className="easyx-header-actions">
          <button className="easyx-scan-button" disabled={scanningLibrary} onClick={onScanLibrary}><RefreshCw className={scanningLibrary ? "spin" : ""} size={17}/><span>Scan library</span></button>
          <button className="primary" onClick={onRefreshPerformers}><Search size={17}/><span>Refresh performers</span></button>
        </div>
      </header>
      {children}
    </main>
  </div>;
}
