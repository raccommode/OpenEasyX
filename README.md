# Open EasyX

Open EasyX is one private, self-hosted application for discovering, downloading, organizing, browsing, and playing media: one Node server, one React application, one Docker container, and one media volume.

## What is included

- performer discovery and source association;
- automatic and manual download queues;
- isolated partial downloads in `media/.downloads`, with restart-from-zero recovery;
- an indexed video and photo library with favorites, history, progress, previews, and statistics;
- direct live-cam aggregation and playback from installed source plugins;
- optional local subtitle transcription, translation and SRT/WebVTT import through the plugin store;
- an official, built-in plugin store;
- additional plugin repositories from GitHub, Gitea, Forgejo, GitLab, or any compatible HTTP(S), SSH, or Git remote;
- integrated browser login for plugins that need an authenticated session.

No bridge, iframe, or second application runs behind Open EasyX.

## Screenshots

### One optimized navigation and media library

![Open EasyX media library](docs/screenshots/library.jpg)

### Built-in and community plugin stores

![Open EasyX plugin repositories](docs/screenshots/plugins.jpg)

## Start with Docker Compose

```bash
mkdir -p data media plugins-external
docker compose up -d
```

Open [http://localhost:3210](http://localhost:3210). The default Compose project starts one container named `open-easyx`.

Completed media is organized below `/media/<performer>/<source>/` by default. In **Settings → Storage**, customize the folder and filename templates for new downloads, with a live example before saving. Existing files are not moved or renamed.

For example, folder `{performer}` and filename `{site}-{date}-{filename}` store files directly in the model's folder while keeping the source in the filename. An empty folder template uses the media volume root. Available variables are `{performer}`, `{site}`, `{filename}` (original name without extension), `{title}`, `{id}`, `{date}`, `{time}`, `{year}`, `{month}`, and `{day}`. Dates use the publication/recording timestamp in UTC. Extensions are added automatically, unsafe path components are rejected, and name collisions receive a suffix without overwriting existing files. Library performer/source metadata is retained independently of the chosen folder layout.

The **Live recording preset** setting defaults to the original stream without re-encoding. Optional presets produce MP4 with H.264 high quality, H.264 smaller files (up to 720p), or H.265/HEVC. Encoding runs after a live recording ends or **Stop and save** is selected; it requires extra CPU and temporary storage. The file is added to the library only after encoding completes. Ordinary video downloads and photos are not re-encoded. If encoding fails, the captured source is kept under `.recording-recovery` and its recovery path is shown in the Activity error.

Active transfers stay below `/media/.downloads` and are never exposed to the library. On restart, interrupted transfers are discarded and queued again from zero.

Live creator favorites are saved locally immediately. Connected-provider synchronization runs in the background with a visible status, and pending changes survive restarts and retry during account synchronization. A provider outage or expired login does not discard a saved local favorite.

## Performer accounts and rescanning

Account URLs cannot be assigned to different performers without review. Adding an already linked Instagram account (including URL case, tracking parameters, or a trailing slash) shows the existing profile and offers **Review merge**. Choose which name to keep, then explicitly confirm. Sources, stored files, favorites, and playback history are retained; the other name becomes an alias. Existing conflicting links also appear on the performer profile. Active scans/downloads must finish before merging.

Each source has a **Hard refresh** button beside **Scrape now**. It rescans from the beginning within the plugin's configured scan limit and restores rediscovered deleted or missing items, following the source/global auto-download settings. Existing files and active downloads are preserved. Normal automatic scans continue to respect deletion history; hard refresh affects the selected source only.

Pornhub account scans use the account's uploads listing (channel video listing for channels) and verify the uploader of each candidate before queuing it. Unrelated recommendations, cast-only matches, and videos whose uploader cannot be verified are skipped. Verification also applies to older queued account videos before downloading. Checking metadata makes account scans slower than a flat playlist scan.

## Chaturbate recording quality and connectivity

In **Plugins → Chaturbate Live**, set **Maximum recording height** to `720`, for example, to prefer a native stream at or below 720p. If the room offers only higher resolutions, the plugin selects the closest available one. `0` selects the best available quality. When the room serves audio and video in separate HLS playlists, FFmpeg preserves their relative timestamps. The [recording API](docs/API.md#starting-a-live-recording) also accepts a quality setting for an individual recording.

To avoid re-encoding, keep **Settings → Live recording preset** on **Original stream — no re-encoding**. The **H.264 — smaller files** preset still performs a CPU-intensive conversion after capture; it is independent of the plugin's native resolution limit. New plugin settings apply to recordings started afterward.

Chaturbate stream extraction uses IPv4 by default to avoid unreachable IPv6 routes in containers. The **Use IPv4 for stream extraction** setting can be disabled on networks requiring IPv6. It applies to yt-dlp's metadata and playlist requests; FFmpeg makes its own connections while capturing. If errors persist, check connectivity from the Open EasyX container and the recording error in Activity.

## Video player gestures and casting

On a phone or tablet the video player supports:

| Gesture | Action |
| --- | --- |
| Tap | show or hide the controls |
| Double tap right / left | skip 10 seconds forward / back (each further quick tap adds 10 seconds) |
| Press and hold on the right | play at 2× while held |
| Pinch with two fingers | zoom in or out (drag with one finger while zoomed; tap the zoom badge to reset) |

With a mouse, a click plays or pauses, a double click toggles fullscreen and holding on the right plays at 2×. The keyboard keeps Space/K, ←/→, M and F.

The cast button sends the video to a TV:

- **Chromecast / Google TV** works in Chrome or Edge when Open EasyX is opened over **HTTPS** (for example through a Synology or Nginx reverse proxy with a certificate); Google only offers its cast API on secure pages. Over plain `http://NAS:3210`, use the browser menu (⋮ → Cast…) to cast the tab.
- **AirPlay** works from Safari on iPhone, iPad and Mac, also over plain HTTP.
- Chrome on Android may also offer its built-in remote playback for the video.

The TV loads the file directly from Open EasyX, so open the app by the NAS address or host name (not `localhost`). Chromecast plays MP4 (H.264/AAC) and WebM; other formats need one of the re-encoding recording presets.

## Local development

Requirements: Node.js 22.5 or newer, Git, FFmpeg, and the downloader helpers used by the plugins you enable.

```bash
npm install
npm run dev
```

Run the full validation suite with:

```bash
npm run check
```

## Plugins and stores

### Local Subtitles

Open **Plugins → Not installed → Features & addons**, then install **Local Subtitles**. The plugin transcribes indexed library videos with Whisper. Open **Plugins → Installed → Local Subtitles → Config** to choose translation languages, check progress or pause automatic generation. The first video that needs transcription downloads the speech dependencies and model. Translation downloads its own dependencies and model when first needed. Audio and transcripts are processed on the server.

Use the **Subtitles** menu in the video player to select a track, import an SRT or WebVTT file, or retry a failed job. Uninstalling the plugin stops processing. Saved subtitle tracks remain playable, and reinstalling restores the saved language choices.

When upgrading from a version with built-in subtitles, install **Local Subtitles** to resume generation using your previous settings. The plugin reuses `/data/subtitles` and `/data/subtitle-models` and installs its Python packages under `/data/subtitle-runtime`. Outside Docker, use FFmpeg, FFprobe and Python 3.11 with virtual environment support. To use an interpreter with the plugin dependencies already installed, set `EASYX_SUBTITLE_PYTHON` to its executable path.

### Source plugins

**ViralXXXPorn** supports public model video collections (`/models/<name>/`), search results (`/search/<query>/`), video lists, and individual `/video/<id>/...` and `/short/<id>/...` pages. Collection scans follow pagination up to **Maximum videos per scan** (100 by default). Downloads refresh the page's public MP4 link and select its highest available resolution. Photo albums and account-restricted videos are not supported.

**DirtyShip** supports performer video collections (`/performer/<name>/`), individual video pages, and full-resolution photo galleries (`/gallery/<name>/`). Both plugins are available in the built-in store; install the plugin, assign it to a performer's source URL, then select **Scrape now**.

Plugins are grouped in the UI by what they add:

- **Sources & discovery** — identity search, source discovery, scraping, and download resolution;
- **Live cam** — live directories and stream resolution;
- **Features & addons** — library hooks and other local features.

The official store lives in `plugins/` and cannot be removed. In **Plugins → Repositories**, an administrator can install another Git repository URL. Open EasyX validates and clones it into `/data/plugin-repositories`, loads plugins from either its root or `plugins/`, and lets the administrator update or remove that repository later.

See [docs/PLUGINS.md](docs/PLUGINS.md) for the SDK contract, or start a store from the public [Open EasyX Community Plugins template](https://github.com/raccommode/OpenEasyX-Community-Plugins).

For JavLibrary, see [Connect FlareSolverr](docs/FLARESOLVERR.md) for an existing instance, the optional Docker Compose service, and connectivity checks.

## Persistent paths

| Container path | Purpose |
| --- | --- |
| `/data` | databases, sessions, plugin repository checkouts, thumbnails, subtitles, and models |
| `/media` | completed media library plus private `.downloads` staging |
| `/plugins` | optional legacy read-only local plugin folder |

Set `EASYX_MAX_CONCURRENT_DOWNLOADS_LIMIT` to a positive integer (default `8`) to raise the ceiling of **Settings → Automation → Maximum concurrent downloads**. Restart the server after changing it, then save the desired concurrency in Settings. Invalid values fall back to 8; the API, input and download queue share the same ceiling.

Stripchat, BongaCams and CAM4 recordings can span short interruptions. `STRIPCHAT_MERGE_GAP_MINUTES`, `BONGACAMS_MERGE_GAP_MINUTES` and `CAM4_MERGE_GAP_MINUTES` default to 10; set any of them to `0` to finalize as soon as its stream ends. BongaCams and CAM4 fall back to the Stripchat value when their own variable is unset. Waiting recordings occupy a download slot. Automatic recording restarts after a completed or failed session, with backoff for short/failed recordings. **Stop and save** keeps what was recorded and records the performer again as a new video on the next check while the room stays live. A cancel or deletion stays suppressed until a successful scan observes the room offline or non-public, including across app restarts; a **hard refresh** of the source lifts it immediately. A cancel that the recording process ignores is forced after 10 seconds. When the app stops, running live recordings are saved first (up to `EASYX_SHUTDOWN_GRACE_SECONDS`, default 60; keep Docker's `stop_grace_period` longer, the compose file uses 90s). Recordings cut off by a crash or a killed container are joined from their recorded parts and stored in the library on the next start; unreadable data is kept in `media/.recording-recovery`.

After 60 seconds without new output (`EASYX_LIVE_STALL_SECONDS`), Stripchat, BongaCams and CAM4 reconnect and retain their captured parts. Empty reconnect attempts stop when the configured merge gap expires. The yt-dlp live plugins and MyFreeCams save a stalled recording at that timeout. They write recoverable Matroska clusters during capture and produce a regular MP4 when the recording finishes. After a crash, startup restores the readable clusters. Activity download time includes connection waits and finalization, whereas video duration measures the captured media.

Some streams drop audio for a moment when a segment goes missing. Open EasyX checks decoded audio timestamps in finished and recovered recordings. With the original-stream preset, it copies healthy tracks without re-encoding. If audio samples are missing, it fills the gaps with silence and copies the video. Set `EASYX_LIVE_AUDIO_SYNC=false` to disable audio repair. Re-encoding presets also apply this sync correction by default.

Important environment variables include `PUID`, `PGID`, `EASYX_SCAN_INTERVAL_MINUTES`, `EASYX_WHISPER_MODEL`, `EASYX_TRANSLATION_MODEL`, and `EASYX_LOG_LEVEL`.

Completed downloads and recovered recordings appear in the library through targeted file indexing. A full scan runs at startup and every **60 minutes** after the previous scan finishes, to find files added or removed outside Open EasyX. Unchanged catalog rows are left untouched. Use **Scan library** for an immediate full scan. `EASYX_SCAN_INTERVAL_MINUTES` changes the automatic interval; existing installations explicitly configured with the old value `10` should change it to `60` or higher.

## Container publishing

Every push to `main` runs tests, TypeScript, the production web build, a Docker build, and runtime checks. A successful push automatically creates a `YEAR.WEEK.N` version (for example `2026.35.1`), publishes the multi-architecture image to `ghcr.io/raccommode/open-easyx` with both that version and `latest`, injects the version into the application, and creates the matching GitHub Release. Pull requests run the same checks without publishing a release.

AMD64 and ARM64 images build concurrently on native GitHub runners, with a separate persistent cache for each architecture. Each image passes the Unraid-style runtime and browser checks before upload; version and `latest` tags are published only after both images and the application tests succeed. Release metadata is added after dependency installation so a new version can reuse the Chromium and Python tool layers.

For a manual validation or cache benchmark without publishing, run the workflow with **Publish image tags and create a release** disabled.

Run the same container checks locally with `bash scripts/docker-runtime-smoke.sh <image> <expected-version>`.

## Responsible use

Only download, retain, and view material you are legally authorized to access. Third-party plugins execute trusted server-side code; review their source before installation.

## License

[MIT](LICENSE)

Settings → Backup exports your performer directory, source URLs, recording priorities, supported app settings and installed plugin IDs. Media files, local portraits, playback history and plugin credentials are excluded. Import merges records by name or linked account, reports conflicts and skipped settings, and keeps the result visible. Back up the data and media volumes separately for a complete recovery.

A performer’s recording priority can be changed under Manage profile. Higher priorities start first and can stop a lower-priority live recording when all slots are occupied; the captured recording is kept. Paused recordings, file downloads and finalization are not interrupted.
