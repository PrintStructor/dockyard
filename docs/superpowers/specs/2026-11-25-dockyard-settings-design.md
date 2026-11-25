# DOCKYARD Settings & Multi-Printer Profiles — Design Specification

Date: 2026-11-25  
Status: Draft (awaiting review & approval)  
Selected Approach: **Approach A — Mainsail-Style Settings Modal + Server-Persisted Printer Profiles with Live Hot-Reload**

---

## 1. Intent & Why

DOCKYARD is currently configured exclusively via server-side environment variables / `.env.local` (`PRINTER_URL`, `PRINTER_NAME`, `VITE_MAINSAIL_URL`, `ALLOWED_ORIGINS`) and hardcoded camera endpoints (`/webcam`, `/webcam2`). Changing a printer's IP address requires SSH access, editing `.env.local`, and restarting `dockyard.service`.

Two concrete real-world needs drive this feature:
1. **Fast IP changes on the road (Meets / Expos / DHCP changes):** When bringing a VORON and laptop/iPad to a 3D-printing Meet, the printer gets a new local IP. The user must be able to open Settings directly in DOCKYARD — **even while the printer is offline** — enter the new IP/URL, test the Moonraker connection, and save with immediate live reconnection (zero SSH, zero service restart).
2. **Managing a personal fleet (e.g. 5 VORONs):** The user owns 5 VORON printers and wants to store each machine as a named profile (name, subtitle, Moonraker URL, Mainsail link, cameras) and switch the active printer in one click, similar to Mainsail's familiar settings & printer workflow.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- Provide a Mainsail-familiar **Settings modal** reachable from the top masthead (`⚙`) at all times, including when the printer is offline/unreachable.
- Persist **server-side printer profiles & network settings** in a local, git-ignored JSON file (`.dockyard-settings.json`, overridable via `DOCKYARD_SETTINGS_PATH`), seeded from existing environment variables on first run.
- Support **hot-reloading** the active printer URL, name, subtitle, Mainsail URL, cameras, and allowed origins **without restarting the Node server**.
- Provide a read-only **"Test connection" (`Verbindung testen`)** action that probes Moonraker (`/server/info` + `/printer/info`) and displays Moonraker version, Klippy state, hostname, and round-trip latency before saving.
- Support **1-click switching between saved printer profiles** both inside Settings and via a quick-switcher dropdown on the masthead printer pill (when > 1 profile exists).
- Centralize **per-device UI preferences** (language DE/EN, 7" Display/Touch mode, hide cameras on this device, default start tab) inside the same Settings modal.
- Provide **JSON export/import** for backing up and transferring saved printer profiles.
- Make **Meet LAN access** practical without weakening default security: keep strict loopback + explicit `ALLOWED_ORIGINS` by default, while allowing an opt-in **Meet / LAN Mode** (`allowLanOrigins`) restricted to same-origin private LAN / `.local` addresses.

### Non-Goals
- **Simultaneous multi-printer dashboard / parallel WebSockets:** DOCKYARD stays focused on **one active printer at a time** per server instance (Approach C was rejected as unnecessary complexity for the current workflow).
- **Editing Moonraker's `mainsail.presets` database or Klipper `printer.cfg` inside Settings:** Klipper config editing already lives in `System → Konfiguration`; temperature presets remain read from Moonraker DB (Settings may show an informational summary/link only).
- **Changing Node's listening `HOST` / `PORT` live at runtime:** Binding a new TCP socket requires restarting the process; Settings displays `HOST:PORT` read-only with a short note.
- **Per-printer custom 3D CAD `.glb` upload:** The 3D toolhead/printer scene remains the shipped DOCKYARD CAD scene; non-6-tool VORONs degrade gracefully using existing optional status fields while `Controls`, `Print`, `History`, `Cameras`, `Console`, and `System` work with any Klipper/Moonraker printer.

### Anti-Goals (Failure Conditions)
- **Never display stale telemetry from Printer A under Printer B's name** after switching printers or changing `PRINTER_URL`.
- **Never leak private IPs or `.dockyard-settings.json` into Git** or wipe `.dockyard-settings.json` during `scripts/deploy-pi.sh`.
- **Never silently break existing `.env.local` setups or existing 109 unit tests.**
- **Never introduce SSRF vectors or remove CSRF protections** (`X-Cockpit-Request: 1`, `Content-Type: application/json`, strict `origin.host === req.headers.host`, HTTP(S)-only URL validation).
- **Never send mutating commands to any physical printer** when testing connections or editing settings.

---

## 3. Constraints

- **Visual Design (`DESIGN.md`):** Restrained dark technical cockpit — flat graphite surfaces (`#111618` bg, `#192125` surface, `#1b252a` scene), thin `1px` cool borders (`#354147`), `#c5f76b` lime selection/focus, `#283522` lime-tint active fills, `#f3c67b` amber warnings, bundled `Onest` font everywhere, tabular numerals for IPs/ports/latencies, **zero decorative CSS box-shadows**, native `<dialog>` with dark translucent backdrop.
- **Responsive & 7" Touch:** Must work cleanly on Desktop (`1440px+`), Tablet/iPad (`768–1150px`), Mobile (`390px`), and 7" KlipperScreen Display Mode (`display-mode` class, 44px touch targets).
- **Bilingual (DE/EN):** Primary source strings in natural German with complete English translations in `src/locales/en.json`.
- **Dual Runtime Parity:** Must work identically under both `npm run dev` (Vite `configureServer` middleware) and `npm start` (`server/start.mjs` standalone HTTP server).

---

## 4. Approaches Considered

| Approach | Summary | Trade-offs | Decision |
|---|---|---|---|
| **A. Mainsail-Style Settings Modal + Server Printer Profiles + Live Hot-Reload** | Gear button (`⚙`) in masthead opens a native `<dialog>` with 4 categories (`Drucker & Verbindung`, `Kameras`, `Oberfläche`, `Netzwerk & Backup`), plus 1-click quick-switcher on the masthead printer pill when >1 printer is saved. Server persists `.dockyard-settings.json` and hot-reloads WebSocket/caches on save or switch. | All connected browsers share one active printer on the DOCKYARD server; ideal for 1 workplace / Meet setup and keeps API & safety locks clean. | **Selected by user** |
| **B. 5th Sub-Tab inside `System` (`#system/settings`)** | Same backend store & hot-reload, rendered inline inside `SystemView.vue`. | Slightly less UI chrome, but buried 2 clicks deep and forces leaving `Tools`/`Print`. | Rejected |
| **C. Parallel Multi-Instance Routing (`/api/p/:id/...`)** | Server holds up to 5 concurrent Moonraker WebSockets & independent job locks per browser tab. | True simultaneous farm wallboard, but requires rewriting all API endpoints, live feeds, job guards, and tests. | Rejected |

---

## 5. Data Model & Persistence

### 5.1 Settings File Location & Atomic Writes
- Default path: `<repo-root>/.dockyard-settings.json`.
- Override via `process.env.DOCKYARD_SETTINGS_PATH` (essential for isolated unit tests and custom Pi deployments).
- `.dockyard-settings.json` and `.dockyard-settings.json.tmp` are added to `.gitignore`.
- Persistence uses atomic write-and-rename (`writeFile(tmpPath, json, { mode: 0o600 })` → `rename(tmpPath, filePath)`).
- **First-run bootstrap (no file yet):** Builds default settings in memory from existing environment variables (`PRINTER_URL`, `PRINTER_NAME`, `VITE_MAINSAIL_URL` or `MAINSAIL_URL`, `ALLOWED_ORIGINS`, `ALLOW_LAN_ORIGINS`) without writing to disk until the user explicitly saves or switches settings.

### 5.2 JSON Schema (`version: 1`)
```json
{
  "version": 1,
  "activePrinterId": "stormtrooper",
  "printers": [
    {
      "id": "stormtrooper",
      "name": "STORMTROOPER",
      "subtitle": "VORON 2.4 / 6-Toolchanger",
      "url": "http://127.0.0.1",
      "mainsailUrl": "auto",
      "cameras": [
        {
          "id": "tophat",
          "name": "Tophat",
          "description": "Blick von oben",
          "service": "camera-streamer",
          "url": "/webcam",
          "snapshotUrl": "",
          "enabled": true,
          "preferredMode": "webrtc"
        },
        {
          "id": "heatbed",
          "name": "Druckbett",
          "description": "Blick auf das Druckbett",
          "service": "camera-streamer",
          "url": "/webcam2",
          "snapshotUrl": "",
          "enabled": true,
          "preferredMode": "webrtc"
        }
      ]
    }
  ],
  "network": {
    "allowedOrigins": [],
    "allowLanOrigins": false
  }
}
```

### 5.3 Validation, Security & Normalization Rules
- **`printers`:** Non-empty array, 1..20 entries. Each `id` must match `/^[a-z0-9][a-z0-9_-]{0,31}$/` and be unique. Server generates clean slug IDs automatically when creating a printer if omitted (e.g. `voron-24`, `voron-24-2`).
- **`activePrinterId`:** Must exist in `printers`. Cannot delete the last remaining printer; if a save removes the previously active printer while others remain, `activePrinterId` must point to one of the remaining profiles (the Settings UI automatically selects the first remaining profile upon confirmed deletion).
- **`name`:** String trimmed, 0..40 chars (empty string hides the masthead badge pill, preserving existing `PRINTER_NAME=""` behavior).
- **`subtitle`:** String trimmed, 0..64 chars (defaults to `'VORON 2.4 / 6-Toolchanger'`; empty hides the subtitle line).
- **`url` (Printer Moonraker/nginx origin):**
  - User convenience normalization: if input has no scheme (e.g. `192.168.1.50` or `voron.local:7125`), prepend `http://`; strip trailing slashes.
  - Strict validation: must parse as `http:` or `https:` origin with **no username, no password, no non-root pathname, no search, no hash** (same strict origin contract as `parseHttpOrigin` in `server/config.mjs`, now allowing `https:` as well as `http:`).
  - **SSRF & TLS Policy (Engineering Call):** Allow local LAN, loopback, Tailscale/WireGuard VPNs, and valid FQDNs (so remote/VPN setups work out of the box), while enforcing: (1) `sameOriginRequest(req)` on all write/test endpoints, (2) explicit blocklist rejecting cloud metadata endpoints (`169.254.169.254`, `169.254.170.2`, `metadata.google.internal`, `fd00:ec2::254`), (3) `redirect: 'error'` on upstream probes/fetches, (4) fixed Moonraker API paths only, and (5) standard Node CA verification for `https://` / `wss://` (no `rejectUnauthorized: false`; users with custom local CAs can use `NODE_EXTRA_CA_CERTS`).
- **`mainsailUrl`:** Either `'auto'` / `''` (auto-derive from printer origin or browser host — see §6.4), OR a valid `http://` / `https://` URL (no credentials, max 256 chars).
- **`cameras`:** 0..6 entries per printer.
  - `id`: unique per printer, `/^[a-z0-9][a-z0-9_-]{0,31}$/`.
  - `name`: trimmed 1..40 chars; `description`: trimmed 0..80 chars.
  - `service`: `'camera-streamer' | 'mjpeg'` (default `'camera-streamer'`):
    - **`camera-streamer`** (standard Crowsnest/MainsailOS `camera-streamer`, e.g. `/webcam`, `/webcam2`): `url` is a clean base prefix (relative `/...` without `..`/`//`/query/hash, OR full `http(s)://...` without credentials/query/hash); proxy appends `/webrtc`, `/stream`, `/snapshot`.
    - **`mjpeg`** (Crowsnest `ustreamer` e.g. `/webcam/?action=stream`, or standalone IP camera MJPEG URL): `url` is the direct stream path/URL (query parameters allowed; no credentials, no `..`, no hash, blocked metadata hosts rejected); optional `snapshotUrl` (same rules, e.g. `/webcam/?action=snapshot`) serves `/api/camera/:id`; `/webrtc` returns `404` so `useCameras.js` runs directly in MJPEG mode!
  - `enabled`: boolean; `preferredMode`: `'webrtc' | 'mjpeg'` (forced to `'mjpeg'` when `service === 'mjpeg'`).
- **`network.allowedOrigins`:** 0..24 valid `http://` / `https://` origins (deduplicated; merged at runtime with env `ALLOWED_ORIGINS`, which are shown read-only as "aus `.env.local` / Umgebung").
- **`network.allowLanOrigins`:** Boolean persisted in `.dockyard-settings.json` (default `false`).
  - **Env Override Precedence (Engineering Call):** If `ALLOW_LAN_ORIGINS=1` or `true` is set in `.env.local` / process environment, it acts as a **runtime OR-override** (`envAllowLanOrigins: true`, just like `envAllowedOrigins`), guaranteeing that the recovery instruction in the lockout banner always works even after `.dockyard-settings.json` exists. In the Settings UI, the toggle renders checked & disabled with an `"Über Umgebung (ALLOW_LAN_ORIGINS) aktiv"` note while the env override is active. If unset/empty, `.dockyard-settings.json` controls `allowLanOrigins` freely.

### 5.4 Browser-Local Preferences (`localStorage`)
Stored strictly in the client browser (not in `.dockyard-settings.json`), surfaced in the **Oberfläche** settings tab:
- `dockyard.language` (`'de' | 'en'`) — existing `src/i18n.mjs`
- `dockyard.displayMode` (`'0' | '1'`) — existing `src/display-mode.mjs`
- `dockyard.camerasHidden` (`'0' | '1'`) — existing `src/display-mode.mjs` (now gets a direct toggle in Settings → Kameras & Oberfläche!)
- `dockyard.defaultTab` (`'tools' | 'controls' | 'print' | 'history' | 'cameras' | 'console' | 'system'`, default `'tools'`) — used when loading `/` with no explicit `#hash`!

---

## 6. Backend Architecture & API

### 6.1 New Module: `server/settings.mjs`
Responsibilities:
- Owns pure validators/normalizers (`normalizePrinterOrigin`, `normalizeCameraUrl`, `normalizeMainsailSetting`, `validateSettingsPayload`, `slugifyId`, `isPrivateLanHostname`).
- Manages singleton runtime store: `loadSettings()`, `getSettings()`, `getActivePrinter()`, `getEffectiveAllowedOrigins()`, `isLanOriginAllowed()`, `updateSettings(next)`, `switchActivePrinter(id)`, `onSettingsChange(listener)`.
- Supports testability via `createSettingsStore({ filePath, env })` factory so unit tests run completely isolated in temp directories with zero shared state.

### 6.2 Origin Security (`sameOriginRequest` in `server/control.mjs`)
- Read `getEffectiveAllowedOrigins()` and `isLanOriginAllowed()` dynamically per request instead of reading a frozen startup array (while still accepting the optional `extraAllowedOrigins` argument so existing unit tests stay 100% compatible).
- When `allowLanOrigins` is `true`, permit `origin` if and only if:
  1. `origin.protocol === 'http:' || origin.protocol === 'https:'`
  2. `origin.host === req.headers.host` (strict same-origin!)
  3. `isPrivateLanHostname(origin.hostname)` is `true` — strictly RFC1918 IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), IPv4 link-local (`169.254.0.0/16`), IPv6 loopback/ULA/link-local (`::1`, `fc00::/7`, `fe80::/10`), single-label hostnames, or `.local` / `.lan` / `.home` / `.internal` mDNS hostnames.
  4. Request still carries `X-Cockpit-Request: 1` and `Content-Type: application/json`.
- Also expose a helper `isOriginWriteAllowed(req)` used by `GET /api/settings` so the UI knows whether the current browser origin can save settings, and displays a clear amber banner with the current origin if writes are blocked (e.g. opened from a new Meet iPad before enabling Meet Mode).

### 6.3 HTTP Endpoints (in `server/printer.mjs`)
All `POST` endpoints enforce `sameOriginRequest(req)`.

1. **`GET /api/settings`** (always available — never depends on Moonraker being online):
   Returns:
   ```json
   {
     "version": 1,
     "activePrinterId": "stormtrooper",
     "activePrinter": { "...": "..." },
     "printers": [ "..." ],
     "network": {
       "allowedOrigins": [],
       "envAllowedOrigins": [],
       "allowLanOrigins": false,
       "envAllowLanOrigins": false
     },
     "runtime": {
       "host": "127.0.0.1",
       "port": 4173,
       "requestOrigin": "http://127.0.0.1:4173",
       "canWrite": true
     }
   }
   ```
2. **`POST /api/settings`** (body: `{ activePrinterId, printers, network, confirmSelfLockout? }`, max 64 KB):
   - Validates and normalizes everything cleanly (returns `400` with descriptive German error message on invalid field).
   - **Self-Lockout Guard (Engineering Call):** If the requesting origin is non-loopback and the proposed `network` settings would make `sameOriginRequest(req)` return `false` for the requesting client itself, return `400` (`code: 'SELF_LOCKOUT'`) unless `confirmSelfLockout === true` is explicitly passed.
   - If the active printer's `url` or `activePrinterId` changes while an active (non-uncertain) `currentJob` or `activeUpdateJob?.running` is in progress → returns `409 Conflict` explaining that an active cockpit job/update is still running.
   - Atomically saves `.dockyard-settings.json`, triggers runtime hot-reload, returns `200` with updated `GET /api/settings` payload + `{ printerUrlChanged: boolean, activePrinterChanged: boolean }`.
3. **`POST /api/settings/switch`** (body: `{ printerId }`, max 4 KB):
   - Fast 1-click active printer switch; enforces the same active-job `409` guard when `url` or `printerId` changes, saves atomically, triggers hot-reload, returns `200` with updated settings payload + `{ printerUrlChanged: boolean, activePrinterChanged: boolean }`.
4. **`POST /api/settings/test`** (body: `{ url }`, max 4 KB):
   - Validates/normalizes `url` via `normalizePrinterOrigin` (including cloud-metadata SSRF blocklist).
   - Performs read-only `GET <url>/server/info` (3.5 s timeout, `redirect: 'error'`) and, if reachable, `GET <url>/printer/info` (2.5 s timeout, `redirect: 'error'`).
   - Never mutates any printer state. Returns `200` with `{ ok: true, url, latencyMs, moonrakerVersion, klippyState, hostname, softwareVersion }` OR `200` with `{ ok: false, url, latencyMs, error }` (using HTTP 200 for structured probe results while reserving HTTP 400 for malformed/blocked URL input).
5. **Cross-Printer Safety Guard on `POST /api/system/config/save` (Engineering Call):**
   - Accept optional `expectedPrinterId` in the payload (always sent by `ConfigEditor` once loaded). If present and `expectedPrinterId !== getActivePrinter().id`, reject with `409 Conflict` (`code: 'PRINTER_CHANGED'`) so edits made for Printer A can never be saved onto Printer B.

### 6.4 Runtime Hot-Reload Mechanics
Replace static `printer` and `printerName` constants across `server/printer.mjs`, `server/live.mjs`, and `server/materials.mjs`:
- `server/live.mjs`: accept `getPrinter: () => string` (falling back to static `printer` string for backward test compatibility), add `reconnect()` (closes existing WS, resets `raw = {}`, `ready = false`, emits `offline`, immediately opens new WS if SSE clients exist) and `emitSettings(payload)` (`event: settings`).
- `server/materials.mjs`: accept `getPrinter` (or string) and expose `reset()` method to drop cached file metadata when switching printers.
- `server/printer.mjs`:
  - Every upstream `fetch(...)`, `http.get(...)`/`https.get(...)`, `executeGcodeScript(...)`, `executeMoonrakerRpc(...)`, and `fetchGcodeMeshBinary(...)` reads `getActivePrinter().url` and uses `redirect: 'error'`.
  - Support both `http:` and `https:` (`import https from 'node:https'`) for MJPEG stream & log download streaming.
  - `normalized(raw)` attaches `printerName: active.name`, `printerSubtitle: active.subtitle`, `activePrinterId: active.id`.
  - **Per-Printer `uncertain` Interlock & `activeUpdateJob` Scoping (Engineering Call):**
    - Store `uncertain` jobs in a `Map<printerId, uncertainJob>` (`uncertainJobsByPrinter`) instead of one global `currentJob`. `getControlState()` returns the running `currentJob` or `uncertainJobsByPrinter.get(activePrinter.id) ?? null`. Switching A → B never shows Printer A's recovery banner on Printer B, and switching back to A preserves A's unacknowledged safety interlock (and keeps it even if A's Meet DHCP IP is updated!).
    - When `activePrinterChanged` or `printerUrlChanged`: clear finished `activeUpdateJob` (`if (activeUpdateJob && !activeUpdateJob.running) activeUpdateJob = null`), clear `lastResult = null`.
  - When `printerUrlChanged === true` or `activePrinterChanged === true`:
    - Reset `configCache = null`, `effectObjects = []`, `fanObjects = []`, `capabilityCache = null`, `capabilityAt = 0`, `gcodeFileSetCache = null`, `gcodeFileSetAt = 0`, `liveCapabilityRef = { ...reset }`, `readMaterials.reset()`.
    - Scope `gcode-mesh.mjs` in-memory mesh cache keys by `${printerUrl}:${filename}:${tag}` so switching printers never serves another printer's cached G-code mesh.
    - Emit `live.emitSettings({ ...publicSettings, printerUrlChanged, activePrinterChanged })`, then call `live.reconnect()` (when `printerUrlChanged || activePrinterChanged`).
  - When only cosmetic/camera/network fields change (`!printerUrlChanged && !activePrinterChanged`):
    - Emit `live.emitSettings({ ...publicSettings, printerUrlChanged: false, activePrinterChanged: false })` and `live.notify()` so connected browsers update badge/subtitle/cameras immediately with zero disconnect!
- **Dynamic Camera Routing (`/api/camera/:id`, `/api/camera/:id/stream`, `/api/camera/:id/webrtc`):**
  - Match `^\/api\/camera\/([a-z0-9][a-z0-9_-]{0,31})(?:\/(stream|webrtc))?$`.
  - Look up `id` in `getActivePrinter().cameras.filter(c => c.enabled)`. Return `404` if unknown or disabled.
  - Resolve upstream target by `cam.service`:
    - `camera-streamer`: base = `cam.url.startsWith('/') ? activePrinter.url + cam.url : cam.url`; append `/webrtc`, `/stream`, or `/snapshot`.
    - `mjpeg`: `/webrtc` returns `404` (signaling direct MJPEG); `/stream` resolves `cam.url` (`cam.url.startsWith('/') ? activePrinter.url + cam.url : cam.url`); snapshot `/` resolves `cam.snapshotUrl` if set (else `404`).
- **Dynamic Mainsail Link (`src/printer-ui-url.mjs`):**
  - When `activePrinter.mainsailUrl` is explicit (`http(s)://...`), use it directly.
  - When `'auto'` or empty: if `activePrinter.url` is NOT loopback (`127.0.0.1` / `localhost` / `[::1]`), default to `${activePrinter.url}/` (huge UX win when DOCKYARD runs on a laptop pointing at a Meet IP like `http://192.168.50.22` — "Mainsail öffnen" now actually opens `http://192.168.50.22/` instead of `http://localhost/`!); if `activePrinter.url` IS loopback, derive `http(s)://<browser-hostname>/` (preserving Pi self-hosted behavior!).

---

## 7. Frontend Architecture & UX Design

### 7.1 Masthead Entry Points (`src/App.vue`)
1. **Settings Gear Button (`⚙`):** Added to `.header-meta` next to the Display Mode toggle and Language selector, styled with `.icon-button`, accessible label `Einstellungen` / `Settings`, **never disabled when offline**. Clicking opens `SettingsDialog`.
2. **Quick Printer-Profile Switcher on `.brand-printer-pill`:**
   - When `printers.length > 1`, `.brand-printer-pill` becomes a compact interactive button (`STORMTROOPER ▾`) that opens a lightweight flat graphite popover listing all saved printers (name, host/IP, active lime dot) for 1-click switching, plus a footer action `"Drucker verwalten …"` that opens Settings → Drucker & Verbindung.
   - When `printers.length === 1`, clicking the pill directly opens Settings → Drucker & Verbindung (subtle hover affordance, zero visual clutter).
3. **Offline Connection Banner Action:** When `connection === 'offline'` or `'stale'`, add a compact `"IP / Verbindung anpassen"` button right in the offline status banner so arriving at a Meet with a changed IP is literally **1 click from the error banner straight into the IP field**!
4. **Dynamic Brand Subtitle:** Renders `activePrinter.subtitle` (default `VORON 2.4 / 6-Toolchanger`; formatted cleanly if `/` is present) instead of hardcoded text.

### 7.2 Settings Modal (`src/components/SettingsDialog.vue`)
Native `<dialog>` with flat graphite surfaces (`#111618` outer frame, `#192125` panels, `1px solid #354147`), zero box-shadow, dark translucent `::backdrop`, Escape-to-close (confirming if unsaved edits exist).

**Layout:**
- Header bar: Title `Einstellungen` + active printer pill + close button (`✕`).
- Left sidebar (210px on desktop; horizontal scrollable segmented strip on `< 760px` / 7" Display Mode) with 4 tabs:
  1. **`Drucker & Verbindung`** (`Server` / `Printer` icon)
  2. **`Kameras`** (`Camera` icon)
  3. **`Oberfläche`** (`SlidersHorizontal` icon)
  4. **`Netzwerk & Backup`** (`Shield` / `Network` icon)
- Sticky footer bar (on server-backed tabs): unsaved status hint, `Verwerfen` (`Reset`), and primary lime **`Speichern`** button (disabled when clean, saving, or `!canWrite`).

**Tab Details:**
1. **`Drucker & Verbindung`:**
   - **Saved Printers List** (top compact strip or cards): each profile shows name, host/IP (tabular numerals), active lime badge (`Aktiv`), and quick actions (`Aktivieren`, `Bearbeiten`, `Duplizieren`, `Löschen`), plus `+ Drucker hinzufügen`.
   - **Selected Profile Editor Form:**
     - `Druckername (Badge)` (optional, placeholder `z. B. STORMTROOPER` — hint: leer lassen blendet Badge aus)
     - `Untertitel` (placeholder `z. B. VORON 2.4 / 6-Toolchanger`)
     - `Moonraker / Drucker-URL` (placeholder `http://192.168.1.50` oder `voron.local`) + inline **`Verbindung testen`** button!
       - Result pill inline below URL:
         - Success (lime-tinted): `✓ Erreichbar · 18 ms · Moonraker v0.9.3 · Klipper ready · voron-pi`
         - Failure (amber-tinted): `Nicht erreichbar · <klarer Fehlertext>`
     - `Mainsail-Link` (`auto` oder volle URL, mit Erklärung wann automatisch abgeleitet wird)
2. **`Kameras`:**
   - List of cameras for the currently edited printer profile (defaults to `Tophat` `/webcam` and `Druckbett` `/webcam2`).
   - Per camera: Aktiv-Toggle, Name, Beschreibung, Dienst-Typ (`camera-streamer (WebRTC + MJPEG)` oder `ustreamer / Direkt-MJPEG`), Pfad/URL (`/webcam` bzw. `/webcam/?action=stream` oder `http://...`), optional Snapshot-URL (bei `mjpeg`), Standard-Stream (`WebRTC` / `MJPEG`, bei `mjpeg` fest auf `MJPEG`), Entfernen-Button.
   - `+ Kamera hinzufügen` (up to 6).
   - Compact device-local card below: Toggle **"Kameras auf diesem Gerät ausblenden"** (directly bound to `camerasHiddenPreference` / `setCamerasHidden` in `display-mode.mjs`).
3. **`Oberfläche` (lokal auf diesem Gerät):**
   - Changes apply immediately (saved in browser `localStorage`, no server write needed — clearly labeled `Nur für diesen Browser / dieses Gerät`).
   - `Sprache`: `DE · Deutsch` / `EN · English`
   - `7"-Display-Modus (Touch)`: Toggle with clear description (larger touch targets, hides cameras)
   - `Startansicht beim Öffnen`: Select (`Werkzeuge`, `Steuerung`, `Druck`, `Verlauf`, `Kameras`, `Konsole`, `System`)
4. **`Netzwerk & Backup`:**
   - If `!runtime.canWrite`, prominent amber callout showing `runtime.requestOrigin` and how to allow writes (open from loopback/trusted origin or set `ALLOW_LAN_ORIGINS=1` / `ALLOWED_ORIGINS`).
   - **Meet-Modus (`allowLanOrigins`):** Checkbox/toggle *"Steuerung von lokalen Netzwerk-Geräten erlauben (Meet-Modus)"* with plain explanation that only private LAN / `.local` same-origin requests are permitted. If `network.envAllowLanOrigins` is `true`, shows checked & disabled with `"Über Umgebung (ALLOW_LAN_ORIGINS) aktiv"`.
   - **Explizite vertrauenswürdige Origins (`allowedOrigins`):** Add/remove list (`http://ipad-host:4173`), plus read-only chips for env-configured `envAllowedOrigins`. If saving would revoke the current non-loopback browser's write permission, display an explicit amber self-lockout confirmation step before sending `confirmSelfLockout: true`.
   - **Server-Information (read-only):** Listen address (`HOST:PORT`), current browser origin.
   - **Backup & Transfer (Drucker-Profile):**
     - `Profile exportieren (JSON)` downloads `dockyard-printers-backup.json` containing `{ version: 1, kind: 'dockyard-printers', activePrinterId, printers }` — intentionally excluding `network` so transferring a fleet backup between laptop and Pi never overwrites origin/Meet security!
     - `Profile importieren (JSON)` validates and shows a preview count with mode toggle: **Hinzufügen / Aktualisieren (Standard, Merge)** vs. **Alle bestehenden Profile ersetzen** — loaded into the editor draft so the user explicitly clicks `Speichern`.

### 7.3 Frontend State & Reactivity
- New composable `src/useSettings.js`:
  - Shared reactive singleton: `settings`, `activePrinter`, `printers`, `runtime`, `loaded`, `saving`, `error`, `loadSettings()`, `saveSettings(payload)`, `switchPrinter(id)`, `testConnection(url)`, `applyRemoteSettings(payload)`.
- `src/usePrinter.js`:
  - Listen for SSE `settings` event (`onSettings` callback).
  - Expose `resetForPrinterSwitch()` which sets `status.value = null`, `wasOnline = false`, `liveAt = 0`, `connection.value = 'connecting'`, `error.value = ''`, and triggers `refresh()`.
- `src/useCameras.js`:
  - Dynamically support arbitrary camera IDs (`getCamera(id)` already works with a `Map`!) and add `resetAll()` + `syncCameraDefaults(cameras)` so switching printers cleanly tears down old WebRTC/MJPEG connections and reconnects with the new printer's cameras, service types (`camera-streamer` vs `mjpeg`), & preferred modes.
- **`ConfigEditor` Safety on Printer Switch (`src/useConfigEditor.js` + `src/components/ConfigEditor.vue`):**
  - Track `loadedPrinterId` whenever a file is opened and always pass `expectedPrinterId: loadedPrinterId` to `POST /api/system/config/save`.
  - **Local switch while dirty:** Switching printers locally when `configEditor.isDirty` is `true` prompts for confirmation (*"Ungespeicherte Änderungen in `<file>` verwerfen und Drucker wechseln?"*).
  - **Remote switch while dirty (via SSE from another browser/touchscreen):** NEVER silently discard unsaved edits; instead transition the editor into a `printerMismatch` lock state (Save disabled, amber banner naming the original printer, with actions **"In Zwischenablage kopieren"** and **"Verwerfen & neu laden"**). Clean/unmodified buffers reset and reload automatically.
- `src/App.vue`:
  - Render enabled cameras dynamically from `activePrinter.cameras` instead of hardcoded `tophat`/`heatbed`.
  - On `printerUrlChanged || activePrinterChanged`, call `resetForPrinterSwitch()`, `consoleStore.clear()`, `configEditor.handlePrinterSwitch(nextPrinterId)`, and `cameras.resetAll()`.

---

## 8. Verification Plan (Overview)

- **Unit tests (`npm test`):**
  - New `tests/settings.test.mjs`: URL normalization & rejection (credentials, paths, non-HTTP, SSRF edges), camera path/URL validation, atomic file save/reload, env bootstrap fallback, profile switch & delete guards, `isPrivateLanHostname` & Meet-mode `sameOriginRequest`, `POST /api/settings/test` mock probe, and `live.mjs` hot-reload `reconnect()` + `emitSettings()`.
  - Update/verify all existing 109 tests remain 100% green.
- **Build check:** `npm run build` clean with zero warnings/errors.
- **Live Browser Verification (headless Chromium via Playwright):**
  - Verify Desktop (`1440×900`), Mobile (`390×844`), and 7" Display Mode (`1024×600`): open Settings while printer is offline, test URL validation, create/edit/switch printer profiles, verify masthead badge + subtitle + quick-switcher update live, verify 0 console/page errors, and visually inspect screenshots.

---

## 9. Left to the Builder

- Exact Lucide icon selection for tabs and action buttons (keeping consistent 15–17px stroke style).
- Exact CSS class naming and media-query breakpoints inside `src/style.css` (following `DESIGN.md` tokens and spacing scale).
- Helper structure for `gcode-mesh.mjs` cache key scoping by active printer URL.
- Exact wording of German & English validation error messages (consistent with existing `server/control.mjs` & `src/locales/en.json` tone).
