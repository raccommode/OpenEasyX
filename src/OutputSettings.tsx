import { useState } from "react";
import { Check, FolderOpen, LoaderCircle } from "lucide-react";
import { api } from "./api";
import { outputDefaults, outputSettings, outputTokens, recordingPresets, renderOutputPath, validateOutputTemplate } from "../packages/output-settings";

export function OutputSettings({ settings, setNotice, onSaved }: { settings: Record<string, unknown>; setNotice: (message: string) => void; onSaved: (settings: Record<string, unknown>) => void }) {
  const [values, setValues] = useState(() => outputSettings(settings));
  const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const invalid = validateOutputTemplate(values.outputPathTemplate, "path") || validateOutputTemplate(values.outputFilenameTemplate, "filename");
  const preview = invalid ? "" : renderOutputPath(values, { performer: "Alice", site: "stripchat.com", filename: "live-session", title: "Evening live", id: "item_abc123", date: "2026-09-03", time: "20-30-00", year: "2026", month: "09", day: "03" }, "mp4");
  const save = async () => {
    if (invalid || saving) return;
    setSaving(true); setError("");
    try { const saved = await api<Record<string, unknown>>("/api/settings", { method: "PUT", body: JSON.stringify(values) }); onSaved({ ...settings, ...saved }); setNotice("Output and recording settings saved."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <section className="panel output-settings">
    <div className="panel-head"><div><p>STORAGE & RECORDING</p><h3>Output paths and filenames</h3></div></div>
    <div className="path-box"><FolderOpen/><code>{String(settings.mediaRoot ?? "media")}</code></div>
    <p className="muted">Choose how new downloads are organized inside your media volume. Existing files are not moved or renamed.</p>
    <div className="form-stack">
      <label><span>Folder template</span><input type="text" aria-label="Folder template" value={values.outputPathTemplate} onChange={(event) => setValues({ ...values, outputPathTemplate: event.target.value })} placeholder="Empty = media volume root"/><small>Use / for subfolders. To store files directly in the model folder, use {"{performer}"}.</small></label>
      <label><span>Filename template</span><input type="text" aria-label="Filename template" value={values.outputFilenameTemplate} onChange={(event) => setValues({ ...values, outputFilenameTemplate: event.target.value })}/><small>The correct file extension is added automatically. {"{filename}"} means the original name without its extension.</small></label>
      <p className="output-variables">Variables: {outputTokens.map((token) => <code key={token}>{`{${token}}`}</code>)}</p>
      <small className="muted">Dates and times use the publication/recording timestamp in UTC. {"{site}"} is the source domain; {"{id}"} is the unique download ID. Duplicate names get a suffix instead of overwriting files.</small>
      <div className="output-preview"><b>Example output</b><code>{preview || invalid}</code></div>
      <label><span>Live recording preset</span><select aria-label="Live recording preset" value={values.recordingPreset} onChange={(event) => setValues({ ...values, recordingPreset: event.target.value as typeof values.recordingPreset })}>{recordingPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}</select><small>{recordingPresets.find((preset) => preset.id === values.recordingPreset)?.description}</small></label>
      <p className="muted">By default, recordings copy the already-encoded stream without re-encoding it. Other presets encode after the recording ends or you choose Stop and save. This needs extra CPU and temporary storage; the file enters the library only after encoding finishes. Ordinary video downloads and photos are unchanged.</p>
    </div>
    {(error || invalid) && <p className="row-error" role="alert">{error || invalid}</p>}
    <div className="output-actions"><button className="secondary" onClick={() => setValues({ ...outputDefaults })}>Reset form to defaults</button><button className="primary" disabled={saving || !!invalid} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}Save output settings</button></div>
  </section>;
}
