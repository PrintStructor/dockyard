# DOCKYARD Paket 1: Single-Tool & Multi-Printer Klipper Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable zero-config Klipper auto-discovery, controls, dynamic 3D bed sizing, and clean UI adaptation across single-tool VORONs (V2.4, Trident, V0.1, Crucible) and N-toolchangers while keeping the existing 6-toolchanger `STORMTROOPER` experience and all 125 tests 100% intact.

**Architecture:** Extend `server/status.mjs`, `server/control.mjs`, `server/tool-actions.mjs`, `server/printer.mjs`, and `server/live.mjs` to discover extruders (`1..8`), `isToolchanger`, leveling (`quad_gantry_level` / `z_tilt` / none), standard `[fan]` part cooling, real bed dimensions (`stepper_x`/`stepper_y`), temperature/filament sensors, and toolhead neopixels dynamically from Moonraker `/printer/objects/list` + `configfile.settings`. Add forward-compatible `model.preset` (`auto | stormtrooper-6tc | none`) to printer profiles, decouple 3D scene visibility from hardware UI mode, add a focused `SingleToolOverview.vue` dashboard, and adapt Controls, Print 3D (`uBedCenter` + dynamic canvas grid), History, and System views.

**Tech Stack:** Node.js 22+ (`node:test`), Vue 3 (`<script setup>`), Three.js / WebGL shaders, Vite, `@lucide/vue`, `DESIGN.md` flat graphite/lime tokens.

**Spec:** [2026-11-25-single-tool-and-multi-printer-support-design.md](../specs/2026-11-25-single-tool-and-multi-printer-support-design.md)

## Global Constraints
- Visual design strictly follows `DESIGN.md`: flat graphite (`#111618` / `#192125` / `#1b252a`), `1px solid #354147` borders, `#c5f76b` lime accents, `#f3c67b` amber warnings, bundled `Onest` font, tabular numerals, zero decorative CSS box-shadows, 44px touch targets in `display-mode`.
- Zero regression for `STORMTROOPER` (6-toolchanger) and all 125 existing tests must pass unmodified.
- Hardware UI mode (`isSingleTool`) is driven strictly by Klipper capabilities (`toolCount === 1 && !isToolchanger`), completely independent from `model.preset` (`show3dScene`).
- `isToolchanger` is strictly `Boolean(raw.toolchanger || config.toolchanger)` so multi-extruder/IDEX printers without `klipper-toolchanger` are never blocked by toolchanger guards.
- Never execute mutating commands against any physical printer; all tests and browser verification run against mock/offline loopback servers.
- Every static German `t('...')` string in `src/` and all new dynamic error/label strings must have complete English translations in `src/locales/en.json`.

## Review Focus
1. **Cold-start `#controls` landing on a single-tool printer before `/api/status` warms `capabilityCache`** — `GET /api/temperature-history` must infer `toolCount` directly from Moonraker's `temperature_store` keys when `capabilityCache` is null so it returns `['Extruder', 'Bett']` rather than 6 empty `T0–T5` lines.
2. **Paused print `RESUME` on single-tool VORONs (V2.4, Trident, V0.1, Crucible)** — must succeed when `klipperState === 'ready'`, `printState === 'paused'`, `RESUME` macro exists, and `xyz` homed without blocking on `toolchangerState` or `detected == null`, while keeping full toolchanger safety guards when `isToolchanger === true`.
3. **Switching live from a 350 mm V2.4 to a 120 mm V0.1 while `Print` tab is active** — `PrintScene.vue` must rebuild the bed mesh, grid canvas, `uBedCenter` shader uniform, crosshair, and camera framing to `120 × 120 mm` with zero stale `350 × 350 mm` geometry or label left over.
4. **Single-tool printer with zero neopixels (V0.1 / Crucible)** — `server/live.mjs` must skip LED polling cleanly while keeping SSE `ping` heartbeats and disconnect detection working; `normalizeStatus` must return `null` LEDs without throwing.
5. **Non-zero `stepper_x`/`stepper_y` negative endstop minimum (e.g. `position_min: -5`, `position_max: 300`)** — `bedSize` must anchor printable `originX`/`originY` at `Math.max(0, min)` when `min <= 0` so a `300 × 300 mm` Trident renders as `300 × 300 mm` centered at `(150, 150)`, not `305 × 305 mm`.

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Modify | `server/status.mjs` | Dynamic `isToolchanger`, `toolCount`, `bedSize`, `zTiltApplied`, `sensors[]`, single-tool filament/neopixel binding, `[fan]` part cooling in `fans[]` |
| Modify | `server/temperature.mjs` | Optional `{ toolCount }` arg + `inferExtruderCountFromStore(store)` helper preserving 2-arg compatibility |
| Modify | `server/presets.mjs` | Optional `toolCount` sizing in `normalizePresets` |
| Modify | `server/calibration.mjs` | Expose `isToolchanger`, `toolCount`, `zTilt` status & `capabilities.zTilt` |
| Modify | `server/control.mjs` | Dynamic `toolMax`, `zTilt`, `leveling`, `bedSize`, `action: 'z_tilt'`, `[fan]` `M106`, dynamic `temperature` / `temperature_all` |
| Modify | `server/tool-actions.mjs` | Include `[fan]` (`__part_fan__`) in `fans`; support single-tool `LOAD_FILAMENT`/`UNLOAD_FILAMENT`/`CLEAN_NOZZLE`/`PURGE_NOZZLE` without `T=0` or `PICKUP_TOOL` |
| Modify | `server/aux-controls.mjs` | Preserve toolchanger-only `initialize`/`loadWatch` capabilities |
| Modify | `server/live.mjs` | Dynamically discover and subscribe to extruders, `z_tilt`, `fan`, sensors, filament sensors, neopixels; adapt LED polling to discovered toolhead neopixels (skip when none) |
| Modify | `server/printer.mjs` | Dynamic object discovery in `query()` and `calibration`, pass inferred `toolCount` to `temperatureHistory` & `normalizePresets`, update `live` subscription objects |
| Modify | `server/settings.mjs` | Add backwards-compatible `model: { preset: 'auto' | 'stormtrooper-6tc' | 'none' }` validation & default |
| Modify | `src/aux-action-state.mjs` | Allow single-tool `resume` without `toolchangerState`/`detected`; add `quickMotionReason` support for `'z_tilt'` |
| Modify | `src/tool-action-state.mjs` | Support single-tool maintenance actions (`load`, `unload`, `clean`, `purge`) without toolchanger/sensor/Z<=300 dock locks |
| Modify | `src/useSettings.js` | Preserve `model.preset` on clone, export, import, merge |
| Modify | `src/components/SettingsDialog.vue` | Add `3D-Ansicht / Modell` (`model.preset`) selector in Tab 1 (`Drucker & Verbindung`) |
| Create | `src/components/SingleToolOverview.vue` | Clean Single-Tool Overview card (Extruder & Bed dual thermal gauges, inline target inputs, filament sensor pill, dynamic sensor readout, quick single-tool macros, FanControl) |
| Modify | `src/App.vue` | Decouple `isSingleTool` vs `show3dScene`, render `SingleToolOverview` for single-tool printers, dynamic `0..toolCount-1` cards for N-tool without 3D, dynamic `QGL`/`Z-Tilt` in Machine Deck, dynamic nav label (`Übersicht` vs `Werkzeuge`) |
| Modify | `src/components/ControlsView.vue` | Dynamic `QGL`/`Z-Tilt`/omitted leveling button, `zTiltApplied` motor-off confirm, single-extruder heating layout when `toolCount === 1` |
| Modify | `src/components/PrintScene.vue`, `src/components/PrintView.vue` | Dynamic `bedSize` (`uBedCenter`, grid canvas, label, camera fit, nozzle/exclude coords) & single-tool color/legend simplification |
| Modify | `src/components/HistoryView.vue` | Hide `T0–T5` / `Multi-Tool` tool filter when `!isToolchanger` |
| Modify | `src/components/SystemOverview.vue`, `src/components/SystemCalibration.vue` | Dynamic sensor list & hide toolchanger rows when `!isToolchanger`; hide 6×6 matrices and show `Z-Tilt` card/action in Calibration |
| Modify | `src/style.css`, `src/locales/en.json`, `README.md` | Graphite/lime single-tool overview styles, full EN translations, updated multi-VORON fleet docs |
| Create | `tests/single-tool.test.mjs` | Comprehensive backend + state unit tests for single-tool V2.4, Trident, V0.1, Crucible, and IDEX edge cases |

---

### Task 1: Dynamic Klipper Status, Bed Geometry, Sensors, Temperature & Calibration Normalization

**Files:**
- Modify: `server/status.mjs`
- Modify: `server/temperature.mjs`
- Modify: `server/presets.mjs`
- Modify: `server/calibration.mjs`
- Create: `tests/single-tool.test.mjs`

**Interfaces:**
- Produces (`server/status.mjs`):
  - `detectToolCount(raw, config): number` (exported helper for `control.mjs` & `tool-actions.mjs`)
  - `extractBedSize(raw, config): { originX: number, originY: number, width: number, depth: number } | null`
  - `normalizeStatus(raw, at?)` adding: `isToolchanger: boolean`, `toolCount: number`, `zTiltApplied: boolean`, `levelingApplied: boolean`, `bedSize`, `sensors: Array<{ id, name, label, temperature, target }>`, `fans` including `{ name: '__part_fan__', label: 'Bauteillüfter', kind: 'part_fan', percent }` when `raw.fan` present, and `tools[0].filamentSensorName` / single-tool LED & filament fallback.
- Produces (`server/temperature.mjs`):
  - `inferExtruderCountFromStore(store): number`
  - `temperatureHistory(store, sampledAt?, { toolCount }?)` (default `toolCount = null` keeps 2-arg `T0..T5 + Bett` behavior intact).
- Produces (`server/presets.mjs`):
  - `normalizePresets({ mainsail, legacy, toolCount = 6 }?)`
- Produces (`server/calibration.mjs`):
  - `normalizeCalibrationData` adding `isToolchanger`, `toolCount`, `zTilt: { configured, applied, retries, retryTolerance, horizontalMoveZ }`, and `capabilities.zTilt`.

- [ ] **Step 1: Write failing unit tests in `tests/single-tool.test.mjs`**
  Cover:
  - Single-tool VORON 2.4 (`extruder`, `quad_gantry_level`, `neopixel sb_leds`, `fan`, `stepper_x/y 0..350`): `isToolchanger === false`, `toolCount === 1`, `active === 0`, `tools[0].leds.number/left/right` mapped from `sb_leds`, `fans[0]` is `{ name: '__part_fan__', kind: 'part_fan', percent: 75 }`, `bedSize` is `350×350`.
  - Single-tool Trident (`z_tilt: { applied: true }`, `stepper_x: { position_min: -5, position_max: 300 }`, `stepper_y: { position_min: 0, position_max: 300 }`, `filament_motion_sensor encoder_sensor`): `zTiltApplied === true`, `levelingApplied === true`, `bedSize` is `{ originX: 0, originY: 0, width: 300, depth: 300 }` (Review Focus #5), `tools[0].filamentDetected === true`, `tools[0].filamentSensorName === 'encoder_sensor'`.
  - Single-tool V0.1 (`120×120`, no leveling, no neopixels, `temperature_sensor skr_pico` + `temperature_sensor host`): `qglApplied === false`, `zTiltApplied === false`, `tools[0].leds.number === null`, `sensors` includes `skr_pico` and `host`.
  - Multi-extruder without `[toolchanger]` (`extruder`, `extruder1`): `isToolchanger === false`, `toolCount === 2`.
  - `temperatureHistory(store, ts, { toolCount: 1 })` returns 2 series (`Extruder`, `Bett`); `inferExtruderCountFromStore({ extruder: {}, heater_bed: {} }) === 1`; 2-arg `temperatureHistory(store, ts)` still returns 7 series (`T0..T5`, `Bett`).
  - `normalizeCalibrationData` includes `isToolchanger: false`, `toolCount: 1`, `zTilt.configured === true`, `capabilities.zTilt === true`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/single-tool.test.mjs`
  Expected: FAIL.

- [ ] **Step 3: Implement changes in `server/status.mjs`, `server/temperature.mjs`, `server/presets.mjs`, and `server/calibration.mjs`**
  - Implement `detectToolCount`, `extractBedSize`, dynamic `sensors`, `[fan]` part cooling, single-tool filament/neopixel discovery in `server/status.mjs`.
  - Ensure `normalizeStatus({})` still sets `active: null` so `tests/status.test.mjs` stays 100% unmodified & green.
  - Implement `inferExtruderCountFromStore` and `{ toolCount }` option in `server/temperature.mjs`.
  - Add `toolCount` sizing to `server/presets.mjs`.
  - Add `isToolchanger`, `toolCount`, and `zTilt` to `server/calibration.mjs`.

- [ ] **Step 4: Run tests**
  Run: `node --test tests/single-tool.test.mjs tests/status.test.mjs tests/temperature.test.mjs tests/presets.test.mjs tests/calibration.test.mjs`
  Expected: All PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add server/status.mjs server/temperature.mjs server/presets.mjs server/calibration.mjs tests/single-tool.test.mjs
  git commit -m "feat(single-tool): add dynamic tool count, bed geometry, sensors, Z-tilt, and part fan normalization"
  ```

---

### Task 2: Dynamic Capabilities, `Z_TILT`, `[fan]` Control, Single-Tool Macros & Live Subscription

**Files:**
- Modify: `server/control.mjs`
- Modify: `server/tool-actions.mjs`
- Modify: `src/aux-action-state.mjs`
- Modify: `src/tool-action-state.mjs`
- Modify: `server/live.mjs`
- Modify: `server/printer.mjs`
- Test: `tests/single-tool.test.mjs`, `tests/live.test.mjs`

**Interfaces:**
- Consumes: `detectToolCount`, `extractBedSize`, `normalizeStatus` from Task 1 (`server/status.mjs`); `inferExtruderCountFromStore`, `temperatureHistory` from `server/temperature.mjs`; `normalizePresets` from `server/presets.mjs`.
- Produces (`server/control.mjs`):
  - `capabilities(raw)` adding `isToolchanger`, `toolCount`, `zTilt`, `leveling`, `bedSize`, dynamically-sized `toolMax`, and `fans` including `{ name: '__part_fan__', label: 'Bauteillüfter', kind: 'part_fan' }`.
  - `commandFor({ action: 'z_tilt' }, raw)` → `Z_TILT_ADJUST`, `async: true`.
  - `commandFor({ action: 'fan', fan: '__part_fan__', percent }, raw)` → `M106 S<0..255>`.
  - `commandFor({ action: 'temperature', heater: 'extruder', target }, raw)` → label `'Extruder auf N °C'` on single-tool.
  - `commandFor({ action: 'temperature_all', target }, raw)` → `409` on single-tool; heats `0..toolCount-1` on multi-tool.
- Produces (`src/aux-action-state.mjs`):
  - `auxActionReason(status, 'resume', ...)` allows single-tool resume without `toolchangerState`/`detected` (Review Focus #2).
  - `quickMotionReason(status, 'z_tilt', ...)` validates `capabilities.zTilt` + `xyz` homed.
- Produces (`src/tool-action-state.mjs` & `server/tool-actions.mjs`):
  - Single-tool `load` / `unload` / `clean` / `purge` macro checks and commands (`LOAD_FILAMENT`, `UNLOAD_FILAMENT`, `CLEAN_NOZZLE`, `PURGE_NOZZLE` without `T=0` or `PICKUP_TOOL`).
- Produces (`server/live.mjs`):
  - Dynamic object subscription & adaptive LED polling only for discovered toolhead neopixels (skips LED polling when none exist — Review Focus #4).

- [ ] **Step 1: Add failing tests to `tests/single-tool.test.mjs` and `tests/live.test.mjs`**
  Cover:
  - `z_tilt` command generation (`Z_TILT_ADJUST`), homing guard, print lock, and rejection when `z_tilt` unconfigured.
  - `[fan]` part cooling (`__part_fan__`, `50%` → `M106 S128`, `0%` → `M106 S0`).
  - Single-tool `temperature` (`Extruder auf 210 °C`) and `temperature_all` rejected with `409`.
  - Single-tool `RESUME` allowed when paused & homed without `toolchanger` (Review Focus #2), while toolchanger `RESUME` still rejects missing `detected`.
  - Single-tool `LOAD_FILAMENT` / `UNLOAD_FILAMENT` / `CLEAN_NOZZLE` / `PURGE_NOZZLE` execute cleanly without `T=0` or `PICKUP_TOOL`; `park`/`pickup`/`select` rejected.
  - `GET /api/temperature-history` cold-start (before `/api/status`) returns 2 series (`Extruder`, `Bett`) for a single-tool mock Moonraker (Review Focus #1).
  - `live.mjs`: on a printer with `neopixel sb_leds`, polls `neopixel sb_leds`; on a V0.1 with zero neopixels, emits initial `status` and `ping` heartbeats with zero `id: 3` LED query frames (Review Focus #4).

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test tests/single-tool.test.mjs tests/live.test.mjs`
  Expected: FAIL.

- [ ] **Step 3: Implement backend control, state guards, live discovery, and printer query updates**
  - Update `server/control.mjs`, `server/tool-actions.mjs`, `src/aux-action-state.mjs`, `src/tool-action-state.mjs`.
  - Update `server/live.mjs` to discover dynamic objects (`extruder*`, `tool T*`, `z_tilt`, `quad_gantry_level`, `fan`, `fan_generic *`, `temperature_sensor *`, `temperature_fan *`, `filament_switch_sensor *`, `filament_motion_sensor *`, `neopixel *`, `led_effect *`) and select `polledLedObjects` cleanly (empty array skips LED poll).
  - Update `server/printer.mjs` `query()` to discover the same dynamic objects from `/printer/objects/list` instead of querying nonexistent `extruder1..5` / hardcoded sensors, include `'z_tilt'` in `calibration` query, and pass `toolCount` into `temperatureHistory` (with `inferExtruderCountFromStore` fallback on cold start) and `normalizePresets`.

- [ ] **Step 4: Run full backend test suite**
  Run: `npm test`
  Expected: All existing 125 tests + new single-tool & live tests PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add server/control.mjs server/tool-actions.mjs server/live.mjs server/printer.mjs src/aux-action-state.mjs src/tool-action-state.mjs tests/single-tool.test.mjs tests/live.test.mjs
  git commit -m "feat(single-tool): add Z-tilt, part fan, single-tool macros, resume guard, and dynamic live discovery"
  ```

---

### Task 3: Printer Profile `model.preset` Schema & Settings UI

**Files:**
- Modify: `server/settings.mjs`
- Modify: `src/useSettings.js`
- Modify: `src/components/SettingsDialog.vue`
- Modify: `src/locales/en.json`
- Test: `tests/settings.test.mjs`, `tests/settings-client.test.mjs`

**Interfaces:**
- Produces (`server/settings.mjs`):
  - `MODEL_PRESETS = ['auto', 'stormtrooper-6tc', 'none']`
  - Every validated printer profile includes `model: { preset: 'auto' | 'stormtrooper-6tc' | 'none' }` (defaults to `{ preset: 'auto' }` for legacy profiles missing `model`).
- Produces (`src/useSettings.js`):
  - `clonePrinterProfile` / `buildPrintersExport` / `parsePrintersImport` / `mergePrinterProfiles` preserve `model: { preset }`.

- [ ] **Step 1: Write failing tests in `tests/settings.test.mjs` and `tests/settings-client.test.mjs`**
  Cover:
  - Missing `model` defaults to `{ preset: 'auto' }`.
  - Valid presets `'auto'`, `'stormtrooper-6tc'`, `'none'` persist and roundtrip via JSON export/import.
  - Invalid `model.preset` (e.g. `'bogus'`) throws validation error.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test tests/settings.test.mjs tests/settings-client.test.mjs`
  Expected: FAIL.

- [ ] **Step 3: Implement `model.preset` in `server/settings.mjs`, `src/useSettings.js`, `src/components/SettingsDialog.vue`, and `src/locales/en.json`**
  - Add `normalizeModelSetting` in `server/settings.mjs`.
  - Preserve `model` in `src/useSettings.js` and `SettingsDialog.vue` draft/save/addPrinter/duplicatePrinter.
  - Add `3D-Ansicht / Modell` (`CockpitSelect`) inside Tab 1 (`Profil bearbeiten`) in `SettingsDialog.vue` with options:
    - `auto`: `Automatisch (Standard)`
    - `stormtrooper-6tc`: `STORMTROOPER 6-Toolchanger (3D CAD)`
    - `none`: `Kompakt (ohne 3D-Szene)`
  - Add English translations in `src/locales/en.json`.

- [ ] **Step 4: Run tests**
  Run: `node --test tests/settings.test.mjs tests/settings-client.test.mjs tests/i18n.test.mjs`
  Expected: All PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add server/settings.mjs src/useSettings.js src/components/SettingsDialog.vue src/locales/en.json tests/settings.test.mjs tests/settings-client.test.mjs
  git commit -m "feat(single-tool): add per-printer model.preset setting (auto, stormtrooper-6tc, none)"
  ```

---

### Task 4: Single-Tool Overview Component & Decoupled Tools/Übersicht Layout in `App.vue`

**Files:**
- Create: `src/components/SingleToolOverview.vue`
- Modify: `src/App.vue`
- Modify: `src/style.css`
- Modify: `src/locales/en.json`

**Interfaces:**
- Consumes: `status.isToolchanger`, `status.toolCount`, `status.bedSize`, `status.sensors`, `status.zTiltApplied`, `status.capabilities` (`qgl`, `zTilt`, `mesh`, `toolActions`), `settingsStore.activePrinter.model.preset`.
- Produces (`src/components/SingleToolOverview.vue`):
  - Props: `status`, `online`, `pending`, `send`, `time`, `printerSubtitle`
  - Emits: `command`

- [ ] **Step 1: Build `src/components/SingleToolOverview.vue`**
  - Flat graphite/lime layout matching `DESIGN.md` (zero box-shadows, 44px touch targets in `display-mode`):
    - **Dual Thermal Hero Card:** Side-by-side `Extruder` (`status.tools[0]`) and `Druckbett` (`status.bed`) blocks with large tabular-nums readout, existing `ThermalGauge`, inline `TemperatureTarget` inputs (respecting `capabilities.toolMax[0]` / `bedMax`), and filament sensor status pill when a filament sensor exists (`filamentSensorName`).
    - **Live Sensors & Machine Strip:** Compact metric strip displaying build plate size (`width × depth mm`), live XYZ position, print state, and dynamic `status.sensors` temperatures (`Chamber`, `Raspberry Pi`, `MCU`, etc.).
    - **Right Inspector Column:** Single-tool quick actions (`Laden`, `Entladen`, `Clean`, `Purge` — rendered only for macros configured on this printer) + embedded `FanControl` (`[fan]` Bauteillüfter + generic fans).

- [ ] **Step 2: Wire decoupled `isSingleTool` vs. `show3dScene` and `Z-Tilt` in `src/App.vue`**
  - Compute:
    - `isToolchanger = computed(() => Boolean(status.value?.isToolchanger))`
    - `toolCount = computed(() => status.value?.toolCount ?? (settingsStore.activePrinter.value?.model?.preset === 'stormtrooper-6tc' ? 6 : 1))`
    - `isSingleTool = computed(() => (status.value ? (!status.value.isToolchanger && status.value.toolCount === 1) : settingsStore.activePrinter.value?.model?.preset !== 'stormtrooper-6tc'))` (wait: for first-run STORMTROOPER while connecting, once `/api/status` arrives it immediately switches to `isToolchanger === true`, and offline single-tool VORONs never flash 6 empty `T0–T5` cards!)
    - `show3dScene = computed(() => { const preset = settingsStore.activePrinter.value?.model?.preset ?? 'auto'; if (preset === 'none') return false; if (preset === 'stormtrooper-6tc') return true; return Boolean(status.value?.isToolchanger && status.value?.toolCount === 6); })`
  - Pass `:printer-name="printerName"` into `<PrintView>`.
  - Nav label: `isSingleTool ? t('Übersicht') : t('Werkzeuge')` (hash stays `#tools`).
  - Heading/subtitle: `"Dein Drucker. Im Blick."` when `isSingleTool`.
  - When `isSingleTool`: render `<SingleToolOverview>` + the existing compact Machine & LED Deck (adapting `QGL` → `Z-Tilt` when `!capabilities.qgl && capabilities.zTilt`, omitting leveling button when neither exists like V0.1, hiding `Toolchanger initialisieren` & `Einlegehilfe`, using 2-step motor-off confirmation when `qglApplied || zTiltApplied`) + compact `<ConsoleView>`.
  - When `!isSingleTool`: render `<ToolScene>` ONLY if `show3dScene` is true; render dynamic `0..toolCount-1` tool cards + Inspector + Machine & LED Deck (gating `Parken/Pickup/Wechseln/Initialize/LOAD_WATCH` on `isToolchanger`).
  - Add clean CSS rules in `src/style.css` and all new EN translations in `src/locales/en.json`.

- [ ] **Step 3: Verify tests & build**
  Run: `npm test && npm run build`
  Expected: All unit tests (including `tests/i18n.test.mjs`) PASS, `vite build` succeeds.

- [ ] **Step 4: Commit**
  ```bash
  git add src/components/SingleToolOverview.vue src/App.vue src/style.css src/locales/en.json
  git commit -m "feat(single-tool): add SingleToolOverview dashboard and decouple 3D scene visibility from hardware mode"
  ```

---

### Task 5: Controls, Dynamic 3D Print Bed, History & System Views

**Files:**
- Modify: `src/components/ControlsView.vue`
- Modify: `src/components/PrintScene.vue`
- Modify: `src/components/PrintView.vue`
- Modify: `src/components/HistoryView.vue`
- Modify: `src/components/SystemOverview.vue`
- Modify: `src/components/SystemCalibration.vue`
- Modify: `src/locales/en.json`

**Interfaces:**
- Consumes: `status.toolCount`, `status.isToolchanger`, `status.bedSize`, `status.sensors`, `status.zTiltApplied`, `status.capabilities` (`qgl`, `zTilt`, `mesh`), `calibration` response (`isToolchanger`, `zTilt`).

- [ ] **Step 1: Update `src/components/ControlsView.vue`**
  - Motion prep bar: show `QGL` when `capabilities.qgl`, `Z-Tilt` (`action: 'z_tilt'`) when `!capabilities.qgl && capabilities.zTilt`, omit leveling button when neither is configured (V0.1).
  - Motor-off confirmation triggers when `status.qglApplied || status.zTiltApplied` with appropriate tooltip copy.
  - Heating panel: when `toolCount === 1`, hide `"Alle Tools 140 °C"`, label the single heater row `Extruder`, and directly target `extruder` for presets; when `toolCount > 1`, render dynamic `0..toolCount-1` rows.

- [ ] **Step 2: Update `src/components/PrintScene.vue` and `src/components/PrintView.vue`**
  - Accept `bedSize` (`{ originX, originY, width, depth }`) and `printerLabel` props in `PrintScene.vue` (fallback `350 × 350 mm`).
  - Replace hardcoded `175.0` in vertex shader with `uniform vec2 uBedCenter;` (`originX + width / 2`, `originY + depth / 2`).
  - Rebuild `bedGroup`, crosshair, nozzle marker offsets, exclude-object polygons, and `fitBed()` whenever `bedSize` or `printerLabel` changes (Review Focus #3).
  - Draw dynamic grid lines (`10 mm` minor, `50 mm` major) and label (`${printerLabel} · ${width} × ${depth} mm` or `${width} × ${depth} mm`) on the bed canvas texture.
  - In `PrintView.vue`: pass `:bed-size="status?.bedSize"` and `:printer-label="printerName"` (or subtitle); simplify tool legend/toggle when `!isToolchanger && usedToolsList.length <= 1`.

- [ ] **Step 3: Update `src/components/HistoryView.vue`, `src/components/SystemOverview.vue`, and `src/components/SystemCalibration.vue`**
  - `HistoryView.vue`: hide the `Alle Werkzeuge / Multi-Tool / T0–T5` filter when `!status?.isToolchanger`; size dynamic `toolFilterOptions` to `status?.toolCount ?? 6` when `isToolchanger`.
  - `SystemOverview.vue`: render `Druckbett` + dynamic `status.sensors` (fallback to legacy fields when `status.sensors` absent); hide `Toolchanger` and `Erkanntes Tool` status rows when `!status?.isToolchanger`.
  - `SystemCalibration.vue`: hide 6×6 `Nudge XY / Beacon Z` matrix and per-tool thermal expansion sections when `data && !data.isToolchanger`; display `Z-Tilt` card & action button (`action: 'z_tilt'`) when `data?.zTilt?.configured` alongside `QGL`, `Bed Mesh`, and `Input Shaper / ShakeTune`.
  - Add all new English translations to `src/locales/en.json`.

- [ ] **Step 4: Run tests & production build**
  Run: `npm test && npm run build`
  Expected: All unit tests PASS, `vite build` succeeds cleanly.

- [ ] **Step 5: Commit**
  ```bash
  git add src/components/ControlsView.vue src/components/PrintScene.vue src/components/PrintView.vue src/components/HistoryView.vue src/components/SystemOverview.vue src/components/SystemCalibration.vue src/locales/en.json
  git commit -m "feat(single-tool): adapt Controls, dynamic 3D print bed, History, and System views for 1..N tool printers"
  ```

---

### Task 6: Multi-VORON Live Headless Browser Verification & Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run full unit test suite & production build**
  Run: `npm test && npm run build`
  Expected: All tests pass, clean `dist/` build.

- [ ] **Step 2: Run live headless Chromium verification against 3 mock VORON profiles (`STORMTROOPER 6-TC`, `TRIDENT-300`, `VORON-V01`)**
  - Start isolated `server/start.mjs` on ephemeral port (`4180`) with temp settings containing 3 mock Moonraker servers:
    1. `STORMTROOPER` (6-toolchanger, QGL, `350×350`, `et0..5_leds`)
    2. `TRIDENT-300` (single-tool, `z_tilt`, `[fan]`, `sb_leds`, `300×300`, `filament_motion_sensor`)
    3. `VORON-V01` (single-tool, no leveling, `[fan]`, no neopixels, `120×120`, `temperature_sensor skr_pico`)
  - Verify in Playwright Chromium across Desktop (`1440×900`), Mobile (`390×844`), and 7" Display Mode (`1024×600`):
    - Switching `STORMTROOPER` → `TRIDENT-300` → `VORON-V01` via masthead quick-switcher updates Overview/Tools, Controls (`QGL` → `Z-Tilt` → omitted, `Extruder` + `[fan]`), Print 3D (`350×350` → `300×300` → `120×120`), History (no tool filter on single-tool), and System Overview/Calibration (`Z-Tilt`, no 6×6 matrix) with **0 page errors, 0 console errors, 0 unexpected HTTP errors**.
  - Capture screenshots of `TRIDENT-300` Single-Tool Overview, `TRIDENT-300` Controls (Z-Tilt + Extruder + Bauteillüfter), `VORON-V01` Print 3D (`120 × 120 mm` bed), and Mobile/7" Display Mode, and inspect every screenshot visually via `read_file`.
  - Clean up temporary server and temp settings file.

- [ ] **Step 3: Update `README.md`**
  - Document automatic Single-Tool & Multi-VORON Klipper support (`1..N` tools, `QGL` / `Z_TILT` / manual leveling, `[fan]` part cooling, dynamic bed dimensions, `model.preset`).

- [ ] **Step 4: Final verification & commit**
  Run: `npm test && npm run build && git status -s`
  ```bash
  git add README.md
  git commit -m "docs: document Single-Tool & Multi-VORON Klipper auto-discovery in README"
  ```
