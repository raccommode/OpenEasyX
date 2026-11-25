# Plugin author guide

Open EasyX plugins add source-specific behavior and optional features. The core never contains a site scraper.

## Trust model

A plugin is trusted server-side JavaScript. It can make network calls and, through the methods EasyX gives it, produce media requests and lifecycle hooks. Administrators must review a plugin before mounting it. The current MVP does not sandbox plugin code.

Plugins must not bypass access controls, DRM, paywalls, authentication, or technical restrictions. They should expose any required credentials as settings, respect rate limits, clearly identify their source, and only return content the configured account is authorized to access.

## Package layout

```text
my-plugin/
└── index.mjs
```

The module default-exports an object that follows `EasyXPlugin` from `@easyx/plugin-sdk`. During development inside this repository, TypeScript plugins may import `definePlugin` directly. External runtime plugins should ship self-contained JavaScript.

## Lifecycle

1. EasyX discovers the directory and validates `manifest`.
2. The administrator explicitly installs the plugin. Required settings are collected first.
3. A successful installation activates it atomically; uninstalling deactivates it.
4. Search-capable plugins participate in unified discovery.
5. Source-capable plugins return profiles for an imported performer.
6. Listing plugins periodically return media candidates.
7. Resolver plugins turn a chosen candidate into an HTTP request or a trusted extractor command.
8. The core streams the response to a partial file, hashes it, deduplicates it, atomically moves it, and calls `afterDownload`.
9. A library-hook plugin may react to downloads or library deletions. Open EasyX itself records a no-redownload tombstone when a tracked file is deleted.

Identity results with the same normalized name are grouped in the UI. The grouped import calls every selected provider, merges its external reference and aliases into one performer, then runs source discovery for each match. A search error is isolated to the failing plugin.

A source-discovery plugin owns the URL's provenance, but it does not automatically become its scraper. Every URL starts as `Reference only`. Installing a plugin never assigns it to any performer. The administrator separately selects an installed plugin with `media-listing` for one URL, then explicitly starts a scan or enables that URL's schedule. A plugin may provide both capabilities, but the core still keeps these two roles separate.

## Manifest

```js
manifest: {
  id: "com.example.feed",
  name: "Example feed",
  version: "1.0.0",
  description: "Reads media from an authorized feed.",
  author: "Example",
  capabilities: ["source-discovery", "media-listing", "download-resolver"],
  sourceUrlPatterns: ["https://example.com/profiles/*"],
  fallback: false,
  polling: {
    mode: "periodic",
    defaultIntervalSeconds: 3600,
    minimumIntervalSeconds: 300
  },
  settings: [
    { key: "token", label: "Access token", type: "password", required: true }
  ]
}
```

IDs must be stable lowercase reverse-domain identifiers. Supported capabilities are:

- `identity-search`
- `source-discovery`
- `media-listing`
- `download-resolver`
- `live-cam`
- `library-hook`
- `subtitle-generation`
- `video-dubbing`

Only declare capabilities the plugin actually implements. `live-cam` exposes direct browser playback inside Open EasyX: implement `resolveLiveStream`, and implement `listLiveCams` when the provider offers a public room directory. Live plugins without a public directory can still contribute configured performer sources.

Providers with an exact room-status endpoint can also implement `getLiveCam(context, cam)`. Return `online: true` for a public broadcast and `online: false` for a confirmed unavailable broadcast; throw on network errors or invalid responses. Open EasyX uses this lookup for local favorites missing from the account snapshot, so creators outside a limited search catalogue are still checked correctly. Failed checks are displayed as status unavailable, separately from confirmed offline rooms.

Library hooks can implement `afterDownload` for outbound notifications, `acceptLibraryDeletion` for inbound deletion notifications, or both. The core owns item state: an accepted relative path is matched to a completed download and recorded as `deleted` without exposing database access to plugin code.

A `subtitle-generation` provider declares its supported languages in `manifest.subtitleLanguages` as an array of `{ code, label }` entries. It implements `importSubtitle(content)` to return validated WebVTT and `runSubtitleWorker(context, options)` to process indexed videos. Open EasyX supplies `dataDir`, `mediaDir`, the active library `databasePath` and the requested translation `languages`. The worker promise stays pending until the worker exits. On `context.signal` abort, stop child processes before resolving. The server waits for that shutdown before starting a worker with new settings. The official implementation in `plugins/subtitles/` shows the job and track schema.

A `video-dubbing` provider declares `manifest.dubbingLanguages` as `{ code, label }` entries and a boolean setting for each language code. Implement `renderDub(context, job, report)` and observe `context.signal` for cancellation. Each job provides the source file, a shared working directory for that video and a temporary MP4 output path for one language. The optional `referenceVideos` array contains up to 32 other locally indexed originals credited to a shared performer, each with `mediaId`, `source` and `fingerprint`. The official plugin checks each speaker acoustically before using a reference. Call `report(phase, percent)` for settings progress. Return `rendered` once the MP4 is complete, `original` when the source is already in the target language, or `silent` when there is no translatable speech. The server publishes completed files and handles retries.

A dubbing provider can set `manifest.dubbingRenderVersion` to identify the algorithm that produced its videos. Changing this value schedules replacement renders for the selected languages. The player keeps the published file available while a replacement is being generated. Providers that animate speech can return `{ outcome: "rendered", lipSyncFrames: count }`. Count each frame once when the voice changes the visible speaker’s mouth. A count of zero identifies an audio-only dub. Providers with optional lip sync can declare a separate revision using `manifest.dubbingLipSyncRenderVersion`. The official provider defaults to the original picture and receives the chosen mode in `job.lipSync`. Providers can list compatible earlier revisions in `manifest.dubbingPreviousRenderVersions`. When a matching publication exists, `job.previousOutput` supplies its read-only local path, render version and recorded lip-sync frame count. Write the upgraded MP4 to `job.output`.

Set `fallback: true` only for a deliberately generic parser such as Web Media. The interface suppresses a fallback when a source-specific plugin exists for that URL, so a generic HTML parser is not presented as equivalent to a working platform extractor.

## URL compatibility and polling

A plugin with `media-listing` should publish `sourceUrlPatterns`. Patterns are full URL globs where `*` matches any sequence. EasyX uses them in both the API and performer UI, so an incompatible plugin is never assigned accidentally. Older plugins without patterns remain compatible with any URL.

`polling.mode` is `periodic` for feeds and pages or `live` for a one-shot live-status check. `defaultIntervalSeconds` is the recommended initial schedule and `minimumIntervalSeconds` is enforced by the core. The minimum cannot be lower than five seconds. Administrators can override the interval per performer URL without going below the plugin minimum.

Live plugins must make `listMedia` a short, idempotent status check and return promptly. They must not keep that call open as a recorder. Continuous stream capture requires a resolver designed for the stream format; polling only controls how often EasyX asks whether new media is available.

## Deduplication and quality

Every media candidate needs a source-stable `externalId`. If several URLs represent the same underlying work, also return the same cross-variant `identityKey` and a numeric `qualityScore`. Return the source publication or creation date as an ISO-compatible `publishedAt` whenever it is available. EasyX retains the candidate with the highest known score while reconciling the oldest reliable date observed across its variants. After download, SHA-256 removes byte-identical duplicates and a conservative perceptual image fingerprint recognizes resized or recompressed copies for the same performer.

For videos, the core also checks whether a newly downloaded excerpt is contained in a longer, completed video for the same performer, including videos from another source. It first searches cached frame fingerprints, then verifies the proposed interval using RGB samples across the entire excerpt. A confirmed excerpt is marked `duplicate` with `duplicateReason: "contained-excerpt"` and `duplicateOf` pointing to the full video. Only the temporary excerpt is discarded; the original file, quality and publication date remain unchanged. Subsequent discovery of that source item does not queue it again.

This check runs after download, so it saves library space rather than the initial network transfer. Fingerprints of older downloads are generated when needed, persist across restarts, and are invalidated when the file changes. Detection is deliberately conservative: it handles continuous, same-speed excerpts between 10 seconds and 30 minutes, against originals up to 6 hours long. It requires varied visual content and near-complete agreement at four samples per second; heavily edited, cropped, very short or static clips may be retained. Audio is not compared. Missing files, unsupported codecs, ambiguous matches and analysis exceeding the two-minute budget preserve the new download. This does not retroactively remove existing excerpts or index manually imported library files.

Suggested quality scoring:

- images: pixel width × pixel height
- videos: pixel area × frame rate, with a small codec/bitrate adjustment
- original files: add a documented source-specific premium

Do not claim two edits or crops are the same identity unless discarding one is safe.

## Storage contract

Plugins do not choose arbitrary output paths. They may suggest a filename. HTTP resolvers return a URL and optional headers. Trusted extractor resolvers may instead return a command request whose arguments contain the literal `{output}` placeholder; EasyX replaces it with a core-controlled partial path. The core sanitizes the final filename and writes under:

```text
<media root>/<performer name>/<source domain>/<filename>
```

Plugins never receive database handles. Return JSON-compatible metadata only. Download headers can contain credentials and are used for that request only; they are not written into the media directory.

## Errors

Throw an `Error` with an operator-friendly English message. A source sync error is recorded on the source and retried on its next schedule. A download error marks the item as failed and lets the administrator requeue it.

## Community repository layout

A repository can contain plugin directories at its root or below `plugins/`:

```text
open-easyx-community-plugins/
├── README.md
└── plugins/
    └── my-plugin/
        └── index.mjs
```

The administrator pastes the Git remote into **Plugins → Repositories → Install new repository**. GitHub, Gitea, Forgejo, GitLab, and generic HTTP(S), SSH, or Git remotes use the same flow. Open EasyX performs a shallow clone under `/data/plugin-repositories`, validates that it contains loadable plugin directories, and then exposes each plugin for a separate explicit installation. Updating a repository never installs its plugins automatically.

## Local installation

For local development, put the plugin directory in `plugins-external/`, then restart the container or call the plugin reload API. Open **Plugins**, review it, provide any required settings, and click **Install & activate**.

See the complete interface in [`packages/plugin-sdk/index.ts`](../packages/plugin-sdk/index.ts) and the inert example in [`examples/plugins/http-feed/index.mjs`](../examples/plugins/http-feed/index.mjs).
