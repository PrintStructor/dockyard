# DOCKYARD Settings & Multi-Printer Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Mainsail-familiar Settings dialog and server-persisted multi-printer profile manager to DOCKYARD with live Moonraker hot-reload, connection probing, configurable cameras (`camera-streamer` + `ustreamer`/MJPEG), Meet-mode LAN origin controls, and full DE/EN localization.

**Architecture:** A new `server/settings.mjs` store persists `.dockyard-settings.json` atomically (bootstrapped from `.env.local` on first run) and feeds dynamic getters into `server/control.mjs`, `server/live.mjs`, `server/materials.mjs`, and `server/printer.mjs` so IP or profile switches hot-reload Moonraker WebSockets, clear caches, scope `uncertain` interlocks per `printerId`, and push `event: settings` over SSE without restarting Node. On the client, `src/useSettings.js` syncs with the server, `SettingsDialog.vue` provides a native `<dialog>` in DOCKYARD's flat graphite/lime design system, and `App.vue` exposes a masthead gear button, offline IP-edit shortcut, and multi-VORON quick-switcher pill.

**Tech Stack:** Node.js 22+ (built-in `node:test`, `node:http`, `node:https`, `WebSocket`), Vue 3 (`<script setup>`), Vite, `@lucide/vue`, `DESIGN.md` CSS tokens.

**Spec:** [2026-11-25-dockyard-settings-design.md](../specs/2026-11-25-dockyard-settings-design.md)

## Global Constraints
- Visual design strictly follows `DESIGN.md`: flat graphite (`#111618` / `#192125` / `#1b252a`), `1px solid #354147` borders, `#c5f76b` lime selection/focus, `#283522` lime-tint active fills, `#f3c67b` amber warnings, bundled `Onest` font, tabular numerals for IPs/ports/latencies, zero decorative CSS box-shadows, native `<dialog>`.
- Never display stale telemetry from Printer A under Printer B's identity after switching printers or changing `printer.url`.
- Never commit `.dockyard-settings.json` or private IPs to Git; never break `.env.local` first-run bootstrapping or existing 109 tests.
- Never send mutating commands to any physical printer during tests or connection probes; all `POST` endpoints enforce `sameOriginRequest(req)`.
- Works identically under `npm run dev` (Vite middleware) and `npm start` (`server/start.mjs`), and responsively across Desktop (`1440px`), iPad/Tablet, Mobile (`390px`), and 7" Display Mode (`display-mode`).
- German source strings with complete English translations in `src/locales/en.json`.

## Review Focus
1. **Switching back to a printer with an unacknowledged `uncertain` safety lock** — switching A → B must hide A's lock on B, and switching B → A (or updating A's Meet IP) must restore A's lock rather than silently bypassing it.
2. **Remote printer switch while `ConfigEditor` has unsaved `printer.cfg` edits** — SSE switch from another browser must NOT silently wipe the buffer AND `POST /api/system/config/save` must reject saving A's file onto B (`409 PRINTER_CHANGED`).
3. **Cloud metadata & open-redirect SSRF via `printer.url` / `cameras[].url` / `POST /api/settings/test`** — `http://169.254.169.254` and `metadata.google.internal` must be rejected at validation (`400`), and HTTP 302 redirects on upstream probes must fail (`redirect: 'error'`).
4. **Non-loopback Meet client locking itself out** — disabling `allowLanOrigins` or removing one's own origin from a non-loopback client must return `400 SELF_LOCKOUT` unless `confirmSelfLockout: true` is sent; `ALLOW_LAN_ORIGINS=1` in env must always override JSON `false` at runtime.
5. **Corrupt or half-written `.dockyard-settings.json` or malformed JSON import** — malformed user-imported JSON must fail cleanly with a German error message without touching saved settings; deleting the active printer when >1 exists must cleanly promote the first remaining profile (and deleting the sole remaining printer must fail with `400`).

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Create | `server/settings.mjs` | Validation, SSRF/LAN helpers, atomic `.dockyard-settings.json` store, runtime singleton & change listeners |
| Modify | `server/config.mjs` | Export `allowLanOriginsEnv`, `mainsailUrlEnv`, `settingsFilePath` alongside existing env exports |
| Modify | `server/control.mjs` | Wire `sameOriginRequest` & new `isOriginWriteAllowed` dynamically to `server/settings.mjs` |
| Modify | `server/live.mjs` | Accept `getPrinter` getter, add `reconnect()` and `emitSettings(payload)` |
| Modify | `server/materials.mjs` | Accept `getPrinter` getter and add `reset()` |
| Modify | `server/gcode-mesh.mjs` | Key cache by active printer URL so cached meshes never bleed across printers |
| Modify | `server/printer.mjs` | Dynamic active printer across all routes, `http`/`https` streaming, per-printer `uncertainJobsByPrinter`, `expectedPrinterId` guard on config save, dynamic `camera-streamer`/`mjpeg` proxy, `/api/settings*` endpoints |
| Modify | `server/start.mjs` | Log active printer name/URL from settings store |
| Modify | `.gitignore`, `.env.example` | Ignore `.dockyard-settings.json*`; document `ALLOW_LAN_ORIGINS` / `DOCKYARD_SETTINGS_PATH` |
| Create | `src/useSettings.js` | Reactive settings composable, API client, JSON profile export/import/merge helpers |
| Modify | `src/printer-ui-url.mjs` | Resolve `'auto'` against remote `printerUrl` (Meet/laptop) or browser host (Pi loopback) |
| Modify | `src/display-mode.mjs` | Persist `dockyard.defaultTab` preference |
| Modify | `src/usePrinter.js` | Listen to SSE `settings` event; expose `resetForPrinterSwitch()` |
| Modify | `src/useConsole.js` | Expose `clearConsole()` for clean printer switches |
| Modify | `src/useCameras.js` | Support `camera-streamer` vs `mjpeg` service per camera ID + `resetAll()` |
| Modify | `src/useConfigEditor.js`, `src/components/ConfigEditor.vue` | Track `loadedPrinterId`, pass `expectedPrinterId`, non-destructive `printerMismatch` lock banner with copy & discard-reload actions |
| Create | `src/components/SettingsDialog.vue` | Native `<dialog>` Settings UI with 4 categories (`Drucker & Verbindung`, `Kameras`, `Oberfläche`, `Netzwerk & Backup`) |
| Modify | `src/components/CameraView.vue`, `src/components/ControlsView.vue`, `src/App.vue` | Masthead gear button, multi-printer quick-switcher pill, offline IP-edit shortcut, dynamic subtitle & dynamic cameras |
| Modify | `src/style.css`, `src/locales/en.json`, `README.md` | Flat graphite/lime styles, complete EN translations, README Settings docs |
| Create | `tests/settings.test.mjs`, `tests/settings-api.test.mjs`, `tests/settings-client.test.mjs` | Unit tests covering store, SSRF/security, hot-reload API, camera proxy, and client helpers |

---

### Task 1: Server Settings Store, Validation & Origin Security

**Files:**
- Create: `server/settings.mjs`
- Modify: `server/config.mjs:1-47`
- Modify: `server/control.mjs:15-17,276-292`
- Modify: `.gitignore`, `.env.example`
- Test: `tests/settings.test.mjs`

**Interfaces:**
- Consumes: `server/config.mjs` (`parseAllowedOrigins`, `resolvePrinterName`, `printerUrl`, `printerName`, `allowedOrigins`, `serverHost`, `serverPort`, plus new `allowLanOriginsEnv`, `mainsailUrlEnv`, `settingsFilePath`).
- Produces (`server/settings.mjs`):
  - `normalizePrinterOrigin(raw: string): string` (auto-prepends `http://`, strips trailing `/`, allows `http:`/`https:`, rejects credentials/path/query/hash/blocked metadata hosts)
  - `isBlockedUpstreamHost(hostname: string): boolean`
  - `isPrivateLanHostname(hostname: string): boolean`
  - `normalizeCamera(raw: object, index?: number): CameraConfig` (`service: 'camera-streamer' | 'mjpeg'`, validates path/URL rules)
  - `normalizeMainsailSetting(raw: string): string`
  - `slugifyId(label: string, fallback?: string): string`
  - `validateSettingsPayload(payload: object): SettingsData`
  - `createSettingsStore({ filePath?: string, env?: object }): SettingsStore` with methods: `getSettings()`, `getActivePrinter()`, `getPublicSettings(runtime?)`, `getEffectiveAllowedOrigins()`, `isLanOriginAllowed()`, `hasEnvLanOriginOverride()`, `saveSettings(payload)`, `switchPrinter(printerId)`, `onChange(fn)`.
  - Default singleton exports: `settingsStore`, `getSettings`, `getActivePrinter`, `getEffectiveAllowedOrigins`, `isLanOriginAllowed`, `hasEnvLanOriginOverride`.
- Produces (`server/control.mjs`):
  - `sameOriginRequest(req, extraAllowedOrigins?, options?: { allowLanOrigins?: boolean }): boolean`
  - `isOriginWriteAllowed(req, extraAllowedOrigins?, options?: { allowLanOrigins?: boolean }): boolean`

- [ ] **Step 1: Write failing unit tests in `tests/settings.test.mjs`**
  Cover:
  - `normalizePrinterOrigin`: accepts `'192.168.1.50'` -> `'http://192.168.1.50'`, `'voron.local:7125/'` -> `'http://voron.local:7125'`, `'https://voron.example.com/'` -> `'https://voron.example.com'`; rejects credentials (`'http://u:p@192.168.1.50'`), non-root paths (`'http://192.168.1.50/api'`), non-HTTP (`'ftp://192.168.1.50'`), and SSRF metadata hosts (`'http://169.254.169.254'`, `'http://metadata.google.internal'`).
  - `normalizeCamera`: accepts `camera-streamer` relative `'/webcam'` and external `'http://192.168.1.60:8080/cam'`; rejects query string on `camera-streamer`; accepts `mjpeg` with query string `'/webcam/?action=stream'` + `snapshotUrl: '/webcam/?action=snapshot'` and forces `preferredMode: 'mjpeg'`; rejects `'..'` and metadata hosts.
  - `isPrivateLanHostname`: true for `'10.0.0.5'`, `'172.16.4.2'`, `'192.168.50.12'`, `'169.254.1.2'`, `'voron.local'`, `'pi-host'`, `'fd12::1'`, `'fe80::1'`; false for `'8.8.8.8'`, `'172.32.0.1'`, `'example.com'`, `'169.254.169.254'`.
  - `createSettingsStore`: bootstraps from env when file absent without writing to disk; atomic `saveSettings()` persists and reloads cleanly across a fresh store instance; rejects 0 printers; `switchPrinter()` updates `activePrinterId` and reports `{ printerUrlChanged, activePrinterChanged }`; `ALLOW_LAN_ORIGINS=1` in env overrides persisted `allowLanOrigins: false` (`isLanOriginAllowed() === true` and `hasEnvLanOriginOverride() === true`).
  - `sameOriginRequest` with `allowLanOrigins: true`: allows `Origin: http://192.168.50.12:4173` matching `Host: 192.168.50.12:4173` with `X-Cockpit-Request: 1` + JSON content-type; still rejects cross-host `Host: 192.168.50.99:4173`, missing `X-Cockpit-Request`, and public origin `https://evil.example.com`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/settings.test.mjs`
  Expected: FAIL (`Cannot find module '../server/settings.mjs'`).

- [ ] **Step 3: Update `server/config.mjs`, `.gitignore`, and `.env.example`**
  - In `server/config.mjs`: allow `https:` in `PRINTER_URL` as well; export `allowLanOriginsEnv` (true when `ALLOW_LAN_ORIGINS` is `'1'`/`'true'`/`'yes'`), `mainsailUrlEnv` (`process.env.MAINSAIL_URL || process.env.VITE_MAINSAIL_URL || 'auto'`), and `settingsFilePath` (`process.env.DOCKYARD_SETTINGS_PATH` or `fileURLToPath(new URL('../.dockyard-settings.json', import.meta.url))`).
  - Add `.dockyard-settings.json` and `.dockyard-settings.json.tmp` to `.gitignore`.
  - Document `ALLOW_LAN_ORIGINS` and `DOCKYARD_SETTINGS_PATH` in `.env.example`.

- [ ] **Step 4: Implement `server/settings.mjs`**
  - Implement all validators, SSRF metadata denylist, LAN hostname matcher, atomic write-and-rename persistence (`writeFile` tmp with `0o600` + `rename`), first-run bootstrap from env with default Tophat + Druckbett cameras, and singleton exports.

- [ ] **Step 5: Wire `server/control.mjs` dynamic origin checks**
  - Update `sameOriginRequest(req, extraAllowedOrigins, options)` so when `extraAllowedOrigins` is omitted it reads `getEffectiveAllowedOrigins()` dynamically, and when `options?.allowLanOrigins` is omitted it reads `isLanOriginAllowed()` dynamically (when `extraAllowedOrigins` IS explicitly passed in legacy tests without `options`, preserve exact legacy behavior!).
  - Export `isOriginWriteAllowed(req, extraAllowedOrigins, options)` that checks origin/host permission without requiring `POST` content-type headers (used by `GET /api/settings` `runtime.canWrite`).

- [ ] **Step 6: Run tests to verify pass**
  Run: `node --test tests/settings.test.mjs tests/control.test.mjs tests/server-start.test.mjs`
  Expected: All PASS.

- [ ] **Step 7: Commit**
  ```bash
  git add .gitignore .env.example server/config.mjs server/settings.mjs server/control.mjs tests/settings.test.mjs
  git commit -m "feat: add server settings store, printer profiles, and dynamic LAN origin guard"
  ```

---

### Task 2: Backend Live Hot-Reload, Dynamic Camera Proxy & Settings API

**Files:**
- Modify: `server/live.mjs:16-249`
- Modify: `server/materials.mjs:31-79`
- Modify: `server/gcode-mesh.mjs:570-614`
- Modify: `server/printer.mjs`
- Modify: `server/start.mjs:5-6,123-129`
- Test: `tests/settings-api.test.mjs`, `tests/live.test.mjs`

**Interfaces:**
- Consumes: `server/settings.mjs` (`settingsStore`, `getActivePrinter`, `normalizePrinterOrigin`, `getEffectiveAllowedOrigins`, `isLanOriginAllowed`), `server/control.mjs` (`sameOriginRequest`, `isOriginWriteAllowed`).
- Produces:
  - `server/live.mjs`: `createLiveFeed({ printer?, getPrinter?, baseObjects, snapshot, ... })` returns `{ handle, notify, emitConsole, emitUpdate, emitSettings, reconnect, close }`.
  - `server/materials.mjs`: `createMaterialsReader(printerOrGetter, fetchImpl?, onUpdate?)` returns callable `reader(raw)` with `reader.reset()`.
  - `server/printer.mjs`: HTTP routes `GET /api/settings`, `POST /api/settings`, `POST /api/settings/switch`, `POST /api/settings/test`, dynamic `/api/camera/:id(/(stream|webrtc))?`, and `expectedPrinterId` check on `POST /api/system/config/save`.

- [ ] **Step 1: Write failing tests in `tests/settings-api.test.mjs` and extend `tests/live.test.mjs`**
  Cover:
  - `live.mjs`: `getPrinter` dynamically resolved on `reconnect()` connects to the new `ws://...` URL, emits `offline`, resets stale `raw`, and `emitSettings(payload)` writes `event: settings\ndata: ...\n\n` to SSE clients.
  - `GET /api/settings`: succeeds (`200`) even when upstream Moonraker is unreachable; returns `activePrinter`, `printers`, `network` (including `envAllowedOrigins`, `envAllowLanOrigins`), and `runtime` (`host`, `port`, `requestOrigin`, `canWrite`).
  - `POST /api/settings`: saves updated printer URL + 2nd VORON profile, returns `{ printerUrlChanged: true }`; rejects self-lockout from a non-loopback origin with `400` + `code: 'SELF_LOCKOUT'` unless `confirmSelfLockout: true`; rejects switching/changing URL while an active non-uncertain job is running with `409`.
  - `POST /api/settings/switch`: switches `activePrinterId` in 1 call and isolates per-printer `uncertain` safety interlocks (A's uncertain lock is hidden on B and restored when switching back to A).
  - `POST /api/settings/test`: probes a local mock HTTP server (`GET /server/info` + `GET /printer/info`), returns `{ ok: true, moonrakerVersion, klippyState, hostname, latencyMs }`; returns `{ ok: false, error }` when unreachable; returns `400` on invalid/blocked metadata URL; fails on HTTP 302 redirect (`redirect: 'error'`).
  - `POST /api/system/config/save` with `expectedPrinterId` mismatch returns `409` with `code: 'PRINTER_CHANGED'`.
  - Dynamic camera proxy: serves `camera-streamer` (`/api/camera/tophat/webrtc`, `/api/camera/tophat/stream`, `/api/camera/tophat`) AND `mjpeg` (`ustreamer` `/webcam/?action=stream` on `/api/camera/v0cam/stream`, `404` on `/api/camera/v0cam/webrtc`, snapshot via `snapshotUrl`); returns `404` for disabled/unknown camera ID.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test tests/settings-api.test.mjs tests/live.test.mjs`
  Expected: FAIL.

- [ ] **Step 3: Update `server/live.mjs`, `server/materials.mjs`, `server/gcode-mesh.mjs`, and `server/start.mjs`**
  - `server/live.mjs`: resolve `const currentPrinter = () => (typeof getPrinter === 'function' ? getPrinter() : printer)`; add `emitSettings(payload)` and `reconnect()` (closes active WS, clears `raw`/`ready`/timers, emits `offline`, calls `connect()` if `clients.size > 0`).
  - `server/materials.mjs`: resolve `printer` via getter if function; attach `.reset()` method that resets `key`, `materials`, `signature`, `requestedAt`, `pending`, and increments `version`.
  - `server/gcode-mesh.mjs`: include `printer` in cache key `${printer}|${cacheKey}` and pass `redirect: 'error'` on upstream `fetch`.
  - `server/start.mjs`: log active printer name & URL from `getActivePrinter()` on startup.

- [ ] **Step 4: Update `server/printer.mjs`**
  - Replace static `printer` and `printerName` with `getActivePrinter()` helper throughout all endpoints, `query()`, `control()`, `startUpdateJob()`, `probeMachineWriteGuard()`, `executeRestartTarget()`, `streamCamera()`, and `streamLogDownload()`.
  - Add `requestStream(url, options)` helper selecting `http.get` or `https.get` based on `new URL(url).protocol`, rejecting 3xx redirects.
  - Scope `uncertain` safety locks in `const uncertainJobsByPrinter = new Map()` keyed by `activePrinter.id`; update `getControlState()`, `acknowledge`, and `control()` job error transition accordingly.
  - Add `applyRuntimeSettingsChange({ printerUrlChanged, activePrinterChanged, settings })` helper that resets all Moonraker caches + finished `activeUpdateJob` + `lastResult` + `readMaterials.reset()`, emits `live.emitSettings(...)`, and calls `live.reconnect()` (or `live.notify()` for cosmetic-only edits).
  - Add `/api/settings`, `/api/settings/switch`, `/api/settings/test` endpoints with self-lockout check and active-job `409` guard.
  - Add `expectedPrinterId` validation in `POST /api/system/config/save` returning `409` (`code: 'PRINTER_CHANGED'`) on mismatch.
  - Replace hardcoded `cameras` map & regex with dynamic `^\/api\/camera\/([a-z0-9][a-z0-9_-]{0,31})(?:\/(stream|webrtc))?$` resolving enabled cameras from `getActivePrinter().cameras` for both `camera-streamer` and `mjpeg` services.

- [ ] **Step 5: Run full backend test suite**
  Run: `node --test tests/settings.test.mjs tests/settings-api.test.mjs tests/live.test.mjs tests/control.test.mjs tests/machine.test.mjs tests/proxy.test.mjs`
  Expected: All PASS.

- [ ] **Step 6: Commit**
  ```bash
  git add server/live.mjs server/materials.mjs server/gcode-mesh.mjs server/printer.mjs server/start.mjs tests/settings-api.test.mjs tests/live.test.mjs
  git commit -m "feat: add settings API, live printer hot-reload, dynamic cameras, and cross-printer safety guards"
  ```

---

### Task 3: Frontend Settings Store, Reactive Switching & `ConfigEditor` Protection

**Files:**
- Create: `src/useSettings.js`
- Modify: `src/printer-ui-url.mjs:1-11`
- Modify: `src/display-mode.mjs:1-135`
- Modify: `src/usePrinter.js:1-117`
- Modify: `src/useConsole.js:1-111`
- Modify: `src/useCameras.js:1-160,340-374`
- Modify: `src/useConfigEditor.js:1-194`
- Modify: `src/components/ConfigEditor.vue:1-160,260-360`
- Test: `tests/settings-client.test.mjs`

**Interfaces:**
- Produces (`src/useSettings.js`):
  - `useSettings()` returning `{ settings, activePrinter, printers, network, runtime, loaded, loading, saving, error, loadSettings, saveSettings, switchPrinter, testConnection, applyRemoteSettings }`.
  - Pure backup helpers: `buildPrintersExport(settings)`, `parsePrintersImport(rawText)`, `mergePrinterProfiles(existingPrinters, importedPrinters, mode: 'merge' | 'replace')`.
- Produces (`src/printer-ui-url.mjs`):
  - `resolveMainsailUrl(configuredUrl, loc?, printerUrl?): string`
- Produces (`src/display-mode.mjs`):
  - `DEFAULT_TAB_KEY`, `defaultTab`, `resolveDefaultTab(storage?)`, `setDefaultTab(tab, storage?)`
- Produces (`src/usePrinter.js`):
  - `usePrinter({ onConsole, onUpdate, onSettings, onReconnect })` returning `{ ..., resetForPrinterSwitch }`.
- Produces (`src/useConsole.js`): `clearConsole()`.
- Produces (`src/useCameras.js`): `configureCamera(id, { service, preferredMode })`, `resetAll()`.
- Produces (`src/useConfigEditor.js`): `loadedPrinterId`, `printerMismatch`, `handlePrinterSwitch(nextPrinterId, nextPrinterName?)`, `acknowledgePrinterMismatchAndReload()`.

- [ ] **Step 1: Write failing client unit tests in `tests/settings-client.test.mjs`**
  Cover:
  - `resolveMainsailUrl`: explicit URL returned as-is; `'auto'` with remote `printerUrl = 'http://192.168.50.22'` returns `'http://192.168.50.22/'`; `'auto'` with loopback `printerUrl = 'http://127.0.0.1'` derives `'http://voron.local/'` from `loc.hostname`.
  - `resolveDefaultTab` / `setDefaultTab`: defaults to `'tools'`, persists valid tabs, rejects invalid tab names.
  - `buildPrintersExport` / `parsePrintersImport` / `mergePrinterProfiles`: export excludes `network`; malformed JSON throws clear German error; `'merge'` updates matching IDs and appends new profiles without wiping existing ones; `'replace'` replaces cleanly and ensures valid `activePrinterId`.
  - `ConfigEditor` mismatch helper: clean buffer resets cleanly on printer switch; dirty buffer preserves `content` and sets `printerMismatch` lock instead of wiping edits.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/settings-client.test.mjs`
  Expected: FAIL.

- [ ] **Step 3: Implement `src/useSettings.js`, `src/printer-ui-url.mjs`, `src/display-mode.mjs`, `src/usePrinter.js`, `src/useConsole.js`, `src/useCameras.js`**
  - Implement all reactive stores and pure helpers cleanly with zero external dependencies.
  - In `src/useCameras.js`: when `service === 'mjpeg'`, start MJPEG directly without attempting `/webrtc`; `resetAll()` stops all active transports and clears cached streams/frame URLs, restarting any attached cameras (`refs > 0`).

- [ ] **Step 4: Update `src/useConfigEditor.js` and `src/components/ConfigEditor.vue`**
  - Record `loadedPrinterId` & `loadedPrinterName` when `openFile()` succeeds (from `useSettings().activePrinter.value`).
  - Include `expectedPrinterId: loadedPrinterId.value` in `POST /api/system/config/save` body; handle `409` `PRINTER_CHANGED` by setting `printerMismatch`.
  - Implement `handlePrinterSwitch(nextId)`: if clean, clear file state & reload file list; if dirty and `loadedPrinterId && loadedPrinterId !== nextId`, lock editor (`printerMismatch = { fromPrinterId, fromPrinterName, filePath }`) without destroying `content`.
  - In `ConfigEditor.vue`: include `store.printerMismatch.value` in `effectiveReadonly`, render a clear amber lock banner with **"In Zwischenablage kopieren"** (`navigator.clipboard.writeText`) and **"Verwerfen & neu laden"** buttons!

- [ ] **Step 5: Run client tests**
  Run: `node --test tests/settings-client.test.mjs tests/display-mode.test.mjs tests/mjpeg.test.mjs`
  Expected: All PASS.

- [ ] **Step 6: Commit**
  ```bash
  git add src/useSettings.js src/printer-ui-url.mjs src/display-mode.mjs src/usePrinter.js src/useConsole.js src/useCameras.js src/useConfigEditor.js src/components/ConfigEditor.vue tests/settings-client.test.mjs
  git commit -m "feat: add frontend settings composable, reactive hot-reload sync, and ConfigEditor switch protection"
  ```

---

### Task 4: Mainsail-Style `SettingsDialog.vue` & Flat Graphite Styles

**Files:**
- Create: `src/components/SettingsDialog.vue`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `src/useSettings.js`, `src/display-mode.mjs`, `src/i18n.mjs`, `src/components/CockpitSelect.vue`, `src/useConfigEditor.js`.
- Produces (`src/components/SettingsDialog.vue`):
  - Props: `open: Boolean`, `initialSection?: 'printers' | 'cameras' | 'interface' | 'network'`
  - Emits: `close`, `switched` (when active printer changed/saved)

- [ ] **Step 1: Build `src/components/SettingsDialog.vue`**
  - Native `<dialog>` opened via `showModal()`, Escape/backdrop close (confirming inline if draft has unsaved server edits).
  - 2-column desktop layout (210px sidebar rail + scrollable content pane, `max-width: 920px`, `height: min(780px, 88dvh)`); horizontal segmented tabs on `< 760px` & `display-mode`.
  - **Tab 1 — `Drucker & Verbindung`:**
    - Saved printer list cards (active lime badge, host/IP in tabular numerals, 1-click `Aktivieren`, `Bearbeiten`, `Duplizieren`, `Löschen` with guard on last printer, `+ Drucker hinzufügen`).
    - Editor form for selected draft printer: `Druckername (Badge)`, `Untertitel`, `Moonraker / Drucker-URL` + inline `Verbindung testen` button with live latency/Moonraker/Klipper status pill, `Mainsail-Link` (`auto` or explicit URL).
  - **Tab 2 — `Kameras`:**
    - Camera cards for selected draft printer: Enabled toggle, Name, Beschreibung, Dienst-Typ (`camera-streamer` vs `ustreamer / Direkt-MJPEG`), Stream-Pfad/URL, Snapshot-URL (shown for `mjpeg`), Standard-Transport (`WebRTC` / `MJPEG`), Entfernen, `+ Kamera hinzufügen` (up to 6).
    - Local device card: Toggle *"Kameras auf diesem Gerät ausblenden"* wired directly to `camerasHiddenPreference` / `setCamerasHidden`.
  - **Tab 3 — `Oberfläche` (lokal in diesem Browser):**
    - Language selector (`DE · Deutsch` / `EN · English`), 7" Display-Modus toggle, Standard-Startansicht (`defaultTab`) selector — immediate apply, zero server write needed.
  - **Tab 4 — `Netzwerk & Backup`:**
    - Amber read-only notice if `!runtime.canWrite` showing `runtime.requestOrigin` + how to enable (`ALLOW_LAN_ORIGINS=1` / `ALLOWED_ORIGINS`).
    - Meet-Modus toggle (`allowLanOrigins`, locked checked if `network.envAllowLanOrigins`).
    - Explicit `allowedOrigins` list (add/remove) + read-only chips for `envAllowedOrigins`.
    - Inline self-lockout confirmation banner if `POST /api/settings` returns `code: 'SELF_LOCKOUT'`, allowing explicit `confirmSelfLockout: true`.
    - Read-only server info (`HOST:PORT`, current browser origin).
    - JSON Profile Backup: `Profile exportieren (JSON)` + `Profile importieren (JSON)` with file picker, validation preview count, and `Hinzufügen / Aktualisieren (Merge)` vs `Alle Profile ersetzen` mode selector.
  - Sticky footer for server-backed tabs: dirty indicator, `Verwerfen`, primary lime `Speichern` button (guarded by dirty check for `ConfigEditor` if switching active printer locally!).

- [ ] **Step 2: Add flat graphite/lime CSS rules in `src/style.css`**
  - Strictly honor `DESIGN.md`: `#111618` dialog frame, `#192125` panels, `#1b252a` inputs, `1px solid #354147`, `#c5f76b` focus/active, `#283522` lime-tint, `#f3c67b` amber callouts, zero box-shadows, tabular numerals on URL/latency/port readouts, responsive & `display-mode` 44px touch targets.

- [ ] **Step 3: Verify build succeeds cleanly**
  Run: `npm run build`
  Expected: `dist/` builds cleanly with 0 errors.

- [ ] **Step 4: Commit**
  ```bash
  git add src/components/SettingsDialog.vue src/style.css
  git commit -m "feat: add Mainsail-style SettingsDialog component and graphite styling"
  ```

---

### Task 5: Masthead Entry Points, Quick-Switcher Pill, Dynamic Cameras & DE/EN Translations

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/ControlsView.vue:625-645`
- Modify: `src/components/CameraView.vue:7-36,70-100`
- Modify: `src/locales/en.json`
- Test: `tests/i18n.test.mjs`

**Interfaces:**
- Consumes: `src/useSettings.js`, `src/components/SettingsDialog.vue`, `src/display-mode.mjs` (`defaultTab`), `src/printer-ui-url.mjs` (`resolveMainsailUrl`).

- [ ] **Step 1: Wire `src/App.vue`**
  - Load `settingsStore.loadSettings()` on mount.
  - Initialize `tab` from `location.hash` if present, otherwise `defaultTab.value`.
  - Compute `printerName`, `printerSubtitle`, `activeCameras`, and `mainsailUrl` reactively from `settingsStore.activePrinter` (with clean fallback to `status.value?.printerName` / `VITE_PRINTER_NAME`).
  - Add Settings gear button (`<Settings :size="16" />`) to `.header-meta` next to Display Mode & Language (always clickable even offline).
  - Enhance `.brand-printer-pill`: when `printers.length > 1`, render interactive quick-switcher popover listing all saved VORONs (name, host, active dot, 1-click switch with local dirty-`ConfigEditor` confirmation + `"Drucker verwalten …"` action); when `printers.length === 1`, clicking opens Settings → Drucker.
  - Add compact `"IP / Verbindung anpassen"` button inside the offline `.notice` banner that opens `SettingsDialog` directly on `printers`.
  - Connect `usePrinter({ onSettings })`: on `payload.printerUrlChanged || payload.activePrinterChanged`, apply remote settings, call `resetForPrinterSwitch()`, `consoleStore.clear()`, `configEditor.handlePrinterSwitch(payload.activePrinterId)`, and `cameras.resetAll()` + sync camera configs.
  - Render `activeCameras` dynamically in the `tools` / `cameras` camera grid (with clean empty state + "Kameras einrichten" button if 0 cameras are enabled).

- [ ] **Step 2: Wire dynamic cameras in `src/components/ControlsView.vue` and `service` prop in `src/components/CameraView.vue`**
  - Pass `:cameras="activeCameras"` into `ControlsView` and render enabled cameras dynamically instead of hardcoded `tophat`/`heatbed`.
  - In `CameraView.vue`, accept `service` (`'camera-streamer' | 'mjpeg'`) and `preferredMode`, call `cameras.configureCamera(props.id, ...)` before `attach()`, and hide the WebRTC/MJPEG toggle button when `service === 'mjpeg'`.

- [ ] **Step 3: Add complete English translations in `src/locales/en.json`**
  - Translate every new German string across `SettingsDialog.vue`, `App.vue`, `ConfigEditor.vue`, `useSettings.js`, and server-returned UI labels.

- [ ] **Step 4: Run tests & build**
  Run: `npm test && npm run build`
  Expected: All unit tests PASS, `npm run build` succeeds.

- [ ] **Step 5: Commit**
  ```bash
  git add src/App.vue src/components/ControlsView.vue src/components/CameraView.vue src/locales/en.json
  git commit -m "feat: integrate Settings gear, multi-printer switcher, dynamic cameras, and EN translations"
  ```

---

### Task 6: Live Headless Browser Verification, Documentation & Final Polish

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Verify full test suite and production build**
  Run: `npm test && npm run build`
  Expected: 100% tests pass, clean build.

- [ ] **Step 2: Run live headless Chromium verification across Desktop (`1440×900`), Mobile (`390×844`), and 7" Display Mode (`1024×600`)**
  - Start isolated production server (`DOCKYARD_SETTINGS_PATH=/tmp/dockyard-qc-settings.json PORT=4179 node server/start.mjs`) pointed at an offline loopback URL (zero risk to physical printer!).
  - Verify with Playwright Chromium:
    1. Masthead shows `⚙` Settings button & offline notice shows `"IP / Verbindung anpassen"`.
    2. Opening Settings while offline works seamlessly across all 4 tabs (`Drucker & Verbindung`, `Kameras`, `Oberfläche`, `Netzwerk & Backup`), both DE and EN.
    3. Adding a 2nd VORON profile (`VORON-TRIDENT`, `http://192.168.50.60`), clicking `Speichern`, verifying `.dockyard-settings.json` persists, masthead quick-switcher popover appears with 2 printers, switching profiles updates badge + subtitle live without page reload, and 0 console/page errors occur.
  - Capture screenshots of Settings Desktop, Settings Mobile, and Masthead Quick-Switcher into scratch dir and visually inspect every screenshot via `read_file`!
  - Clean up temporary `/tmp/dockyard-qc-settings.json` and stop temporary server.

- [ ] **Step 3: Update `README.md` with Settings & Multi-Printer Profiles section**
  - Document the in-app Settings modal (Meet IP switching, connection testing, multi-VORON profiles, camera configuration, Meet-mode LAN toggle, JSON backup) without exposing any private IPs.

- [ ] **Step 4: Final test + build + clean git check**
  Run: `npm test && npm run build && git status -s`
  Expected: All tests pass, build green, `.dockyard-settings.json` NOT tracked.

- [ ] **Step 5: Commit**
  ```bash
  git add README.md
  git commit -m "docs: document DOCKYARD in-app Settings and multi-printer profiles"
  ```
