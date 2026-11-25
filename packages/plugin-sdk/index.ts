export type PluginCapability =
  | "identity-search"
  | "source-discovery"
  | "media-listing"
  | "download-resolver"
  | "live-cam"
  | "video-dubbing"
  | "subtitle-generation"
  | "library-hook";

export type SettingField = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "session";
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  cookieDomains?: string[];
  sessionFormat?: "cookies" | "raw-json";
};

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  capabilities: PluginCapability[];
  /** Supported import languages and translation targets for a subtitle-generation provider. */
  subtitleLanguages?: Array<{ code: string; label: string }>;
  dubbingLanguages?: Array<{ code: string; label: string }>;
  /** Change when existing rendered videos should be regenerated. */
  dubbingRenderVersion?: string;
  /** Alternate render revision when the provider's boolean lipSync setting is enabled. */
  dubbingLipSyncRenderVersion?: string;
  /** Older speech detectors whose silent results should be checked again. An empty string denotes an unversioned result. */
  dubbingRecheckSilentVersions?: string[];
  /** Published revisions of this plugin that renderDub can upgrade directly. */
  dubbingPreviousRenderVersions?: string[];
  settings?: SettingField[];
  browserAuth?: {
    loginUrl: string;
    sessionSetting: string;
    capture?: "cookies" | "onlyfans" | "manyvids" | "authorization-header";
    requestDomains?: string[];
  };
  sourceUrlPatterns?: string[];
  fallback?: boolean;
  polling?: {
    mode: "periodic" | "live";
    defaultIntervalSeconds: number;
    minimumIntervalSeconds: number;
  };
};

export type PersonCandidate = {
  externalId: string;
  name: string;
  aliases?: string[];
  imageUrl?: string;
  profileUrls?: string[];
  metadata?: Record<string, unknown>;
};

export type PerformerRecord = {
  id: string;
  name: string;
  aliases: string[];
  imageUrl?: string;
  externalRefs: Record<string, string>;
};

export type SourceCandidate = {
  externalId: string;
  label: string;
  profileUrl: string;
  domain: string;
};

export type MediaCandidate = {
  externalId: string;
  identityKey?: string;
  title?: string;
  pageUrl?: string;
  mediaType: "image" | "video" | "archive" | "other";
  publishedAt?: string;
  filename?: string;
  qualityScore?: number;
  expectedBytes?: number;
  metadata?: Record<string, unknown>;
};

export type HttpDownloadRequest = {
  kind?: "http";
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  filename?: string;
};

export type CommandDownloadRequest = {
  kind: "command";
  command: string;
  args: string[];
  filename: string;
  /** Write a crash-recoverable Matroska stream to {output} (or {output}.part) for the queue to finalize as MP4. */
  liveCaptureContainer?: "matroska";
  /** Wrappers that finalize output themselves must exit successfully, even after a stop. */
  requireSuccessfulExit?: boolean;
};

export type DownloadRequest = HttpDownloadRequest | CommandDownloadRequest;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type PluginContext = {
  config: Record<string, unknown>;
  signal?: AbortSignal;
  fetch: typeof globalThis.fetch;
  runCommand: (command: string, args: string[], options?: { timeoutMs?: number; maxOutputBytes?: number }) => Promise<CommandResult>;
  log: (level: "debug" | "info" | "warn" | "error", message: string, details?: unknown) => void;
};

export type MediaSource = {
  id: string;
  externalId: string;
  performerId: string;
  profileUrl: string;
  domain: string;
};

export type CompletedDownload = {
  absolutePath: string;
  relativePath: string;
  mediaType: string;
  checksumSha256: string;
};

export type LibraryDeletion = {
  relativePath: string;
};

export type SubtitleWorkerOptions = {
  dataDir: string;
  mediaDir: string;
  databasePath: string;
  /** Translation targets in addition to the original transcription. */
  languages: string[];
};

export type LiveCamQuery = {
  page: number;
  pageSize: number;
  search?: string;
  gender?: "female" | "male" | "couple" | "trans";
};

export type LiveCam = {
  id: string;
  username: string;
  title?: string;
  pageUrl: string;
  thumbnailUrl?: string;
  profileImageUrl?: string;
  viewers?: number;
  age?: number;
  gender?: string;
  tags?: string[];
  online?: boolean;
  statusUnavailable?: boolean;
};

export type LiveCamPage = {
  cams: LiveCam[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type LiveCamFavoriteSnapshot = {
  cams: Array<LiveCam & { online: boolean }>;
  authoritative: boolean;
  skippedReason?: string;
};

export type LiveCamFavoriteUpdate = {
  synchronized: boolean;
};

export type LiveStream = {
  url: string;
  audioUrl?: string;
  headers?: Record<string, string>;
  contentType?: string;
};

export type DubbingReferenceVideo = { mediaId: string; fingerprint: string; source: string };

export type DubbingJob = {
  mediaId: string;
  fingerprint: string;
  source: string;
  dataDir: string;
  workDir: string;
  output: string;
  language: string;
  /** Selected at dispatch for providers with an optional lip-sync renderer. */
  lipSync?: boolean;
  /** Read-only publication for this source, provider and language. Write the replacement to output. */
  previousOutput?: { path: string; renderVersion: string; lipSyncFrames?: number };
  /** Other local videos credited to the same performers. Confirm speaker identity from the audio. */
  referenceVideos?: DubbingReferenceVideo[];
};

export type DubbingResult = "rendered" | "original" | "silent" | { outcome: "rendered"; lipSyncFrames?: number };

export interface EasyXPlugin {
  renderDub?(context: PluginContext, job: DubbingJob, report: (phase: string, progress: number) => void): Promise<DubbingResult>;
  manifest: PluginManifest;
  testConnection?(context: PluginContext): Promise<{ ok: boolean; message: string }>;
  searchPeople?(context: PluginContext, query: string): Promise<PersonCandidate[]>;
  discoverSources?(context: PluginContext, performer: PerformerRecord): Promise<SourceCandidate[]>;
  listMedia?(context: PluginContext, source: MediaSource): Promise<MediaCandidate[]>;
  resolveDownload?(context: PluginContext, item: MediaCandidate): Promise<DownloadRequest>;
  listLiveCams?(context: PluginContext, query: LiveCamQuery): Promise<LiveCamPage>;
  /** Look up one exact room, including its offline status, without catalogue search. */
  getLiveCam?(context: PluginContext, cam: LiveCam): Promise<LiveCam>;
  listFollowedLiveCams?(context: PluginContext): Promise<LiveCamFavoriteSnapshot>;
  setLiveCamFavorite?(context: PluginContext, cam: LiveCam, favorite: boolean): Promise<LiveCamFavoriteUpdate>;
  resolveLiveStream?(context: PluginContext, cam: LiveCam): Promise<LiveStream>;
  afterDownload?(context: PluginContext, download: CompletedDownload): Promise<void>;
  acceptLibraryDeletion?(context: PluginContext, deletion: LibraryDeletion): Promise<LibraryDeletion>;
  /** Run until the host aborts context.signal, then release all child processes. */
  runSubtitleWorker?(context: PluginContext, options: SubtitleWorkerOptions): Promise<void>;
  /** Convert an uploaded subtitle document into WebVTT for the library player. */
  importSubtitle?(content: string): string;
}

export function definePlugin(plugin: EasyXPlugin): EasyXPlugin {
  return plugin;
}
