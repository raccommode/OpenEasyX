import { useEffect, useState } from "react";
import { Check, Languages, LoaderCircle, RefreshCw, Save, Trash2, X } from "lucide-react";
import { api } from "../../src/api";

type Overview = {
  languages: { code: string; label: string }[];
  selected: string[];
  current: { title: string; language: string; phase: string; progress: number } | null;
  errors: { id: string; title: string; language: string; error: string }[];
};

export default function DubbingSettings({ name, close, uninstall }: { name: string; close: () => void; uninstall: () => Promise<void> }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const refresh = async () => {
      try {
        const value = await api<Overview>("/api/dubbing/status", { signal: controller.signal });
        if (!controller.signal.aborted) { setOverview(value); setLoadError(""); }
      } catch (err) {
        if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, 4000);
      }
    };
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [revision]);
  const selected = draft ?? overview?.selected ?? [];
  const languageLabel = (code: string) => overview?.languages.find((item) => item.code === code)?.label ?? code;
  const save = async () => {
    if (!draft || !overview) return;
    setBusy(true); setError("");
    try {
      const config = Object.fromEntries(overview.languages.map(({ code }) => [code, draft.includes(code)]));
      await api("/api/plugins/org.easyx.dubbing/config", { method: "PUT", body: JSON.stringify(config) });
      close();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const retry = async (id: string, language: string) => {
    setBusy(true); setError("");
    try {
      await api(`/api/media/${id}/dubbing/${language}/retry`, { method: "POST" });
      setRevision((n) => n + 1);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const job = overview?.current;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="dubbing-settings-title" onKeyDown={(event) => { if (event.key === "Escape" && !busy) close(); }}>
      <div className="modal-head"><div><p>PLUGIN SETTINGS</p><h2 id="dubbing-settings-title">{name}</h2></div><button className="icon-button" disabled={busy} autoFocus aria-label="Close dubbing settings" onClick={close}><X/></button></div>
      <div className="library-mode subtitle-plugin-settings">
        {(error || loadError) && <p role="alert" className="worker-error">{error || loadError}</p>}
        {!overview && !loadError && <p role="status"><LoaderCircle className="spin"/> Loading dubbing settings…</p>}
        {overview && <div className="settings-stack">
          <section className="settings-card">
            <div className="settings-section-head"><div><Languages/><span><h3 id="dubbing-languages">Dubbing languages</h3><p id="dubbing-hint">Choose languages for existing and newly added videos. Dubbed versions become available under Audio language in the player.</p></span></div></div>
            <div className="language-grid" role="group" aria-labelledby="dubbing-languages" aria-describedby="dubbing-hint">
              {overview.languages.map(({code,label}) => {
                const on = selected.includes(code);
                return <button key={code} className={on ? "selected" : ""} aria-pressed={on} disabled={busy} onClick={() => setDraft(on ? selected.filter((item) => item !== code) : [...selected, code])}><span>{label}</span>{on && <Check aria-hidden="true"/>}</button>;
              })}
            </div>
          </section>
          <section className="settings-card"><h3>Local processing</h3>
            {job ? <div className="subtitle-job-progress"><p className="subtitle-current-title">{job.title} · {languageLabel(job.language)}</p><div><span role="status">{job.phase}</span><strong aria-hidden="true">{Math.round(job.progress)}%</strong></div><progress aria-label={`Dubbing ${job.title} in ${languageLabel(job.language)}`} max={100} value={job.progress}/></div>
              : <p role="status">{overview.selected.length ? "Waiting for the next video" : "Select a language to start dubbing."}</p>}
          </section>
          {overview.errors.length > 0 && <section className="settings-card dubbing-errors"><h3>Failed jobs</h3>{overview.errors.map((failure) => <div key={`${failure.id}-${failure.language}`}>
            <span><b>{failure.title} · {languageLabel(failure.language)}</b><p>{failure.error}</p></span>
            <button className="quiet" disabled={busy || !overview.selected.includes(failure.language)} aria-label={`Retry ${failure.title} in ${languageLabel(failure.language)}`} onClick={() => void retry(failure.id, failure.language)}><RefreshCw size={14}/>Retry</button>
          </div>)}</section>}
        </div>}
      </div>
      <div className="modal-actions"><button className="danger-soft" disabled={busy} onClick={async () => { setBusy(true); try { await uninstall(); } finally { setBusy(false); } }}><Trash2 size={16}/>Uninstall</button>
        <button className="primary" disabled={busy || !draft} onClick={() => void save()}><Save size={16}/>Save settings</button></div>
    </section>
  </div>;
}
