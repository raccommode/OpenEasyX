import { useEffect, useState } from "react";
import { Captions, Check, Cpu, Languages, LoaderCircle, Save } from "lucide-react";
import { api } from "./api";

type Overview = {
  settings: { enabled: boolean; languages: string[] };
  languages: Array<{ code: string; label: string }>;
  counts: { total: number; complete: number; pending: number; errors: number };
  worker: { state?: string; title?: string; heartbeat?: string; error?: string };
};

export function SettingsPage({ setNotice, embedded = false }: { setNotice: (value: string) => void; embedded?: boolean }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const load = async () => {
    const value = await api<Overview>("/api/subtitles/status");
    setOverview(value); setEnabled(value.settings.enabled); setSelected(value.settings.languages);
  };
  useEffect(() => {
    void load().catch((error) => setNotice(error.message));
    const timer = window.setInterval(() => void api<Overview>("/api/subtitles/status").then(setOverview).catch(() => {}), 5000);
    return () => window.clearInterval(timer);
  }, []);
  if (!overview) return <div className="loading"><LoaderCircle className="spin"/>Loading settings…</div>;
  const workerOnline = !!overview.worker.heartbeat && Date.now() - new Date(overview.worker.heartbeat).getTime() < 30_000;
  const workerState = !enabled ? "Disabled" : !workerOnline ? "Local worker is offline" : overview.worker.state === "processing" ? `Processing ${overview.worker.title || "a video"}` : "Ready and waiting";
  const save = async () => {
    setSaving(true);
    try { await api("/api/settings/subtitles", { method: "PUT", body: JSON.stringify({ enabled, languages: selected }) }); await load(); setNotice("Subtitle settings saved."); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <section className="settings-page">{!embedded && <div className="library-intro"><div><p>MEDIA FEATURES</p><h2>Subtitles</h2><span>Automatic transcription and private local translations inside Open EasyX</span></div></div>}
    <div className="settings-panel"><section className="settings-card settings-hero"><div className="settings-icon"><Captions/></div><div><h3>Automatic subtitles</h3><p>Generate subtitle tracks locally. Audio and text never leave your installation.</p></div><button className={`settings-switch ${enabled ? "active" : ""}`} role="switch" aria-label="Automatic subtitles" aria-checked={enabled} onClick={() => setEnabled(!enabled)}><i/></button></section>
      <div className={enabled ? "settings-stack" : "settings-stack disabled"}><section className="settings-card"><div className="settings-section-head"><div><Languages/><span><h3>Subtitle languages</h3><p>The detected original language is always included.</p></span></div><strong><Check/>Original</strong></div><div className="language-grid">{overview.languages.map((language) => <button key={language.code} className={selected.includes(language.code) ? "selected" : ""} onClick={() => setSelected((current) => current.includes(language.code) ? current.filter((code) => code !== language.code) : [...current, language.code])}><span>{language.label}<small>{language.code.toUpperCase()}</small></span>{selected.includes(language.code) && <Check/>}</button>)}</div></section>
        <section className="settings-card worker-card"><div className="settings-section-head"><div><Cpu/><span><h3>Local processing</h3><p>{workerState}</p></span></div><span className={`worker-state ${workerOnline ? "" : "error"}`}>{workerOnline ? overview.worker.state || "starting" : "offline"}</span></div><div className="worker-metrics"><div><b>{overview.counts.total}</b><small>Queued</small></div><div><b>{overview.counts.complete}</b><small>Completed</small></div><div><b>{overview.counts.pending}</b><small>Pending</small></div><div><b>{overview.counts.errors}</b><small>Errors</small></div></div></section></div>
      <div className="settings-save"><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin"/> : <Save/>}{saving ? "Saving…" : "Save subtitle settings"}</button></div></div>
  </section>;
}
