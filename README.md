# Open EasyX

Open EasyX is one private, self-hosted application for discovering, downloading, organizing, browsing, and playing media: one Node server, one React application, one Docker container, and one media volume.

## What is included

- performer discovery and source association;
- automatic and manual download queues;
- isolated partial downloads in `media/.downloads`, with restart-from-zero recovery;
- an indexed video and photo library with favorites, history, progress, previews, and statistics;
- direct live-cam aggregation and playback from installed source plugins;
- local subtitle transcription and translation;
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

Plugins are grouped in the UI by what they add:

- **Sources & discovery** — identity search, source discovery, scraping, and download resolution;
- **Live cam** — live directories and stream resolution;
- **Features & addons** — library hooks and other local features.

The official store lives in `plugins/` and cannot be removed. In **Plugins → Repositories**, an administrator can install another Git repository URL. Open EasyX validates and clones it into `/data/plugin-repositories`, loads plugins from either its root or `plugins/`, and lets the administrator update or remove that repository later.

See [docs/PLUGINS.md](docs/PLUGINS.md) for the SDK contract, or start a store from the public [Open EasyX Community Plugins template](https://github.com/raccommode/OpenEasyX-Community-Plugins).

## Persistent paths

| Container path | Purpose |
| --- | --- |
| `/data` | databases, sessions, plugin repository checkouts, thumbnails, subtitles, and models |
| `/media` | completed media library plus private `.downloads` staging |
| `/plugins` | optional legacy read-only local plugin folder |

Important environment variables include `PUID`, `PGID`, `EASYX_SCAN_INTERVAL_MINUTES`, `EASYX_WHISPER_MODEL`, `EASYX_TRANSLATION_MODEL`, and `EASYX_LOG_LEVEL`.

## Container publishing

Every push to `main` runs tests, TypeScript, the production web build, a Docker build, and runtime checks. A successful push automatically creates a `YEAR.WEEK.N` version (for example `2026.35.1`), publishes the multi-architecture image to `ghcr.io/raccommode/open-easyx` with both that version and `latest`, injects the version into the application, and creates the matching GitHub Release. Pull requests run the same checks without publishing a release.

## Responsible use

Only download, retain, and view material you are legally authorized to access. Third-party plugins execute trusted server-side code; review their source before installation.

## License

[MIT](LICENSE)
