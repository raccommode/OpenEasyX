import { useEffect, useState, type RefObject } from "react";

type SafariElement = HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> };
type SafariVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void; webkitDisplayingFullscreen?: boolean };
type SafariDocument = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void | Promise<void> };

export async function enterPlayerFullscreen(player: SafariElement, video?: SafariVideo | null): Promise<"native" | "page"> {
  try {
    if (player.requestFullscreen) { await player.requestFullscreen(); return "native"; }
    if (player.webkitRequestFullscreen) { await player.webkitRequestFullscreen(); return "native"; }
  } catch { /* Some embedded browsers disallow element fullscreen. Try native video. */ }
  try {
    if (video?.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return "native"; }
  } catch { /* Keep a usable full-window player if the browser refuses native fullscreen. */ }
  return "page";
}

export function usePlayerFullscreen(player: RefObject<HTMLDivElement | null>, video: RefObject<HTMLVideoElement | null>, identity: string) {
  const [fullscreen, setFullscreen] = useState(false);
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const toggleFullscreen = async () => {
    if (!player.current) return;
    const doc = document as SafariDocument; const element = video.current as SafariVideo | null;
    if (pageFullscreen) { setPageFullscreen(false); return; }
    try {
      if (doc.fullscreenElement) { await doc.exitFullscreen(); return; }
      if (doc.webkitFullscreenElement) { await doc.webkitExitFullscreen?.(); return; }
      if (element?.webkitDisplayingFullscreen) { element.webkitExitFullscreen?.(); return; }
    } catch { return; }
    if (await enterPlayerFullscreen(player.current, element) === "page") setPageFullscreen(true);
  };
  useEffect(() => {
    const doc = document as SafariDocument; const element = video.current as SafariVideo | null;
    const changed = () => setFullscreen(Boolean(doc.fullscreenElement === player.current || doc.webkitFullscreenElement === player.current || element?.webkitDisplayingFullscreen));
    const began = () => setFullscreen(true); const ended = () => setFullscreen(false);
    doc.addEventListener("fullscreenchange", changed); doc.addEventListener("webkitfullscreenchange", changed);
    element?.addEventListener("webkitbeginfullscreen", began); element?.addEventListener("webkitendfullscreen", ended);
    changed();
    return () => {
      doc.removeEventListener("fullscreenchange", changed); doc.removeEventListener("webkitfullscreenchange", changed);
      element?.removeEventListener("webkitbeginfullscreen", began); element?.removeEventListener("webkitendfullscreen", ended);
    };
  }, [identity]);
  useEffect(() => { setPageFullscreen(false); }, [identity]);
  useEffect(() => {
    if (!pageFullscreen) return;
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setPageFullscreen(false); }
    };
    window.addEventListener("keydown", escape, true);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", escape, true); };
  }, [pageFullscreen]);
  return { fullscreen: fullscreen || pageFullscreen, pageFullscreen, toggleFullscreen };
}
