export const recordingPresets = [
  { id: "source", label: "Original stream — no re-encoding", description: "Keep the provider's original quality and codecs. Lowest CPU usage." },
  { id: "h264-high", label: "H.264 — high quality", description: "MP4, H.264 CRF 18, AAC 192 kb/s. Broad device compatibility." },
  { id: "h264-small", label: "H.264 — smaller files (up to 720p)", description: "MP4, H.264 CRF 26, AAC 128 kb/s. Scales down without upscaling." },
  { id: "h265", label: "H.265 / HEVC — efficient storage", description: "MP4, HEVC CRF 26, AAC 128 kb/s. Higher CPU usage; requires an HEVC-compatible player." },
] as const;
export type RecordingPreset = typeof recordingPresets[number]["id"];
export const outputDefaults = { outputPathTemplate: "{performer}/{site}", outputFilenameTemplate: "{filename}", recordingPreset: "source" as RecordingPreset };
export const outputTokens = ["performer", "site", "filename", "title", "id", "date", "time", "year", "month", "day"] as const;
export type OutputSettings = typeof outputDefaults;
export type OutputValues = Record<typeof outputTokens[number], string>;

export function validateOutputTemplate(value: string, kind: "path" | "filename"): string | undefined {
  if (value.length > 300) return "Templates must be at most 300 characters.";
  if (kind === "filename" && !value.trim()) return "The filename template cannot be empty.";
  if (value.startsWith("/") || /[\\<>:"|?*\x00-\x1f]/.test(value)) return "Use a relative path without reserved filename characters.";
  if (kind === "filename" && value.includes("/")) return "Use the folder template to choose directories, not the filename template.";
  for (const match of value.matchAll(/\{([^{}]*)\}/g)) if (!outputTokens.includes(match[1] as typeof outputTokens[number])) return `Unknown variable: {${match[1]}}.`;
  if (/[{}]/.test(value.replace(/\{[^{}]*\}/g, ""))) return "Template variables must use balanced braces.";
  if (value && value.split("/").some((segment) => !segment.trim() || /^[. ]/.test(segment) || /[. ]$/.test(segment))) return "Folder and filename segments cannot be empty, hidden, or end with a dot or space.";
  return undefined;
}

function segment(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/\s+/g, " ").replace(/-\s*-/g, "-").replace(/^[. -]+|[. -]+$/g, "").slice(0, 120) || "unknown";
}

export function outputSettings(values: Record<string, unknown>): OutputSettings {
  return {
    outputPathTemplate: typeof values.outputPathTemplate === "string" ? values.outputPathTemplate : outputDefaults.outputPathTemplate,
    outputFilenameTemplate: typeof values.outputFilenameTemplate === "string" ? values.outputFilenameTemplate : outputDefaults.outputFilenameTemplate,
    recordingPreset: recordingPresets.some((preset) => preset.id === values.recordingPreset) ? values.recordingPreset as RecordingPreset : "source",
  };
}

export function renderOutputPath(settings: OutputSettings, values: OutputValues, extension: string): string {
  for (const [template, kind] of [[settings.outputPathTemplate, "path"], [settings.outputFilenameTemplate, "filename"]] as const) {
    const error = validateOutputTemplate(template, kind); if (error) throw new Error(error);
  }
  const render = (template: string) => segment(template.replace(/\{([^{}]+)\}/g, (_, token: keyof OutputValues) => segment(values[token])));
  const folders = settings.outputPathTemplate ? settings.outputPathTemplate.split("/").map(render) : [];
  const ext = extension.replace(/^\./, "").replace(/[^a-z0-9]/gi, "").slice(0, 12) || "bin";
  return [...folders, `${render(settings.outputFilenameTemplate)}.${ext}`].join("/");
}
