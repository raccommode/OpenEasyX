# HTTP API

The MVP exposes a JSON API under `/api`. It is currently intended for private, authenticated network environments and has no built-in user authentication. Do not expose it directly to the internet.

## System

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Container health and version |
| `GET` | `/api/version` | Version injected into the running image |
| `GET` | `/api/dashboard` | Counts and recent workspace state |
| `GET` | `/api/settings` | Core settings and media root |
| `PUT` | `/api/settings` | Update supported core settings |

## Plugins

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/plugins` | Available plugins and administrator state |
| `POST` | `/api/plugins/:id/install` | Validate settings, install, and activate a discovered plugin atomically |
| `DELETE` | `/api/plugins/:id` | Uninstall and deactivate a plugin while retaining its settings |
| `POST` | `/api/plugins/:id/enable` | Legacy route: enabling installs; disabling uninstalls |
| `PUT` | `/api/plugins/:id/config` | Save manifest-declared settings |
| `POST` | `/api/plugins/:id/test` | Test the configured connection |
| `POST` | `/api/plugins/reload` | Rescan plugin directories |
| `POST` | `/api/plugins/:id/library/deletions` | Let an installed library-hook plugin record a deleted library file |
| `GET` | `/api/plugin-repositories` | List the immutable official store and installed community repositories |
| `POST` | `/api/plugin-repositories` | Validate, clone, and load a compatible Git repository |
| `POST` | `/api/plugin-repositories/:id/refresh` | Fetch the current remote revision and reload its plugins |
| `DELETE` | `/api/plugin-repositories/:id` | Remove a community repository; the official store rejects removal |
| `GET` | `/api/live-cams` | Aggregate live rooms from installed live-cam plugins |
| `GET` | `/api/live-cams/events` | Stream progressive live-provider results with server-sent events |
| `POST` | `/api/live-cams/stream` | Resolve one room to a short-lived proxied live stream |
| `POST` | `/api/live-cams/record` | Queue a live room recording in the ordinary download pipeline |

Password fields are returned as `••••••••`. Sending that sentinel back preserves the stored value.

There is no Viewer bridge plugin. The media library, live service, queue, and plugin manager run in the same Open EasyX server.

## Discovery and library

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/discover?q=name` | Search all enabled identity plugins, group identities, and report each provider status |
| `POST` | `/api/performers/import` | Import one candidate or a grouped set of provider matches |
| `POST` | `/api/performers` | Create a manual performer and its media directory |
| `GET` | `/api/performers` | List performers |
| `GET` | `/api/library-dashboard` | Media-library statistics and shelves |
| `GET` | `/api/library` | Search and paginate indexed photos and videos |
| `GET` | `/api/library/playlist` | Ordered media IDs for player autoplay |
| `GET` | `/api/library-performers` | Performer summaries derived from indexed files |
| `POST` | `/api/scan` | Scan the shared media volume now |
| `GET` | `/api/media/:id` | Media metadata and playback URLs |
| `GET` | `/api/media/:id/stream` | Range-capable local media stream |
| `POST` | `/api/media/delete` | Delete selected files and retain download tombstones |
| `GET` | `/api/performers/:id` | Performer, sources, and items |
| `PATCH` | `/api/performers/:id` | Edit name, aliases, or image and rename its media directory |
| `POST` | `/api/performers/:id/refresh` | Refresh identity, image, and URLs from connected plugins |
| `POST` | `/api/performers/:id/discover-sources` | Run enabled source-discovery plugins |
| `POST` | `/api/performers/:id/sources` | Add a URL and optionally select a compatible scraper plugin |
| `DELETE` | `/api/performers/:id` | Delete metadata only or metadata plus associated media files |

Grouped import body:

```json
{
  "matches": [
    {
      "pluginId": "org.easyx.boobpedia",
      "candidate": {
        "externalId": "Example Performer",
        "name": "Example Performer",
        "aliases": ["Example"]
      }
    },
    {
      "pluginId": "org.easyx.wikidata",
      "candidate": {
        "externalId": "Q123",
        "name": "Example Performer"
      }
    }
  ]
}
```

The former single-match `{ "pluginId", "candidate" }` body remains supported. Discovery provider errors are returned in the `providers` array and do not make the whole search fail.

## Sources and downloads

| Method | Path | Purpose |
| --- | --- | --- |
| `PATCH` | `/api/sources/:id` | Edit a URL, select its scraper, opt into scraping, automate, or reschedule it |
| `DELETE` | `/api/sources/:id` | Remove a source URL and its tracked items |
| `POST` | `/api/sources/:id/sync` | List current media through its selected scraper plugin |
| `GET` | `/api/items` | List up to 500 recent media items |
| `POST` | `/api/items/:id/queue` | Queue an available or failed item |

`pluginId` records the provider that discovered a URL. It is provenance and is never replaced by scraper assignment. New URLs always have no `scraperPluginId` and remain `Reference only`; installing a plugin never assigns it to existing sources. `scraperPluginId` is selected manually for one URL and must name an installed plugin that declares `media-listing` and whose `sourceUrlPatterns` match the URL. `scrapeEnabled` explicitly includes or excludes only that URL from scheduled scraping. Clearing `scraperPluginId` also disables scraping.

`syncIntervalSeconds` is the per-URL schedule. The selected plugin can publish a recommended default and a safe minimum. Values down to five seconds are supported for live-aware plugins. The legacy `syncIntervalMinutes` patch field remains accepted and is converted to seconds.

Example source update:

```json
{
  "scraperPluginId": "com.example.feed",
  "scrapeEnabled": true,
  "autoDownload": false,
  "syncIntervalSeconds": 1800
}
```

Successful API responses are JSON. Errors use:

```json
{ "error": "Operator-friendly message" }
```
