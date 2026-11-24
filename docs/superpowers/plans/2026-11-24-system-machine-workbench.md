# System Machine-Werkzeugkasten (Ausbaustufe 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the `System` tab into a 4-view Machine workbench (`Übersicht` | `Konfiguration` | `Kalibrierung` | `Wartung`) with host metrics, safe service restarts, a lazy-loaded CodeMirror 6 Klipper config editor, a 6-toolchanger calibration suite, an update manager with dirty-repo protection, and a range-tailed log viewer.

**Architecture:** Pure validation, guard, and normalization modules on the Node 22+ backend (`server/machine.mjs`, `server/calibration.mjs`) expose hardened `/api/system/*` endpoints and whitelisted `/api/control` calibration macros via `server/printer.mjs` and `server/control.mjs`. On the frontend, `src/components/SystemView.vue` coordinates four sub-views (`SystemOverview.vue`, lazy `ConfigEditor.vue` backed by persistent `src/useConfigEditor.js`, `SystemCalibration.vue`, and `SystemMaintenance.vue`) using consolidated semantic tokens in `src/style.css`.

**Tech Stack:** Vue 3 (`^3.5.0`), Vite (`^5.4.0`), Node 22+ (`node:test`, built-in `fetch`/`FormData`/`http`), `@lucide/vue`, CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language`).

**Spec:** `docs/superpowers/specs/2026-11-24-system-machine-design.md`

## Global Constraints

- **Node PATH:** Prefix shell commands with `export PATH="/opt/homebrew/bin:$PATH"`.
- **Never write to the real printer:** All write endpoints (`config/save`, `service/restart`, `updates/refresh`, calibration macros) are verified exclusively with unit tests and mocks. Only read-only GET probes and read-only browser verification may talk to the configured printer.
- **No private data in Git:** Never commit IP addresses, hostnames, hardware serial numbers, or local user paths in code, tests, specs, or plans.
- **Zero-regression safety & i18n:** All 59 existing tests plus all new tests must pass (`npm test`), `npm run build` must succeed, and every static `t('...')` string in `src/` must exist in `src/locales/en.json` with zero `t(t(...))` calls.
- **STORMTROOPER visual craft floor:** Flat 1 px borders, zero CSS `box-shadow`, tabular numerals (`font-variant-numeric: tabular-nums`), `--font-mono` only for code/console/logs, no modal config editor, no `window.confirm()`, and `Werkzeuge` stays untouched.
- **CSRF / Origin guard:** Every `POST /api/system/*` endpoint requires `sameOriginRequest(req)` (`Content-Type: application/json`, `X-Cockpit-Request: 1`, loopback or `ALLOWED_ORIGINS`).

## Review Focus

1. **0-byte logs & HTTP 416 / UTF-8 range boundary:** Requesting `Range: bytes=-131072` on a 0-byte log (`mainsail-error.log`) returns HTTP `416`, and partial byte tails start mid-line; `parseLogTail` must treat `416`/empty as an empty log and drop the leading partial line whenever `truncated` is true.
2. **Broken `printer.cfg` recovery while Klippy is down:** When Klippy disconnects (`/printer/objects/query` returns 503 or omits `configfile`), Moonraker `/server/info` still reports `klippy_connected: false`; backend guards and `SystemView` must allow `config/save` and `service/restart` while Moonraker is reachable and Klippy is not printing, and fail closed if Moonraker itself is unreachable.
3. **`SAVE_CONFIG` external overwrite conflict:** Leaving `printer.cfg` open while `SAVE_CONFIG` updates disk changes `modified`; `POST /api/system/config/save` must reject stale `expectedModified` with `409` (`code: 'FILE_CHANGED'`) unless `force: true` is sent.
4. **`job.uncertain` + Klipper `shutdown`/`error` deadlock:** If a control job failed into `uncertain` during a Klipper shutdown, `klipper_restart`, `firmware_restart`, `klipper` service restart, and `config/save` must remain allowed while keeping `job.uncertain` intact until manually acknowledged once Klipper is `ready`.
5. **Path traversal, `.sh`/`.py`/backup write attempts, and ShakeTune non-PNG requests:** Encoded `..`, backslashes, null bytes, `.theme/`, backups (`isBackup`), `.sh`/`.py` scripts, and non-PNG ShakeTune paths must be rejected before any upstream Moonraker URL is constructed.

---

## File Map

- **Create:** `server/machine.mjs` — Pure path validators, config read/write classifiers, 2-stage write guard, overview/update/log normalizers, multipart upload builder, service allowlist.
- **Create:** `server/calibration.mjs` — Calibration capabilities, 12 whitelisted calibration commands, ShakeTune image path validator, calibration payload normalizer (6×6 matrices, Bed Mesh, Beacon, Input Shaper, ShakeTune list).
- **Modify:** `server/control.mjs` — Register `calibrationActions`, `calibrationCapabilities`, and `calibrationCommand`.
- **Modify:** `server/printer.mjs` — Null-safe `configfile`, per-command timeout & `restartsKlipper` support in `control()`, and all `/api/system/*` GET/POST routes (with streaming log download).
- **Create:** `tests/machine.test.mjs` — Comprehensive unit tests for `server/machine.mjs` and `/api/system/*` write-safety invariants.
- **Create:** `tests/calibration.test.mjs` — Comprehensive unit tests for `server/calibration.mjs` and calibration actions via `commandFor`.
- **Modify:** `src/style.css` — Consolidate semantic CSS tokens + `--font-mono`; add styles and skeletons for all four `System` sub-views.
- **Create:** `src/klipper-lang.mjs` — Lightweight CodeMirror 6 Klipper/INI/Jinja2 `StreamLanguage` mode and STORMTROOPER dark editor theme.
- **Create:** `src/useConfigEditor.js` — Persistent config editor store (draft buffer, dirty state, `beforeunload`, conflict state, save/discard/reload).
- **Create:** `src/components/SystemOverview.vue` — Host metrics strip, throttling alert, Printer Status, Temperatures, Restarts & Services with inline 2-step confirmation, CAD note.
- **Create:** `src/components/ConfigEditor.vue` — Lazy-loaded full-width inline file tree + CodeMirror 6 editor with context-sensitive Save & Restart, dirty file-switch guard, and conflict banner.
- **Create:** `src/components/SystemCalibration.vue` — 6-tool offsets table, Nudge ring closure, expandable 6×6 XY/Z matrix, Beacon batch banner, 2D Bed-Mesh heatmap, Beacon & Shaper panels, inline-confirmed calibration actions, ShakeTune lightbox gallery.
- **Create:** `src/components/SystemMaintenance.vue` — Update Manager table with Amber `Lokal geändert` badges + refresh, and HTTP-Range Log Tail Viewer + streaming download.
- **Create:** `src/components/SystemView.vue` — `System` container with 4-way sub-navigation (`Übersicht` | `Konfiguration` | `Kalibrierung` | `Wartung`) and hash sync (`#system/...`).
- **Modify:** `src/App.vue` — Mount `SystemView`, parse `#system/<subtab>` hash, display dirty indicator on `System` nav tab, wire `@open-console`.
- **Modify:** `src/locales/en.json` & `src/i18n.mjs` — Complete English translations and dynamic message patterns for all new UI copy.

---

### Task 1: Backend Machine Core (`server/machine.mjs` + `tests/machine.test.mjs`)

**Files:**
- Create: `server/machine.mjs`
- Test: `tests/machine.test.mjs`

**Interfaces:**
- Consumes: `ControlError` from `./control.mjs`
- Produces:
  - `MAX_CONFIG_BYTES` (`524288`), `LOG_TAIL_BYTES` (`131072`), `LOG_TAIL_MAX_LINES` (`400`), `ALLOWED_SYSTEMD_SERVICES` (`['klipper', 'moonraker', 'crowsnest', 'sonar', 'mobileraker', 'helixscreen', 'klipper-mcu']`)
  - `validateConfigPath(rawPath) -> string | null`
  - `classifyConfigFile(entry) -> { path, name, dir, size, modified, permissions, isBackup, isScript, readonly } | null`
  - `normalizeConfigList(entries) -> Array<ConfigFileEntry>`
  - `validateWritableConfigPath(rawPath, entry) -> { path, dir, name }` (throws `ControlError` 400/403/404)
  - `validateConfigContent(content) -> string` (throws `ControlError` 400/413)
  - `resolveRestartTargetForFile(relPath) -> 'none' | 'klipper_restart' | 'moonraker' | 'crowsnest'`
  - `buildConfigUploadFormData(relPath, content) -> FormData`
  - `validateRestartTarget(target, availableServices) -> { kind: 'klipper' | 'firmware' | 'service', service?: string, label: string }` (throws `ControlError` 400/409)
  - `evaluateMachineWriteGuard({ queryData, queryStatus, serverInfo, job, allowUncertainRecovery }) -> { klipperState: string, mode: 'ready' | 'recovery' }` (throws `ControlError` 409/502/503)
  - `normalizeSystemOverview({ procStats, systemInfo, serverInfo }) -> SystemOverview`
  - `normalizeUpdateStatus(raw) -> { busy: boolean, summary: { total, outdated, dirty, invalid }, items: Array<UpdateItem> }`
  - `validateLogPath(rawPath) -> string | null`
  - `normalizeLogList(entries) -> Array<{ path, name, size, modified, primary }>`
  - `parseLogTail({ text, totalBytes, fetchedBytes, statusCode, maxLines }) -> { lines: string[], lineCount: number, truncated: boolean, totalBytes: number, fetchedBytes: number, empty: boolean }`
  - `checkExpectedModified({ expectedModified, currentModified, force }) -> void` (throws `ControlError` 409 with `.code = 'FILE_CHANGED'` and `.currentModified`)

- [ ] **Step 1: Write failing unit tests in `tests/machine.test.mjs`**

Cover every contract and all 5 Review Focus items owned by `machine.mjs`:
- `validateConfigPath` rejects `../printer.cfg`, `%2e%2e/printer.cfg`, `a\\b.cfg`, `.theme/custom.css`, `foo\0bar.cfg`, leading `/printer.cfg`, `.png`/`.zip`/`.bin`/`.stdata`, and accepts `printer.cfg`, `atom/tool0.cfg`, `Margt NEW/macros.cfg`, `printer.cfg.bak-20260902-1001`, `backup/old.cfg`.
- `classifyConfigFile` hides `.theme/*` and binary files (`null`), flags `.bak*`, `.bkp`, `.backup*`, `*-old`, `.full-*`, `.ring-*`, `backup/*`, `backups/*`, `ShakeTune_results/*` as `isBackup: true` & `readonly: true`, flags `.sh`/`.py` as `isScript: true` & `readonly: true`, flags `permissions: 'r'` (`mainsail.cfg`) as `readonly: true`, and keeps `printer.cfg` / `notes.txt` / `foo.json` with `permissions: 'rw'` as `readonly: false`.
- `validateWritableConfigPath` rejects `mainsail.cfg` (`permissions: 'r'`), `printer.cfg.bak-1` (`isBackup`), `helper.sh`, `tool.py` with HTTP `403`, and allows `printer.cfg` and `atom/tool0.cfg`.
- `validateConfigContent` rejects non-strings, null bytes (`'abc\0def'`), and payloads > `524288` bytes (`413`).
- `checkExpectedModified` passes when timestamps match (within 0.001s) or `force: true`, and throws `409` with `error.code === 'FILE_CHANGED'` and `error.currentModified` when disk `modified` differs.
- `buildConfigUploadFormData` sets `root='config'`, omits `path` for root files (`printer.cfg`), sets `path='atom'` and file name `'tool0.cfg'` for `'atom/tool0.cfg'`.
- `resolveRestartTargetForFile` maps `moonraker.conf` -> `'moonraker'`, `crowsnest.conf` -> `'crowsnest'`, `printer.cfg` / `atom/t0.cfg` -> `'klipper_restart'`, `notes.txt` -> `'none'`.
- `evaluateMachineWriteGuard`:
  - blocks (`409`) when `print_stats.state` is `'printing'` or `'paused'` or `idle_timeout.state === 'Printing'` or active non-uncertain `job` exists;
  - allows (`mode: 'recovery'`) when `queryStatus === 503` and `serverInfo` has `{ klippy_connected: false, klippy_state: 'disconnected' }`;
  - allows (`mode: 'recovery'`) when `queryData.webhooks.state` is `'error'` or `'shutdown'` even when `job.uncertain === true` and `allowUncertainRecovery === true`;
  - blocks (`409`) when `job.uncertain === true` and Klipper is `'ready'`;
  - fails closed (`503`) when `queryStatus === 503` AND `serverInfo` is null/unreachable.
- `validateRestartTarget` allows `klipper_restart`, `firmware_restart`, and allowlisted services present in `availableServices`, and rejects `systemd`, `ssh`, `klipper-backup-on-boot`, or services missing from `availableServices`.
- `normalizeSystemOverview` computes CPU %, RAM used/total/percent, uptime, temp, throttling flags, OS/board metadata while stripping `serial_number` and network MAC/IPs.
- `normalizeUpdateStatus` prioritizes `dirty` (`is_dirty: true`, e.g. `klipper-toolchanger-extended`) > `invalid` (`corrupt` or `!is_valid`, e.g. `tmc-4671`) > `outdated` (`helixscreen v1.0.2 -> v1.0.11` or `system package_count > 0`) > `up_to_date` (keeps `klipper` with untracked-files anomaly as `up_to_date` with `anomalies` preserved).
- `parseLogTail` handles `statusCode: 416` / empty `totalBytes: 0` (`empty: true, lines: []`), drops partial leading line on `statusCode: 206`, caps output to `maxLines` (last 400 lines), and sets `truncated: true` when total exceeds fetched or line cap.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/machine.test.mjs`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `../server/machine.mjs`).

- [ ] **Step 3: Implement `server/machine.mjs`**

Implement all exported functions matching the exact signatures above. Keep `server/machine.mjs` pure (zero network calls) so every safety invariant is deterministically unit-testable. Note: include `encodeMoonrakerPath(relPath)` helper encoding each `/` segment via `encodeURIComponent`.

- [ ] **Step 4: Run test suite to verify pass**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/machine.test.mjs`
Expected: All `tests/machine.test.mjs` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/machine.mjs tests/machine.test.mjs
git commit -m "feat(server): add machine validation, write guards, update and log helpers"
```

---

### Task 2: Backend Calibration Core & Control Wiring (`server/calibration.mjs`, `server/control.mjs`, `tests/calibration.test.mjs`)

**Files:**
- Create: `server/calibration.mjs`
- Modify: `server/control.mjs:1-100`
- Test: `tests/calibration.test.mjs`

**Interfaces:**
- Consumes: `ControlError` from `./control.mjs`, `normalizeStatus` from `./status.mjs`
- Produces:
  - `calibrationActions` (`['calibrate_nudge_ring', 'calibrate_nudge_all', 'calibrate_nudge_restore', 'calibrate_beacon_z', 'calibrate_beacon_all_z', 'calibrate_beacon_abort', 'calibrate_nozzle_expansion', 'calibrate_reset_z_adjust', 'calibrate_fine_qgl', 'calibrate_gantry_twist', 'calibrate_beacon_poke', 'calibrate_shaper_foc']`)
  - `calibrationCapabilities(config) -> { nudgeRing, nudgeAll, nudgeRestore, beaconZ, beaconAllZ, beaconAbort, nozzleExpansion, resetZAdjust, fineQgl, gantryTwist, beaconPoke, shaperFoc }`
  - `calibrationCommand(input, raw, caps) -> { endpoint, body: { script }, label, async: true, timeoutMs: number, restartsKlipper?: boolean }`
  - `validateShakeTuneImagePath(rawPath) -> string | null`
  - `normalizeCalibrationData({ rawStatus, configFiles }) -> CalibrationData`

- [ ] **Step 1: Write failing unit tests in `tests/calibration.test.mjs`**

Assert:
- `calibrationCapabilities(config)` detects configured `gcode_macro ...` keys case-insensitively and returns `false` for absent macros.
- `commandFor` routes all 12 `calibrationActions` cleanly:
  - `calibrate_nudge_ring` -> `NUDGE_CALIBRATE_RING_XY`, `async: true`, `restartsKlipper: true`, `timeoutMs: 2_700_000`; does NOT require pre-homing (macro runs `CHECK_HOMING`), DOES reject when `printState` is `'printing'`/`'paused'` or `idle_timeout === 'Printing'` or macro absent.
  - `calibrate_nudge_all` -> `NUDGE_CALIBRATE_ALL_TOOLS_XY`, `restartsKlipper: true`, `timeoutMs: 2_700_000`.
  - `calibrate_nudge_restore` -> `NUDGE_RESTORE_OFFSETS`.
  - `calibrate_beacon_z` with `{ tool: 2 }` -> `BEACON_CALIBRATE_Z INITIAL_TOOL=2`, rejects `tool: 6` or non-integer, requires `xyz` homed.
  - `calibrate_beacon_all_z` with optional `{ probeTemp: 150 }` (clamped/validated integer `100..220`) -> `BEACON_CALIBRATE_ALL_TOOLS_Z PROBE_TEMP=150`, requires `xyz` homed, rejects if `_BEACON_BATCH_STATE.running === 1`.
  - `calibrate_beacon_abort` -> `BEACON_BATCH_ABORT`, allowed when `_BEACON_BATCH_STATE.running === 1` even if `idle_timeout.state === 'Printing'`, rejected (`409`) when batch not running.
  - `calibrate_nozzle_expansion` with `{ tool: 1 }` -> `BEACON_CALIBRATE_NOZZLE_TEMP_OFFSET INITIAL_TOOL=1`.
  - `calibrate_reset_z_adjust` -> `RESET_ALL_TOOL_Z_ADJUSTMENTS`.
  - `calibrate_fine_qgl` -> `FINE_QUAD_GANTRY_LEVEL`, requires `xyz` homed.
  - `calibrate_gantry_twist` -> `BEACON_MEASURE_GANTRY_TWIST`.
  - `calibrate_beacon_poke` -> `BEACON_POKE_TEST`.
  - `calibrate_shaper_foc` with `{ axis: 'X' | 'Y' | 'ALL' }` -> `SHAPER_CALIBRATE_FOC AXIS=X` / `AXIS=Y` / `SHAPER_CALIBRATE_FOC`, rejects invalid axis, requires `xyz` homed.
- `validateShakeTuneImagePath` accepts `ShakeTune_results/input_shaper/inputshaper_20260817_072751_axis_X.png` and rejects `../printer.cfg`, `ShakeTune_results/foo.stdata`, `ShakeTune_results/../printer.cfg`, `printer.cfg`, `%2e%2e/a.png`.
- `normalizeCalibrationData` builds:
  - `tools[0..5]` with `id`, `offsets`, `relativeZ`, `zAdjust`, `expansionCoeff`, `pressureAdvance`;
  - `nudgeRingClosure: { x, y }` and `nudgeXy[6][6]` (`[x, y]` or `null` on diagonal);
  - `beaconZ[6][6]` (number or `0` on diagonal) and `zReferenceTool`;
  - `beaconBatch: { running, currentInitial, currentMeasure, totalMeasurements, totalTarget: 30 }`;
  - `bedMesh: { active, profileName, min, max, range, meshMin, meshMax, matrix }` (handles empty/unloaded `1x0` mesh cleanly with `active: false, matrix: []`);
  - `qgl: { applied }`, `beacon: { model, coilTemp, lastFreq }`, `inputShaper: { x, y }`;
  - `shakeTune` sorted newest-first with `category: 'input_shaper' | 'belts' | 'vibrations' | 'other'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/calibration.test.mjs`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `../server/calibration.mjs`).

- [ ] **Step 3: Implement `server/calibration.mjs` and wire it into `server/control.mjs`**

In `server/control.mjs`:
- Import `{ calibrationActions, calibrationCapabilities, calibrationCommand } from './calibration.mjs'`.
- Spread `...calibrationCapabilities(config)` into `capabilities(raw)`.
- Include `...calibrationActions` in `permitted`, allow their strict parameter keys (`tool`, `axis`, `probeTemp` only for the matching actions), and delegate `if (calibrationActions.includes(action)) return calibrationCommand(input, raw, capabilities(raw))`.

- [ ] **Step 4: Run tests to verify pass**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/calibration.test.mjs tests/control.test.mjs`
Expected: All calibration and existing control tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/calibration.mjs server/control.mjs tests/calibration.test.mjs
git commit -m "feat(server): add toolchanger calibration normalizer and whitelisted actions"
```

---

### Task 3: Backend `/api/system/*` Endpoints & `server/printer.mjs` Hardening

**Files:**
- Modify: `server/printer.mjs:1-655`
- Test: `tests/machine.test.mjs` (extend with middleware/handler tests using mocked `fetch` or extracted handler)

**Interfaces:**
- Consumes: all exports from `./machine.mjs` and `./calibration.mjs`, `sameOriginRequest` from `./control.mjs`
- Produces HTTP API under `/api/system/*`:
  - `GET /api/system/overview`
  - `GET /api/system/calibration`
  - `GET /api/system/calibration/shaketune-image?path=...`
  - `GET /api/system/config/list`
  - `GET /api/system/config/file?path=...`
  - `POST /api/system/config/save` (JSON `{ path, content, expectedModified?, force?, restart? }`)
  - `POST /api/system/service/restart` (JSON `{ target }`)
  - `GET /api/system/updates`
  - `POST /api/system/updates/refresh` (JSON `{}`)
  - `GET /api/system/logs/list`
  - `GET /api/system/logs/tail?path=...`
  - `GET /api/system/logs/download?path=...` (streamed via `http.get` pipe, no full-RAM buffering)

- [ ] **Step 1: Write failing tests in `tests/machine.test.mjs` for `printerMiddleware` `/api/system/*` routing & safety**

Add tests verifying:
- `POST /api/system/config/save`, `POST /api/system/service/restart`, `POST /api/system/updates/refresh` return `403` without valid loopback origin + `X-Cockpit-Request: 1` + `application/json`, and `405` on `GET`.
- `GET /api/system/config/file?path=../etc/passwd` returns `400`.
- `GET /api/system/calibration/shaketune-image?path=../printer.cfg` returns `400`.
- `GET /api/system/logs/tail?path=../etc/passwd` and `GET /api/system/logs/download?path=../etc/passwd` return `400`.
- `control()` honors `command.restartsKlipper`: if `executeGcodeScript` rejects with a Klipper restart/disconnect message after issuance on a `restartsKlipper: true` command, `currentJob` clears cleanly instead of setting `uncertain: true`.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/machine.test.mjs`
Expected: FAIL (`404 Unbekannter Endpunkt` on `/api/system/*`).

- [ ] **Step 3: Implement `/api/system/*` routes and hardening in `server/printer.mjs`**

Key details pinned by spec:
1. Null-safe `configfile` in `query()` (`const settings = configCache?.settings ?? {}`).
2. In `control()`: use `const stepTimeoutMs = command.timeoutMs ?? 600_000`; when `command.restartsKlipper` is true and an error occurs after `issued` due to WS close / Klippy disconnect / restart (`/(disconnect|restart|unterbrochen|geschlossen)/i`), treat as completed with message `'${command.label}: abgeschlossen — Klipper startet neu.'` and clear `currentJob` cleanly instead of marking `uncertain`.
3. Add helper `probeMachineWriteGuard(allowUncertainRecovery)` that calls `GET ${printer}/printer/objects/query?print_stats&webhooks&idle_timeout`, falls back on non-200/503 or missing `print_stats` to `GET ${printer}/server/info`, and calls `evaluateMachineWriteGuard(...)`.
4. Add helper `streamLogDownload(relPath, res)` using `http.get` to `${printer}/server/files/logs/${encodeMoonrakerPath(relPath)}`, setting `Content-Disposition: attachment; filename="<sanitized basename>"`, `Content-Type: text/plain; charset=utf-8`, forwarding `Content-Length` if present, piping directly to `res` and destroying upstream on `res.on('close')`.
5. For `POST /api/system/config/save`:
   - `readJson(req, 600_000)`
   - Run `probeMachineWriteGuard(true)`
   - Fetch `/server/files/list?root=config`, look up exact entry, call `validateWritableConfigPath`, `validateConfigContent`, `checkExpectedModified` (on `409 FILE_CHANGED` return `json(409, { error: error.message, code: 'FILE_CHANGED', currentModified: error.currentModified })`)
   - Upload via `POST ${printer}/server/files/upload` with `buildConfigUploadFormData(path, content)`
   - Only after upload succeeds (`response.ok`), if `restart` is `'klipper_restart' | 'moonraker' | 'crowsnest'`, execute the corresponding restart endpoint (`POST /printer/restart` or `POST /machine/services/restart?service=...`) and report `{ saved: true, restarted, modified, message }`.
6. For `POST /api/system/service/restart`:
   - Fetch `/machine/system_info` for `available_services`, validate target via `validateRestartTarget`
   - Run `probeMachineWriteGuard(['klipper_restart', 'firmware_restart', 'klipper'].includes(target))`
   - Issue `POST /printer/restart`, `POST /printer/firmware_restart`, or `POST /machine/services/restart` with JSON `{ service }` (and query `?service=...` for compatibility across Moonraker versions).
7. For `GET /api/system/logs/tail`:
   - Validate path, fetch `HEAD` or check size / send `Range: bytes=-131072`, handle `206`, `200`, `416` cleanly via `parseLogTail`.
8. For `GET /api/system/calibration`:
   - Query `bed_mesh`, `quad_gantry_level`, `beacon`, `tools_calibrate`, `save_variables`, `gcode_macro _BEACON_BATCH_STATE`, `toolchanger`, `temperature_sensor beacon_coil`, `extruder..extruder5`, `tool T0..T5`, `configfile=settings` plus `/server/files/list?root=config` (gracefully tolerating missing optional objects).
9. For `GET /api/system/calibration/shaketune-image`:
   - Validate with `validateShakeTuneImagePath`, proxy `/server/files/config/${encodeMoonrakerPath(relPath)}`, enforce `image/png` and ≤ 8 MB, return with `Cache-Control: private, max-age=3600`.

- [ ] **Step 4: Run full backend test suite**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm test`
Expected: All unit tests PASS (existing 59 + all new `machine.test.mjs` and `calibration.test.mjs`).

- [ ] **Step 5: Commit**

```bash
git add server/printer.mjs tests/machine.test.mjs
git commit -m "feat(server): expose /api/system machine, config, calibration, update and log endpoints"
```

---

### Task 4: Design System Token Consolidation & System Styles (`src/style.css`)

**Files:**
- Modify: `src/style.css`

**Interfaces:**
- Produces CSS custom properties on `:root`:
  - `--surface-deep: #12191d`
  - `--surface-subtle: #151d21`
  - `--surface-hover: #212c32`
  - `--line-subtle: #263137`
  - `--line-strong: #4c5d64`
  - `--lime-line: #627c43`
  - `--amber-tint: #2d2a20`
  - `--amber-line: #766543`
  - `--danger: #ffd5d1`
  - `--danger-tint: #412526`
  - `--danger-line: #b56563`
  - `--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
- Produces clean, flat 1 px-bordered layout styles for `.system-subnav`, `.system-metrics-strip`, `.system-services-grid`, `.config-workbench`, `.config-tree`, `.config-editor-pane`, `.cal-section`, `.cal-table`, `.cal-matrix`, `.mesh-heatmap`, `.shaketune-grid`, `.update-table`, `.log-viewer`, and `.skeleton-bar` / `.skeleton-block` (with `prefers-reduced-motion` support).

- [ ] **Step 1: Consolidate tokens & replace raw `SFMono-Regular` font strings in `src/style.css`**

- Add the semantic custom properties to `:root`.
- Replace raw `ui-monospace,SFMono-Regular,Menlo,monospace` in `.console-log` and `.console-entry input` with `var(--font-mono)`.
- Replace repeated status/surface hex literals in `.notice`, `.emergency-stop`, `.history-error`, `.history-rows>li`, `.print-measurements>div`, `.print-thumbnail-button` with the new semantic tokens without altering any existing computed colors.
- Add styles for all four `System` sub-views, skeleton pulse animations (disabled under `prefers-reduced-motion: reduce`), inline confirmation buttons, dirty dot indicator on nav tab, responsive breakpoints at `1150px`, `850px`, `560px`, and **zero `box-shadow`**.

- [ ] **Step 2: Verify CSS builds cleanly and run `impeccable detect`**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build`
Expected: Vite build succeeds with 0 CSS warnings/errors.

- [ ] **Step 3: Commit**

```bash
git add src/style.css
git commit -m "style: consolidate semantic surface, status and mono CSS tokens for system workbench"
```

---

### Task 5: CodeMirror 6 Klipper Language Mode & Persistent Config Editor Store

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/klipper-lang.mjs`
- Create: `src/useConfigEditor.js`
- Create: `src/components/ConfigEditor.vue`

**Interfaces:**
- Consumes: `/api/system/config/list`, `/api/system/config/file`, `/api/system/config/save`
- Produces:
  - `src/klipper-lang.mjs`: `klipperLanguage` (`StreamLanguage` for Klipper `.cfg`/`.conf`/Jinja2) and `stormtrooperEditorTheme` (CodeMirror `EditorView.theme` + `HighlightStyle` using CSS tokens)
  - `src/useConfigEditor.js`: `useConfigEditor()` returning `{ files, loadingList, listError, showBackups, search, currentPath, content, originalContent, modified, size, readonly, isBackup, loadingFile, saving, fileError, saveFeedback, conflict, isDirty, loadFileList, openFile, setContent, discardChanges, saveFile, clearConflict }`
  - `src/components/ConfigEditor.vue`: props `{ printLocked: Boolean, moonrakerOnline: Boolean }`, emits `['saved', 'restarted']`

- [ ] **Step 1: Install CodeMirror 6 minimal packages**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm install @codemirror/view @codemirror/state @codemirror/commands @codemirror/search @codemirror/language`
Expected: Packages added to `package.json` cleanly, zero peer-dependency errors.

- [ ] **Step 2: Implement `src/klipper-lang.mjs`**

Create a lightweight `StreamLanguage.define(...)` parser highlighting:
- Section headers `[section name]` (`heading`)
- Comments `# ...` and `; ...` (`comment`)
- Jinja2 delimiters `{% ... %}`, `{{ ... }}`, `{# ... #}` (`meta` / `keyword`)
- Config keys before `:` or `=` (`propertyName`)
- Numbers, negative floats, hex pin/color values (`number`)
- Booleans `true`/`false`/`True`/`False` and Klipper pin prefixes `!`, `^`, `~` (`atom`)
- Quoted strings (`string`)
Pair with a flat dark `stormtrooperEditorTheme` using `var(--surface-deep)`, `var(--surface)`, `var(--line)`, `var(--lime)`, `var(--amber)`, `var(--muted)`, `var(--font-mono)`, and tabular line numbers.

- [ ] **Step 3: Implement `src/useConfigEditor.js`**

Follow `src/useConsole.js` module-level singleton store pattern:
- Persists `currentPath`, `originalContent`, `content`, `modified`, `readonly`, `isBackup` across top-level and sub-tab switches.
- Attaches a single `window.addEventListener('beforeunload', ...)` guard that prevents accidental page unload only while `isDirty.value === true`.
- `openFile(path)`: loads `GET /api/system/config/file?path=...`, resets `conflict` and `saveFeedback`.
- `saveFile({ restart = 'none', force = false })`: POSTs JSON with `X-Cockpit-Request: 1` and `expectedModified: modified.value`; on `409` with `code === 'FILE_CHANGED'`, populates `conflict.value` instead of discarding user edits; on success updates `originalContent`, `modified`, and `saveFeedback`.

- [ ] **Step 4: Implement `src/components/ConfigEditor.vue`**

Full-width 2-column inline workbench:
- Left pane (`config-tree`): search input, `Backups anzeigen` checkbox, grouped collapsible folders (`(Hauptverzeichnis)` first, auto-expanded while searching), active file highlight, `RO` tag for `readonly` files, skeleton during initial fetch, mobile collapsible drawer toggle.
- Right pane (`config-editor-pane`):
  - Header showing path, formatted file size & modified time, `Ungespeichert` (Amber) / `Schreibgeschützt` pills.
  - Action buttons: `Verwerfen`, `Speichern` (bound to `Cmd/Ctrl+S`), and context-sensitive `Speichern & Klipper-Neustart` / `Speichern & Moonraker-Neustart` / `Speichern & Crowsnest-Neustart` (shown only on writable `.cfg`/`.conf` files).
  - Inline Amber dirty-switch banner when clicking another file while `isDirty` (`Verwerfen & wechseln` / `Bleiben`).
  - Inline Amber conflict banner when `conflict` is set (`Neu laden (Änderungen verwerfen)` / `Trotzdem überschreiben`).
  - Print-lock banner when `printLocked` is true (CodeMirror switches `EditorState.readOnly.of(true)` dynamically via `Compartment`).
  - CodeMirror 6 mounted in a clean ref container with `lineNumbers()`, `highlightActiveLine()`, `highlightActiveLineGutter()`, `search()`, `history()`, `defaultKeymap`, `searchKeymap`, `historyKeymap`, `klipperLanguage`, `stormtrooperEditorTheme`, and `Cmd/Ctrl+S` save command; cleanly destroyed in `onBeforeUnmount`.

- [ ] **Step 5: Verify build & chunk splitting**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build`
Expected: Build succeeds; CodeMirror lives in an async chunk separate from `index-*.js`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/klipper-lang.mjs src/useConfigEditor.js src/components/ConfigEditor.vue
git commit -m "feat(ui): add lazy-loaded CodeMirror 6 Klipper config editor and persistent draft store"
```

---

### Task 6: System Overview & Maintenance Views (`SystemOverview.vue`, `SystemMaintenance.vue`)

**Files:**
- Create: `src/components/SystemOverview.vue`
- Create: `src/components/SystemMaintenance.vue`

**Interfaces:**
- `SystemOverview.vue`:
  - Props: `{ status: Object, online: Boolean, printLocked: Boolean, uncertainOnly: Boolean, overview: Object, loadingOverview: Boolean, overviewError: String, time: String }`
  - Emits: `['refresh-overview', 'restarted']`
- `SystemMaintenance.vue`:
  - Props: `{ printLocked: Boolean, moonrakerOnline: Boolean }`
  - Emits: `['moonraker-status']`

- [ ] **Step 1: Implement `src/components/SystemOverview.vue`**

Contains:
1. Horizontal 4-cell Host Metrics Strip (CPU %, RAM used/total GB & %, Host Temp °C, Uptime) with calm skeleton placeholders while `loadingOverview && !overview`, plus OS/Board/Kernel caption and Amber throttling alert banner when `overview.throttledFlags.length > 0`.
2. Two-column core status panels matching existing `System` view: **Druckerstatus** (Klipper, print state, file/progress/duration, toolchanger, active/detected tool, homed axes, Klipper message) and **Temperaturen** (Bed, Chamber, Raspberry Pi, Octopus, RP2350, Beacon coil + live transport notice).
3. Full-width **Neustart & Dienste** panel:
   - Primary buttons: `Klipper neu starten` (`klipper_restart`) and `Firmware-Neustart` (`firmware_restart`).
   - Service list from `overview.services` showing service name, live state pill (`Aktiv` / `Inaktiv`), and `Neu starten`.
   - Inline 2-step confirmation per button (`Wirklich neu starten?` + `Abbrechen`, auto-cancels after 6 s) — zero `window.confirm()`.
   - Disabled with clear banner during active/paused print or active control job; remains enabled for Klipper/Firmware recovery when Klippy is in `error`/`shutdown`/disconnected and Moonraker is reachable.
4. Existing CAD reference note panel at bottom.

- [ ] **Step 2: Implement `src/components/SystemMaintenance.vue`**

Contains:
1. **Software & Updates** panel:
   - Header summary (`{total} Komponenten · {outdated} Updates · {dirty} lokal geändert`) + `Status prüfen` button (`POST /api/system/updates/refresh`, disabled while `busy` or `printLocked`).
   - Skeleton loader during initial fetch; clean table of all components sorted (`dirty` first, then `invalid`, `outdated`, `up_to_date`):
     - Component name + type/branch
     - Current version → remote version (or package count for `system`)
     - Status pill: **Amber `Lokal geändert`** (`dirty`, with alert icon + visible warning summary of modified files), Amber `Abweichend` (`invalid`), Lime `Update verfügbar` (`outdated`), Muted `Aktuell` (`up_to_date`)
     - Expandable `<details>` for `warnings`/`anomalies` when present.
2. **Log-Viewer** panel:
   - Quick-select segmented buttons for primary logs (`klippy.log`, `moonraker.log`, `crowsnest.log`, `mobileraker.log`) plus `CockpitSelect` for all remaining/rotated logs with formatted file size.
   - Controls: search input within loaded lines, `Nur Fehler/Warnungen` toggle, `Aktualisieren`, `Nach unten`, and native `<a download>` link to `/api/system/logs/download?path=...` (`Vollständig laden`).
   - Truncation/meta caption (`Letzte {0} Zeilen ({1} von {2})`) or calm empty-file state (`Logdatei ist leer.`), skeleton while fetching, `--font-mono` preformatted viewer with subtle line highlighting for `ERROR`/`Traceback`/`Shutdown`/`WARNING`.

- [ ] **Step 3: Verify build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build`
Expected: Build succeeds cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/components/SystemOverview.vue src/components/SystemMaintenance.vue
git commit -m "feat(ui): add SystemOverview and SystemMaintenance views"
```

---

### Task 7: Toolchanger Calibration View (`src/components/SystemCalibration.vue`)

**Files:**
- Create: `src/components/SystemCalibration.vue`

**Interfaces:**
- Props: `{ status: Object, online: Boolean, pending: Boolean, send: Function }`
- Emits: `['open-console']`

- [ ] **Step 1: Implement `src/components/SystemCalibration.vue`**

Fetches `GET /api/system/calibration` on mount and via manual refresh (plus auto-refresh after a calibration action completes). Renders three calm sections:
1. **Werkzeug-Offsets (`T0`–`T5` — Nudge XY, Beacon Z & Thermik):**
   - Header metric pill for Nudge Ring Closure (`Ringschluss X / Y` in mm, tabular-nums) + reference tool indicator.
   - Live Amber/Lime banner when `data.beaconBatch.running` is true (`Beacon-Batch läuft · {0}/{1} Messungen`) with inline 2-step `Batch abbrechen` button (`calibrate_beacon_abort`).
   - 6-row table (`T0`–`T5`): X, Y, Z, ΔZ, Z-Anpassung, Ausdehnung (`µm/°C`), Pressure Advance.
   - Collapsible `<details>` with **6×6-Paarmatrix** and segmented toggle (`Nudge XY` | `Beacon Z`).
   - Action groups with inline 2-step confirmation (6 s auto-reset), capability-gated, disabled during print/pending/offline/unhomed (with explicit tooltip/note why disabled):
     - Nudge XY: `Nudge Ring XY` (notes `SAVE_CONFIG` + Klipper restart), `Nudge Voll XY` (notes 30 measurements + `SAVE_CONFIG`), `Nudge-Offsets wiederherstellen`.
     - Beacon Z & Thermik: `CockpitSelect` for reference tool (`T0`–`T5`), `Beacon Z (Referenz)`, `Beacon Z alle Tools`, `Düsen-Ausdehnung`, `Z-Anpassungen zurücksetzen`.
   - Quiet action link `Ergebnisse in der Konsole ansehen →` emitting `open-console`.
2. **Geometrie, Bett-Mesh & Beacon:**
   - Two-column grid:
     - Left: QGL status + `QGL` (`qgl`), `Fein-QGL` (`calibrate_fine_qgl`), `Bett vermessen` (`mesh`) + active Bed Mesh summary (profile, Min/Max/Range mm) + calm 2D SVG Heatmap (Graphite → Cool Cyan → Lime → Amber scale, hover tooltip showing X/Y index & exact Z mm) or clean empty state (`Aktuell kein Bett-Mesh geladen.`).
     - Right: Beacon status (model, coil temp °C, last frequency) + `Gantry-Twist messen` (`calibrate_gantry_twist`) and `Beacon Poke-Test` (`calibrate_beacon_poke`).
3. **Input Shaper & ShakeTune:**
   - Active X & Y shaper cards (type, Hz, damping ratio) + `CockpitSelect` (`X + Y` / `Nur X` / `Nur Y`) + `Shaper kalibrieren (FOC)` (`calibrate_shaper_foc`).
   - ShakeTune diagram gallery (`ShakeTune_results/`): segmented category filter (`Alle` | `Input Shaper` | `Riemen` | `Vibrationen`), clickable preview cards loading `/api/system/calibration/shaketune-image?path=...`, opening a native `<dialog class="camera-dialog shaketune-dialog">` lightbox on click.

- [ ] **Step 2: Verify build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build`
Expected: Build succeeds cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/components/SystemCalibration.vue
git commit -m "feat(ui): add 6-toolchanger SystemCalibration view with Bed Mesh heatmap and ShakeTune gallery"
```

---

### Task 8: `SystemView.vue`, `App.vue` Integration & Full DE/EN Translations

**Files:**
- Create: `src/components/SystemView.vue`
- Modify: `src/App.vue`
- Modify: `src/locales/en.json`
- Modify: `src/i18n.mjs` (if any new dynamic translation patterns are needed)

**Interfaces:**
- `SystemView.vue`:
  - Props: `{ status: Object, online: Boolean, pending: Boolean, send: Function, subtab: String, time: String }`
  - Emits: `['update:subtab', 'open-console']`
- `App.vue`:
  - Supports `#system`, `#system/overview`, `#system/config`, `#system/calibration`, `#system/maintenance` hash URLs (backwards compatible with `#system`).
  - Lazy-loads `SystemView` via `defineAsyncComponent`.
  - Reads `isDirty` from `useConfigEditor()` to render a subtle Amber unsaved dot on the `System` navigation button.

- [ ] **Step 1: Implement `src/components/SystemView.vue`**

- Renders 4-tab `.system-subnav` (`Übersicht` | `Konfiguration` | `Kalibrierung` | `Wartung`) with icons and Amber dirty indicator on `Konfiguration`.
- Lazily loads `ConfigEditor.vue` via `defineAsyncComponent` so CodeMirror 6 only downloads when `Konfiguration` is opened.
- Polls `GET /api/system/overview` every 5 s **only while `subtab === 'overview'` and `!document.hidden`**; immediately aborts/clears timer on sub-tab switch or unmount (preserves 0 % idle efficiency).
- Tracks independent `moonrakerOnline` ref from `/api/system/overview` / child responses so `Konfiguration`, `Neustarts`, and `Wartung` stay functional even if Klippy is disconnected/error.
- Computes `printLocked` (`['printing', 'paused'].includes(status?.printState) || (status?.control?.job && !status.control.job.uncertain)`).

- [ ] **Step 2: Wire `SystemView.vue` into `src/App.vue`**

- Replace inline `<section v-if="tab === 'system'">...</section>` with `<SystemView v-if="tab === 'system'" ... />`.
- Parse initial `location.hash` for `#system/<subtab>` and sync `watch([tab, systemSubtab], ...)` cleanly.
- Add subtle Amber dot `<span v-if="configEditor.isDirty.value" class="nav-dirty-dot" ... />` on the `System` nav button.
- Update `pageHeading` / `pageSubtitle` for `system` to reflect the Machine workbench (`System & Maschine.` / `Host, Konfiguration, Kalibrierung und Wartung deines Toolchangers.`).

- [ ] **Step 3: Add all English translations in `src/locales/en.json` (and dynamic patterns in `src/i18n.mjs`)**

- Add every new German `t(...)` key used in `SystemView.vue`, `SystemOverview.vue`, `ConfigEditor.vue`, `SystemCalibration.vue`, `SystemMaintenance.vue`, `useConfigEditor.js`, and `App.vue` to `src/locales/en.json`.
- Add any new dynamic feedback patterns to `src/i18n.mjs` and assert them in `tests/i18n.test.mjs`.

- [ ] **Step 4: Run full test suite & production build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm test && npm run build`
Expected: 100 % of tests PASS (including `tests/i18n.test.mjs` zero missing keys, zero `t(t(...))`) and production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/SystemView.vue src/App.vue src/locales/en.json src/i18n.mjs tests/i18n.test.mjs
git commit -m "feat(ui): integrate 4-tab System Machine workbench with DE/EN translations"
```

---

### Task 9: Final Verification (Impeccable Audit + Read-Only Live Browser Verification)

**Files:**
- Verify only (fix any visual, responsive, or lint issues discovered before final commit)

- [ ] **Step 1: Run Impeccable mechanical quality check**

Run: `export PATH="/opt/homebrew/bin:$PATH" && impeccable detect --json --changed` (or `npx`/global binary check if available) and inspect any warnings.

- [ ] **Step 2: Restart local Vite dev server on `http://127.0.0.1:4173/` and perform read-only Playwright visual verification**

- Restart background Vite server cleanly so it loads the new `server/*.mjs` routes.
- Run a **strictly read-only** headless Chrome Playwright script capturing Desktop (`1440×900`) and Mobile (`390×844`) screenshots of:
  - `#system` (`Übersicht`: real host metrics, services, status, temperatures)
  - `#system/config` (`Konfiguration`: real config tree + `printer.cfg` opened in CodeMirror 6, verifying zero console/page errors, zero horizontal overflow)
  - `#system/calibration` (`Kalibrierung`: real 6-tool offsets, Nudge Ring Closure, 6×6 matrix expanded, Bed Mesh, ShakeTune gallery + lightbox)
  - `#system/maintenance` (`Wartung`: real 16 update repos with Amber `Lokal geändert` badge on `klipper-toolchanger-extended`, and `klippy.log` tail viewer)
  - `#tools` (regression check: unchanged & clean)
- Inspect every screenshot with `read_file` to verify visual craft, typography, alignment, contrast, and responsive layout.

- [ ] **Step 3: Security & hygiene check before completion**

Run:
```bash
export PATH="/opt/homebrew/bin:$PATH"
npm test && npm run build
git status
git grep -n "192\.168\." -- ':!.env*' || echo "NO_PRIVATE_IPS"
```
Expected: All tests PASS, clean build, zero private IPs in tracked files, clean working tree (commit any visual polish fixes first).
