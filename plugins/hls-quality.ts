// Shared HLS quality selection for live recordings.
//
// A performer source can carry a maximum recording height (for example 720). The
// downloader passes it to the plugin as `context.config.recordingMaxHeight`; 0 or a
// missing value means "automatic": the highest quality the room offers.

export type HlsVariant = { url: string; bandwidth: number; height: number };

/** Allowed per-source choices; 0 = automatic (highest available). */
export const RECORDING_HEIGHTS = [0, 2160, 1440, 1080, 720, 480, 360, 240] as const;

/** Maximum recording height from plugin config; 0 when unset or invalid (= highest). */
export function recordingMaxHeight(config: Record<string, unknown> | undefined): number {
  const value = Number(config?.recordingMaxHeight ?? 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function variantHeight(info: string, url: string): number {
  const resolution = /RESOLUTION=\d+x(\d+)/i.exec(info)?.[1];
  if (resolution) return Number(resolution);
  const named = /NAME="?(\d{3,4})p/i.exec(info)?.[1] ?? /[_/-](\d{3,4})p(?:\d+)?(?:[._/-]|$)/i.exec(new URL(url).pathname)?.[1];
  return named ? Number(named) : 0;
}

/** Variant playlists of an HLS master manifest, in manifest order. */
export function parseHlsVariants(manifest: string, baseUrl: string): HlsVariant[] {
  if (!manifest.trimStart().startsWith("#EXTM3U")) return [];
  const variants: HlsVariant[] = []; let info = "";
  for (const raw of manifest.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) { info = line; continue; }
    if (!line || line.startsWith("#") || !/\.m3u8(?:$|\?)/i.test(line)) continue;
    let url: string;
    try { url = new URL(line, baseUrl).toString(); } catch { info = ""; continue; }
    variants.push({ url, bandwidth: Number(/(?:^|[:,])BANDWIDTH=(\d+)/i.exec(info)?.[1] ?? 0), height: variantHeight(info, url) });
    info = "";
  }
  return variants;
}

/**
 * Order variants by preference for a recording. Automatic (0): highest quality first.
 * With a maximum height: the best variant at or below it first, then — when the room
 * offers nothing that small — the closest larger variant, so a recording never fails
 * only because the preferred quality is missing.
 */
export function orderVariantsForRecording<T extends { bandwidth: number; height: number }>(variants: T[], maxHeight = 0): T[] {
  const byQuality = (left: T, right: T) => right.height - left.height || right.bandwidth - left.bandwidth;
  if (!maxHeight || !variants.some((variant) => variant.height > 0)) return [...variants].sort((left, right) => right.bandwidth - left.bandwidth || right.height - left.height);
  const fitting = variants.filter((variant) => variant.height > 0 && variant.height <= maxHeight).sort(byQuality);
  const larger = variants.filter((variant) => variant.height > maxHeight).sort((left, right) => left.height - right.height || right.bandwidth - left.bandwidth);
  const unknown = variants.filter((variant) => variant.height <= 0).sort((left, right) => right.bandwidth - left.bandwidth);
  return [...fitting, ...larger, ...unknown];
}

/** yt-dlp `--format-sort` value for a maximum height (prefers ≤ height, else the closest larger). */
export function ytDlpHeightSort(maxHeight: number): string | undefined {
  return maxHeight > 0 ? `res:${maxHeight}` : undefined;
}
