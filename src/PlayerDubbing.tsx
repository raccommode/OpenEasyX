import { useEffect, useState } from "react";
import { AudioLines, Check } from "lucide-react";
import { api } from "./api";

type DubVariant = { code: string; label: string; status: "ready" | "original" | "silent" | "error" | "running" | "queued"; phase?: string; progress: number; error?: string };
type MediaDubbing = { installed: boolean; variants: DubVariant[] };

export function useMediaDubbing(mediaId?: string) {
  const [result, setResult] = useState<{ mediaId: string; state: MediaDubbing }>();
  useEffect(() => {
    if (!mediaId) return;
    const controller = new AbortController();
    let timer: number;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      window.clearTimeout(timer);
      let poll = true;
      try {
        const state = await api<MediaDubbing>(`/api/media/${mediaId}/dubbing`, { signal: controller.signal });
        if (!controller.signal.aborted) setResult({ mediaId, state });
        poll = state.variants.some((variant) => variant.status === "queued" || variant.status === "running");
      } catch { /* Retry after a network interruption. */ }
      finally {
        loading = false;
        if (poll && !controller.signal.aborted) timer = window.setTimeout(refresh, 5000);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [mediaId]);
  return result && result.mediaId === mediaId ? result.state : undefined;
}

export function dubbingStreamUrl(base: string, language: string, compatible: boolean) {
  if (!language && !compatible) return base;
  const url = new URL(base, "http://localhost");
  if (language) url.searchParams.set("dub", language);
  else url.searchParams.set("compatible", "1");
  return /^https?:\/\//i.test(base) ? url.href : url.pathname + url.search + url.hash;
}

function statusLabel(variant: DubVariant) {
  switch (variant.status) {
    case "ready": return "Dubbed audio";
    case "queued": return "Queued";
    case "running": return `${variant.phase || "Generating"} · ${Math.round(variant.progress)}%`;
    case "error": return "Failed · see plugin settings";
    case "silent": return "No speech detected";
    case "original": return "Original audio";
  }
}

export function PlayerDubbing({ state, selected, busy, open, toggle, select }: {
  state?: MediaDubbing; selected: string; busy: boolean; open: boolean; toggle: () => void; select: (code: string) => void;
}) {
  if (!state?.variants.length) return null;
  const original = state.variants.find((variant) => variant.status === "original");
  return <div className="caption-control">
    <button className={`player-icon-button ${selected ? "active" : ""}`} aria-label="Audio language" aria-expanded={open} title="Audio language" onClick={toggle}><AudioLines/></button>
    {open && <div className="caption-menu"><strong>Audio language</strong>
      <button className={!selected ? "active" : ""} aria-pressed={!selected} disabled={busy} onClick={() => select("")}><span>Original audio{original && <small>{original.label}</small>}</span>{!selected && <Check/>}</button>
      {state.variants.filter((v) => v.status !== "original").map((variant) => <button key={variant.code} className={selected === variant.code ? "active" : ""} aria-pressed={selected === variant.code} disabled={busy || variant.status !== "ready"} onClick={() => select(variant.code)}>
        <span>{variant.label}<small>{statusLabel(variant)}</small></span>{selected === variant.code && <Check/>}
      </button>)}
    </div>}
  </div>;
}
