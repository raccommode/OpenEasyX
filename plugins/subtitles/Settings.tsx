import { useEffect, useState } from "react";
import { Check, Cpu, Languages, LoaderCircle, Save, Trash2, X } from "lucide-react";
import { api } from "../../src/api";

type Settings = { enabled: boolean; languages: string[] };
type CurrentJob = {
  title: string;
  progress: number;
  sourceLanguage: string;
  phase: "preparing" | "detecting" | "transcribing" | "translating";
  targetLanguage?: string;
};
type Overview = {
  settings: Settings;
  languages: Array<{ code: string; label: string }>;
  currentJob: CurrentJob | null;
  counts: { total: number; complete: number; pending: number; skipped: number; errors: number };
  worker: { state?: string; title?: string; heartbeat?: string; error?: string };
};

function jobPhase(job: CurrentJob, languages: Overview["languages"]) {
  const label = (code: string) => {
    const known = languages.find((item) => item.code === code);
    if (known) return known.label;
    try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; }
    catch { return code; }
  };
  if (job.phase === "preparing") {
    return job.targetLanguage ? `Preparing the local model for ${label(job.targetLanguage)} translation` : "Preparing the local speech model";
  }
  if (job.phase === "detecting") return "Detecting the spoken language";
  if (job.phase === "translating") {
    if (!job.targetLanguage) return "Translating subtitles";
    return job.sourceLanguage
      ? `Translating ${label(job.sourceLanguage)} to ${label(job.targetLanguage)}`
      : `Translating to ${label(job.targetLanguage)}`;
  }
  return job.sourceLanguage ? `Transcribing ${label(job.sourceLanguage)} audio` : "Transcribing audio";
}

function workerStatus({ settings, worker }: Overview) {
  if (!settings.enabled) return "Automatic generation is paused";
  if (worker.state === "error") return worker.error || "The worker encountered an error";
  if (worker.state === "starting") return "Preparing the local subtitle worker…";
  if (!worker.heartbeat || Date.now() - Date.parse(worker.heartbeat) > 30_000) return "Waiting for the local worker";
  if (worker.state === "processing") return `Processing ${worker.title || "a video"}`;
  return "Ready for the next video";
}

export default function SubtitlePluginSettings({ name, close, uninstall }: { name: string; close: () => void; uninstall: () => Promise<void> }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const settings = draft ?? overview?.settings;
  const job = overview?.currentJob;
  const processed = overview ? overview.counts.complete + overview.counts.skipped : 0;
  const percent = job ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0;
  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const refresh = async () => {
      try {
        const value = await api<Overview>("/api/subtitles/status", { signal: controller.signal });
        if (!controller.signal.aborted) { setOverview(value); setLoadError(""); }
      } catch (err) {
        if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);

  const save = async () => {
    if (!settings) return;
    setBusy(true); setError("");
    try {
      await api("/api/settings/subtitles", { method: "PUT", body: JSON.stringify(settings) });
      close();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="subtitle-plugin-heading" onKeyDown={(event) => { if (event.key === "Escape" && !busy) close(); }}>
      <div className="modal-head"><div><p>PLUGIN SETTINGS</p><h2 id="subtitle-plugin-heading">{name}</h2></div><button className="icon-button" aria-label="Close subtitle settings" onClick={close} disabled={busy} autoFocus><X/></button></div>
      <div className="library-mode subtitle-plugin-settings">
        {(error || loadError) && <p role="alert" className="worker-error">{error || loadError}</p>}
        {!overview && !loadError && <p role="status"><LoaderCircle className="spin"/> Loading subtitle settings…</p>}
        {overview && settings && <div className="settings-stack">
          <section className="settings-card settings-hero">
            <div><h3>Automatic subtitles</h3><p id="subtitle-scope">Detect the spoken language of each video and generate original-language subtitles locally. Applies to existing and newly added library videos.</p></div>
            <button className={`settings-switch ${settings.enabled ? "active" : ""}`} role="switch" aria-label="Automatic subtitles" aria-describedby="subtitle-scope" aria-checked={settings.enabled} disabled={busy} onClick={() => setDraft({ ...settings, enabled: !settings.enabled })}><i/></button>
          </section>
          <section className="settings-card">
            <div className="settings-section-head"><div><Languages/><span><h3 id="subtitle-languages">Translation languages</h3><p id="subtitle-language-hint">Choose any languages to add, or leave them all off for original subtitles only. The player prefers the first language you select.</p></span></div></div>
            <div className="language-grid" role="group" aria-labelledby="subtitle-languages" aria-describedby="subtitle-language-hint">{overview.languages.map(({ code, label }) => {
              const selected = settings.languages.includes(code);
              return <button key={code} className={selected ? "selected" : ""} aria-pressed={selected} disabled={busy} onClick={() => setDraft({ ...settings, languages: selected ? settings.languages.filter((item) => item !== code) : [...settings.languages, code] })}><span>{label}{code === settings.languages[0] && <small>Player default</small>}</span>{selected && <Check aria-hidden="true"/>}</button>;
            })}</div>
          </section>
          <section className="settings-card">
            <div className="settings-section-head"><div><Cpu/><span><h3>Local processing</h3><p role="status" className={job ? "subtitle-current-title" : ""}>{job ? job.title : workerStatus(overview)}</p></span></div></div>
            {job && <div className="subtitle-job-progress">
              <div><span role="status">{jobPhase(job, overview.languages)}</span><strong aria-hidden="true">{percent}%</strong></div>
              <progress aria-label={`Subtitle generation for ${job.title}`} max={100} value={percent}>{percent}%</progress>
            </div>}
            {overview.counts.total > 0 && <div className="subtitle-job-progress">
              <div><span id="subtitle-library-progress-label">Library progress</span><strong>{processed} / {overview.counts.total} videos</strong></div>
              <progress aria-labelledby="subtitle-library-progress-label" max={overview.counts.total} value={processed} aria-valuetext={`${processed} of ${overview.counts.total} videos completed or skipped`}/>
            </div>}
            <div className="worker-metrics"><div><b>{overview.counts.pending}</b><small>Pending</small></div><div><b>{overview.counts.complete}</b><small>Completed</small></div><div><b>{overview.counts.skipped}</b><small>Skipped</small></div><div><b>{overview.counts.errors}</b><small>Failed</small></div></div>
          </section>
        </div>}
      </div>
      <div className="modal-actions">
        <button className="danger-soft" disabled={busy} onClick={async () => { setBusy(true); try { await uninstall(); } finally { setBusy(false); } }}><Trash2 size={16}/>Uninstall</button>
        <button className="primary" disabled={busy || !draft} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={16}/> : <Save size={16}/>}Save settings</button>
      </div>
    </section>
  </div>;
}
