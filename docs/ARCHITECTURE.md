# Architecture

Open EasyX is a single deployable application.

```text
Browser
  └── Open EasyX React application
        ├── workspace, discovery, downloads, logs, plugins
        └── media library, player, live cams, subtitles
              │
              ▼
One Fastify server on :3210
  ├── downloader database and queue
  ├── media catalog and playback database
  ├── plugin manager and Git repository manager
  ├── live stream proxy
  └── subtitle worker supplied by an installed plugin
              │
              ▼
Shared /media and /data volumes
```

The two SQLite databases isolate acquisition state from playback/catalog state, but both are owned by the same server process and stored in the same `/data` volume. A completed queue item is atomically moved out of `/media/.downloads` and immediately indexes that file in the catalog. Replacements and recovered recordings use the same targeted path. Indexing a new file does not walk the rest of the library or change full-scan progress.

A full reconciliation runs at startup and every 60 minutes by default, measured after the previous scan finishes. `EASYX_SCAN_INTERVAL_MINUTES` overrides that interval. Manual scans also defer the next scheduled scan. Full scans discover external additions and removals and refresh metadata; unchanged catalog rows and thumbnails are not rewritten. Files indexed while a full scan is in progress stay visible when that scan finishes.

The server starts the installed subtitle provider when automatic generation is enabled and stops it on uninstall or shutdown. The official Local Subtitles plugin processes the active library database and stores WebVTT tracks under `/data/subtitles`. The player reads registered tracks independently of the provider, including tracks created before an upgrade or uninstall.
