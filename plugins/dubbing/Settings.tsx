import { useEffect, useState } from "react";
import { Check, Languages, LoaderCircle, RefreshCw, Save, Trash2, X } from "lucide-react";
import { ProcessingOrderField } from "../../src/ProcessingOrderField";
import { api } from "../../src/api";
import { DubbingPassages } from "../../src/DubbingPassages";
import type { DubbingOriginalInterval } from "../../packages/plugin-sdk";

type Overview = {
  languages: { code: string; label: string }[];
  selected: string[];
  oldestFirst: boolean;
  lipSync: boolean;
  current: { title: string; language: string; phase: string; progress: number } | null;
  runtimeRetryAt?: string | null;
  errors: { id: string; title: string; language: string; error: string; runtimeSetup?: boolean }[];
  partialDubCount?: number;
  partialDubs?: { id: string; title: string; language: string; originalIntervals: DubbingOriginalInterval[] }[];
};

export default function DubbingSettings({ name, close, uninstall }: { name: string; close: () => void; uninstall: () => Promise<void> }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<Pick<Overview, "selected" | "oldestFirst" | "lipSync"> | null>(null);
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
  const selected = draft?.selected ?? overview?.selected ?? [];
  const oldestFirst = draft?.oldestFirst ?? overview?.oldestFirst ?? false;
  const lipSync = draft?.lipSync ?? overview?.lipSync ?? false;
  const languageLabel = (code: string) => overview?.languages.find((item) => item.code === code)?.label ?? code;
  const save = async () => {
    if (!draft || !overview) return;
    setBusy(true); setError("");
    try {
      const config = { ...Object.fromEntries(overview.languages.map(({ code }) => [code, draft.selected.includes(code)])), oldestFirst: draft.oldestFirst, lipSync: draft.lipSync };
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
  const retryAt = !job && overview?.selected.length ? overview.runtimeRetryAt : null;
  const runtimeFailure = retryAt ? overview?.errors.find((failure) => failure.runtimeSetup) : undefined;
  const failedJobs = overview?.errors.filter((failure) => failure !== runtimeFailure) ?? [];
  const failureRow = (failure: Overview["errors"][number]) => <div key={`${failure.id}-${failure.language}`}>
    <span><b>{failure.title} · {languageLabel(failure.language)}</b><p>{failure.error}</p></span>
    <button className="quiet" disabled={busy || !overview?.selected.includes(failure.language)} aria-label={`Retry ${failure.title} in ${languageLabel(failure.language)}`} onClick={() => void retry(failure.id, failure.language)}><RefreshCw size={14}/>{failure === runtimeFailure ? "Retry now" : "Retry"}</button>
  </div>;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="dubbing-settings-title" onKeyDown={(event) => { if (event.key === "Escape" && !busy) close(); }}>
      <div className="modal-head"><div><p>PLUGIN SETTINGS</p><h2 id="dubbing-settings-title">{name}</h2></div><button className="icon-button" disabled={busy} autoFocus aria-label="Close dubbing settings" onClick={close}><X/></button></div>
      <div className="library-mode subtitle-plugin-settings">
        {(error || loadError) && <p role="alert" className="worker-error">{error || loadError}</p>}
        {!overview && !loadError && <p role="status"><LoaderCircle className="spin"/> Loading dubbing settings…</p>}
        {overview && <div className="settings-stack">
          <section className="settings-card">
            <div className="settings-section-head"><div><Languages/><span><h3 id="dubbing-languages">Dubbing languages</h3><p id="dubbing-hint">Each speaker’s voice is cloned locally for the selected languages. Choose a finished version under Audio language in the player.</p></span></div></div>
            <div className="language-grid" role="group" aria-labelledby="dubbing-languages" aria-describedby="dubbing-hint">
              {overview.languages.map(({code,label}) => {
                const on = selected.includes(code);
                return <button key={code} className={on ? "selected" : ""} aria-pressed={on} disabled={busy} onClick={() => setDraft({ selected: on ? selected.filter((item) => item !== code) : [...selected, code], oldestFirst, lipSync })}><span>{label}</span>{on && <Check aria-hidden="true"/>}</button>;
              })}
            </div>
          </section>
          <section className="settings-card settings-hero">
            <div><h3 id="dubbing-lips">Lip sync</h3><p id="dubbing-lips-hint">Animate visible speakers to match the dubbed audio. This takes longer and updates existing dubs in the selected languages.</p></div>
            <button className={`settings-switch ${lipSync ? "active" : ""}`} role="switch" aria-labelledby="dubbing-lips" aria-describedby="dubbing-lips-hint" aria-checked={lipSync} disabled={busy} onClick={() => setDraft({ selected, oldestFirst, lipSync: !lipSync })}><i/></button>
          </section>
          <section className="settings-card">
            <ProcessingOrderField oldestFirst={oldestFirst} onChange={(order) => setDraft({ selected, oldestFirst: order, lipSync })} disabled={busy}/>
          </section>
          <section className="settings-card"><h3>Local processing</h3>
            {job ? <div className="subtitle-job-progress"><p className="subtitle-current-title">{job.title} · {languageLabel(job.language)}</p><div><span role="status">{job.phase}</span><strong aria-hidden="true">{Math.round(job.progress)}%</strong></div><progress aria-label={`Dubbing ${job.title} in ${languageLabel(job.language)}`} max={100} value={job.progress}/></div>
              : retryAt ? <><p role="status">Dubbing is paused because the local runtime is unavailable. The next automatic retry is scheduled for <time dateTime={retryAt}>{new Date(retryAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>.</p>
                {runtimeFailure && <div className="dubbing-errors">{failureRow(runtimeFailure)}</div>}</>
              : <p role="status">{overview.selected.length ? "Waiting for the next video" : "Select a language to start dubbing."}</p>}
          </section>
          {failedJobs.length > 0 && <section className="settings-card dubbing-errors"><h3>Failed jobs</h3>{failedJobs.map(failureRow)}</section>}
          {!!overview.partialDubs?.length && <section className="settings-card"><h3>Partially dubbed videos</h3>
            {(overview.partialDubCount ?? 0) > overview.partialDubs.length && <p>Showing the {overview.partialDubs.length} newest of {overview.partialDubCount} versions.</p>}
            {overview.partialDubs.map((dub) => <DubbingPassages key={`${dub.id}-${dub.language}`} label={`${dub.title} · ${languageLabel(dub.language)}`} intervals={dub.originalIntervals}/>)}
          </section>}
        </div>}
      </div>
      <div className="modal-actions"><button className="danger-soft" disabled={busy} onClick={async () => { setBusy(true); try { await uninstall(); } finally { setBusy(false); } }}><Trash2 size={16}/>Uninstall</button>
        <button className="primary" disabled={busy || !draft} onClick={() => void save()}><Save size={16}/>Save settings</button></div>
    </section>
  </div>;
}
