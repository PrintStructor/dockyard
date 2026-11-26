# DOCKYARD Paket 1: Single-Tool & Multi-Printer Klipper Support — Design Spec

**Date:** 2026-11-25  
**Status:** Draft (pending builder check & user approval)  
**Follow-up:** Paket 2 (Standard VORON 3D Templates: StealthBurner & Mini-StealthBurner + Accent Color + Generic Fusion 360 `.glb` Upload)

---

## 1. Intent & Why

DOCKYARD was originally built around a single 6-toolchanger VORON 2.4 (`STORMTROOPER`). Now that DOCKYARD has server-persisted multi-printer profiles and live switching, the user wants to operate their entire **5-VORON fleet** from DOCKYARD:

1. **STORMTROOPER** — VORON 2.4 350 mm, 6-toolchanger (`toolchanger`, `extruder..extruder5`, `quad_gantry_level`, `neopixel et0_leds..et5_leds`, CPAP `fan_generic fan0`)
2. **VORON 2.4 (350 mm)** — Single-tool CoreXY, `quad_gantry_level`, standard `[fan]`, StealthBurner (`sb_leds` / similar)
3. **VORON Trident (300 mm)** — Single-tool CoreXY, `z_tilt` (`Z_TILT_ADJUST`), standard `[fan]`, StealthBurner
4. **VORON V0.1 (120 mm)** — Single-tool CoreXY, manual bed leveling (no `quad_gantry_level`, no `z_tilt`), standard `[fan]`, compact bed
5. **Crucible (Printer for Ants)** — Single-tool micro CoreXY (~150 mm class), `z_tilt` or manual bed leveling, standard `[fan]`

Today, DOCKYARD hardcodes `6` tools (`T0–T5`), `quad_gantry_level`, `350 × 350 mm` bed geometry in WebGL shaders, `STORMTROOPER`-specific sensors/neopixels, and requires `toolchangerState === 'ready'` even to `RESUME` a paused print. On a single-tool VORON, that produces empty `T1–T5` rows, wrong 3D CAD, blocked `RESUME`, wrong build-plate scale, missing `Z_TILT`, and missing part-cooling `[fan]` control.

**Paket 1** solves the entire Klipper discovery, control, safety, and UI layer so every printer in the 5-VORON fleet (and any standard 1-tool or N-tool Klipper printer) works cleanly out of the box — while establishing the `modelPreset` profile schema that **Paket 2** will plug StealthBurner / Mini-StealthBurner templates and Fusion 360 `.glb` uploads into.

---

## 2. Approaches Considered

- **Approach A (Chosen — Two-Stage):**
  - **Paket 1 (this spec):** Dynamic Klipper capability & hardware discovery (`1..N` tools, `isToolchanger`, `QGL` / `Z_TILT` / none, `[fan]` part cooling, dynamic bed dimensions, dynamic sensors & neopixels), full single-tool UI adaptation across all tabs, and `modelPreset` schema (`auto` / `stormtrooper-6tc` / `none`) so single-tool printers never display the wrong 6-toolhead CAD.
  - **Paket 2 (next spec):** Built-in lightweight StealthBurner & Mini-StealthBurner `.glb` toolhead templates (~1–2 MB each, with live LEDs, thermal glow & selectable VORON accent color), server-side per-printer `.glb` upload, and generic Fusion 360 export script.
  - *Tradeoff:* Smaller, sharper reviews; user can immediately test and deploy Paket 1 against all 4 real single-tool VORONs and bring real Klipper sensor/LED nuances into Paket 2.
- **Approach B (Rejected — Single Combined Release):**
  - Build single-tool support, Blender/CAD template pipeline, accent colors, and `.glb` upload API in one monolithic pass. Rejected due to oversized diff and higher review risk across unrelated domains.

---

## 3. Goals, Non-Goals & Anti-Goals

### Goals
1. **Zero-Config Klipper Auto-Discovery:** Automatically detect from Moonraker `/printer/objects/list` + `configfile.settings`:
   - `isToolchanger` (`Boolean`) and `toolCount` (`1..N`, capped at `8`; `1` when no `toolchanger` / single `extruder`).
   - Leveling mode: `qgl` (`quad_gantry_level`), `zTilt` (`z_tilt`), or none (`leveling: 'qgl' | 'z_tilt' | null`).
   - Real build plate dimensions (`bedSize: { minX, maxX, minY, maxY, width, depth }`) from `stepper_x`/`stepper_y` config or `toolhead.axis_minimum`/`axis_maximum`.
   - Dynamic temperature sensors (`temperature_sensor *`, `temperature_fan *`), filament sensors (`filament_switch_sensor *`, `filament_motion_sensor *`), part-cooling `[fan]` + `[fan_generic *]`, and toolhead LED neopixels (`neopixel *`).
2. **Full Single-Tool Control & Safety Parity:**
   - `PAUSE` / `RESUME` work safely on single-tool printers (no false `toolchangerState` block).
   - `Z_TILT_ADJUST` supported with the exact same safety guards as `QUAD_GANTRY_LEVEL` (homing required, print/motion lock, 2-step confirmation on `DISABLE_MOTORS` when `zTiltApplied` or `qglApplied`).
   - Standard Klipper `[fan]` controllable via `M106 S<0..255>` in `FanControl.vue` alongside `[fan_generic *]`.
   - Optional single-tool filament/nozzle macros (`LOAD_FILAMENT`, `UNLOAD_FILAMENT`, `CLEAN_NOZZLE`, `PURGE_NOZZLE`) work when present in Klipper config, without requiring `toolchanger` / `T0` / `PICKUP_TOOL` / `_load_settings`.
3. **Clean Single-Tool UI Across Every Tab:**
   - **Tools / Übersicht:** Single-tool printers in `auto` (or `none`) model mode show a clean, calm Single-Tool Overview deck (Extruder & Bed thermal hero + filament sensor + machine/leveling/LED deck + cameras) without displaying the 6-toolhead STORMTROOPER 3D model or `T0–T5` cards.
   - **Controls:** Single `Extruder` row + `Druckbett`, no `"Alle Tools 140 °C"`, `Z-Tilt` button on Trident/Crucible, no leveling button on V0.1, `TemperatureGraph` renders only existing heaters (`Extruder` + `Bett`), `FanControl` includes `[fan]`.
   - **Print 3D Viewer:** WebGL bed mesh, grid lines, origin centering (`uBedCenter`), live nozzle marker, and bed label dynamically match the active printer's true `width × depth mm` (`120×120`, `150×150`, `300×300`, `350×350`, including rectangular beds).
   - **History:** Hides `T0–T5` / `Multi-Tool` tool filter when `!isToolchanger`.
   - **System Overview & Calibration:** Overview renders all real temperature sensors of the active printer; Calibration hides 6×6 Nudge XY / Beacon Z matrices when `!isToolchanger` and shows `Z-Tilt` status/action alongside `QGL`, `Bed Mesh`, and `Input Shaper / ShakeTune`.
4. **Forward-Compatible Profile Schema for Paket 2:**
   - Persist optional `model: { preset: 'auto' | 'stormtrooper-6tc' | 'none' }` on each printer profile in `.dockyard-settings.json`, configurable in Settings → `Drucker & Verbindung`.

### Non-Goals (Deferred to Paket 2)
- Built-in StealthBurner / Mini-StealthBurner 3D `.glb` models and accent-color customization.
- Per-printer custom `.glb` upload API and generic Fusion 360 export script.
- Multi-extruder MMU / Happy Hare / BoxTurtle filament gate UI.
- Bed-screws interactive wizard (`BED_SCREWS_ADJUST` step-by-step modal).

### Anti-Goals
- **Zero regression for `STORMTROOPER` (6-toolchanger):** Every existing 6-tool feature, CAD view, LED sync, Nudge/Beacon calibration matrix, `LOAD_WATCH`, and all 125 existing tests must remain 100% intact.
- **Never render wrong hardware identity:** Never show `STORMTROOPER` 6-toolhead CAD, `T1–T5` placeholders, or `VORON 2.4 · 350 × 350 mm` bed markings on a 120 mm V0.1 or 300 mm Trident.
- **Never invent unknown hardware capabilities:** If a printer has no `LOAD_FILAMENT` macro, no `z_tilt`, no `bed_mesh`, or no neopixels, hide/disable those controls cleanly instead of sending failing G-code.

---

## 4. Architecture & Data Contracts

### 4.1 Klipper Hardware Discovery (`server/printer.mjs` & `server/live.mjs`)

Currently, `server/printer.mjs` subscribes to a static list `objects` containing `extruder..extruder5`, `tool T0..T5`, `neopixel et0..5_leds`, and 5 hardcoded `temperature_sensor` names, and `server/live.mjs` always polls `neopixel et0..5_leds`.

**New Dynamic Object Discovery (from `/printer/objects/list`):**
When `query(withConfig = true)` or `live.mjs` receives `printer.objects.list`, discover dynamically from `availableObjects`:
- **Extruders:** `'extruder'` plus any `^extruder([1-7])$`, sorted numerically (`0..N-1`).
- **Toolchanger:** `'toolchanger'` and any `^tool T([0-7])$`.
- **Leveling:** `'quad_gantry_level'`, `'z_tilt'`.
- **Fans:** `'fan'` (built-in part cooling fan) and any `^fan_generic [A-Za-z0-9_]+$`.
- **Temperature sensors:** Any `^temperature_sensor .+$` and `^temperature_fan .+$`.
- **Filament sensors:** Any `^filament_switch_sensor .+$` and `^filament_motion_sensor .+$`.
- **LEDs:** Any `^neopixel [A-Za-z0-9_]+$` and `^led_effect .+$`.
- **Core always-requested objects (filtered to `availableObjects` when non-empty):**
  `print_stats`, `display_status`, `webhooks`, `heater_bed`, `toolhead`, `gcode_move`, `exclude_object`, `idle_timeout`, `bed_mesh`, `gcode_macro _KNOMI_STATUS`, `gcode_macro LOAD_WATCH`, `gcode_macro _LOAD_SETTINGS`, `gcode_macro _UNLOAD_SETTINGS`, `gcode_macro _BEACON_BATCH_STATE`.

**`server/live.mjs` LED Polling:**
- Instead of polling hardcoded `neopixel et0..5_leds`, `live.mjs` records `polledLedObjects` from the `printer.objects.list` response:
  - If any `neopixel et\d+_leds` exist → poll those (exact existing behavior for `STORMTROOPER`).
  - Else if toolhead neopixel(s) exist (matching `neopixel (sb_leds|stealthburner_leds|head_leds|toolhead_leds|nozzle_leds|rgb)` or the first discovered `neopixel *`) → poll those.
  - Else (`polledLedObjects.length === 0`, e.g., V0.1/Crucible without LEDs) → **skip LED polling completely** (still run idle `ping` heartbeats and disconnect watchdog!).
- In `live.mjs` `merge()`, treat any `key.startsWith('neopixel ')` with `color_data` using `colorDataEqual` (already implemented on line 74!).

### 4.2 Normalized Status Schema (`server/status.mjs`)

`normalizeStatus(raw, at)` detects hardware mode strictly and independently across two dimensions (`isToolchanger` and `toolCount`):

- **`isToolchanger` (builder-check call):** Strictly `Boolean(raw.toolchanger || config.toolchanger)` — true ONLY when `klipper-toolchanger` is present. Multi-extruder / IDEX printers without `[toolchanger]` have `isToolchanger === false` and `toolCount >= 2`, so they are never falsely locked by `toolchangerState` or tool-detection guards.
- **`detectToolCount(raw, config)` (deterministic & backwards-compatible):**
  1. Scan `config` keys (`extruder`, `extruder1..7`, `tool t0..t7`) for `maxConfigIdx` (`-1` if none).
  2. Scan `raw` keys (`extruder`, `extruder1..7`, `tool T0..T7`, `neopixel et0..7_leds`) for `maxRawIdx` (`-1` if none).
  3. If `isToolchanger`:
     - If `maxConfigIdx >= 0`: `toolCount = Math.min(8, Math.max(2, maxConfigIdx + 1))`.
     - Else (partial live status / minimal unit test mocks): `toolCount = Math.min(8, Math.max(6, maxRawIdx + 1))`.
  4. If `!isToolchanger`:
     - `const maxFound = Math.max(maxConfigIdx, maxRawIdx)`
     - `toolCount = maxFound >= 1 ? Math.min(8, maxFound + 1) : 1`.
- **Single-Tool `tools[0]` population:**
  - `active`: when `!isToolchanger && toolCount === 1`, set `active = (raw.extruder || config.extruder) ? 0 : null` (keeps `normalizeStatus({})` returning `active: null` for backwards compatibility with `tests/status.test.mjs`, while any real Moonraker payload with `raw.extruder` sets `active = 0`). For `tools[0]` when `active === 0`: `active = true`, `detected = true`, `detectionMismatch = false`, `detectionConflict = false`.
  - **Filament sensor for Single-Tool (`id === 0`):**
    1. First check `filament_switch_sensor T0_filament_sensor` (toolchanger convention).
    2. If absent and `!isToolchanger`, pick the first `filament_switch_sensor *` or `filament_motion_sensor *` present in `raw` (alphabetical tie-breaker) and expose its `filament_detected` / `enabled` + `filamentSensorName`!
  - **Toolhead LEDs for Single-Tool (`id === 0`):**
    1. Check `neopixel et0_leds`.
    2. If absent and `!isToolchanger`, check priority list `['neopixel sb_leds', 'neopixel stealthburner_leds', 'neopixel head_leds', 'neopixel toolhead_leds', 'neopixel nozzle_leds', 'neopixel rgb']`, else first discovered `neopixel *` whose `color_data` has 1..8 LEDs.
    3. Map `color_data`: `[0] -> number (logo)`, `[1] -> left`, `[2] -> right`.
- **Leveling status:**
  - `qglApplied: raw.quad_gantry_level?.applied === true`
  - `zTiltApplied: raw.z_tilt?.applied === true`
  - `levelingApplied: qglApplied || zTiltApplied`
- **Build plate geometry (`bedSize`):**
  - Read `stepper_x` (`position_min`, `position_max`) and `stepper_y` (`position_min`, `position_max`) from `config`, falling back to `raw.toolhead?.axis_minimum` / `axis_maximum` (`[0]`, `[1]`).
  - Compute `minX`, `maxX`, `minY`, `maxY` (clamped sane: width/depth `50..1000 mm`).
  - Note: On some VORONs (e.g., V2.4 with rear Z-endstop or purge bucket), `stepper_y.position_max` might be `355` or `360` while `position_min` is `0` — using `width = Math.round(maxX - Math.max(0, minX))` (or `maxX - minX` when `minX >= 0`, else `maxX`) keeps the printable coordinate box clean and accurate! Specifically:
    - Printable origin `(originX, originY)` = `(Math.max(0, minX), Math.max(0, minY))` when `minX <= 0` (common on printers with `-2` endstop offset so `0..300` is the bed!), or `(minX, minY)` when `minX > 0`.
    - `width = maxX - originX`, `depth = maxY - originY` (if `bed_mesh.mesh_max` is configured and larger/smaller? No, `stepper_x/y` `position_max` is authoritative for physical bed size; `bedSize` defaults to `null` when unknown so UI falls back gracefully to `350 × 350` only for legacy/offline fallback).
- **Dynamic Temperature Sensors (`sensors`):**
  - Build `sensors: Array<{ id, name, label, temperature, target? }>` from all `temperature_sensor *` and `temperature_fan *` keys in `raw` (excluding per-tool `temperature_sensor T0..T7` which are already shown on tool cards), with friendly German labels for common names (`Chamber` → `Bauraum`, `raspberry_pi` → `Raspberry Pi`, `beacon_coil` → `Beacon-Spule`, otherwise cleaned name).
  - Keep existing top-level fields (`chamber`, `raspberryPi`, `octopus`, `rp2350`, `beacon`) populated for backwards compatibility.
- **Part-cooling fan (`fan`) + `fan_generic *`:**
  - In `status.fans`: if `raw.fan` is present (standard Klipper `[fan]`), include `{ name: '__part_fan__', label: 'Bauteillüfter', kind: 'part_fan', percent: Math.round(speed * 100) }` sorted first, followed by all `fan_generic *` entries (`kind: 'generic'`).

### 4.3 Capabilities & Controls (`server/control.mjs`, `server/tool-actions.mjs`, `server/aux-controls.mjs`, `server/temperature.mjs`, `server/presets.mjs`)

1. **`capabilities(raw)` (`server/control.mjs`):**
   - `isToolchanger`, `toolCount`
   - `toolMax`: array of length `toolCount` (`limit('extruder')`, `limit('extruder1')`, ...)
   - `qgl: !!config['quad_gantry_level']`
   - `zTilt: !!config['z_tilt']`
   - `mesh: !!config['bed_mesh']`
   - `leveling: qgl ? 'qgl' : zTilt ? 'z_tilt' : null`
   - `bedSize`: `{ originX, originY, width, depth }` (or `null`)
2. **New `z_tilt` action (`server/control.mjs` & `src/aux-action-state.mjs`):**
   - Add `'z_tilt'` to `permitted` actions and `motion` array.
   - Guards: `requireAxes('xyz')`, `if (!capabilities(raw).zTilt) fail('Z-Tilt ist nicht konfiguriert.', 409)`, print/motion/uncertain guards identical to `qgl`.
   - Executes `Z_TILT_ADJUST`, `label: 'Z-Tilt ausrichten'`, `async: true`.
   - `quickMotionReason(status, 'z_tilt', ...)` mirrors `'qgl'` checks against `status.capabilities?.zTilt`.
   - `DISABLE_MOTORS` 2-step confirmation in `App.vue` / `ControlsView.vue` triggers when `status.qglApplied || status.zTiltApplied` (with matching Z-Tilt warning copy when `zTiltApplied`).
3. **Standard `[fan]` part-cooling control (`server/control.mjs` & `server/tool-actions.mjs`):**
   - `toolCapabilities(config, raw)` includes `{ name: '__part_fan__', label: 'Bauteillüfter', kind: 'part_fan' }` when `config.fan` or `raw.fan` exists.
   - In `commandFor({ action: 'fan', fan, percent }, raw)`: if `targetFan.kind === 'part_fan'`, emit `M106 S${Math.round((percent / 100) * 255)}` (`M107` when `percent === 0` or `M106 S0` — `M106 S0` is universal and clean in Klipper!).
4. **`temperature` & `temperature_all` (`server/control.mjs`):**
   - `temperature`: accept `'heater_bed'` or `extruder` / `extruder{1..toolCount-1}` dynamically! Label on single-tool (`toolCount === 1`): `'Extruder auf 240 °C'` (or `'T0 auf 240 °C'` on toolchanger).
   - `temperature_all`: reject with `409` if `toolCount <= 1` (`'Gemeinsames Heizen ist nur bei mehreren Werkzeugen verfügbar.'`); otherwise heat all `0..toolCount-1` extruders dynamically!
5. **`RESUME` on Single-Tool (`src/aux-action-state.mjs`):**
   - Only enforce `toolchangerState === 'ready'`, `detectionMismatch`, `detectionConflict`, `detected != null` when `status.isToolchanger === true`! On single-tool printers, `RESUME` still requires `klipperState === 'ready'`, `printState === 'paused'`, `capabilities.resume`, and `homedAxes` containing `xyz`.
6. **Single-Tool Maintenance Macros (`server/tool-actions.mjs` & `src/tool-action-state.mjs`):**
   - On toolchangers (`isToolchanger === true`): keep 100% of existing macro checks (`_load_settings`, `clean_nozzle`, `_goto_purge_pos`, `PICKUP_TOOL`, `T=id`, etc.).
   - On single-tool printers (`isToolchanger === false`):
     - `park`, `pickup`, `select`, `load_all`, `unload_all` are always `false` (disabled/hidden).
     - `clean`: `has('clean_nozzle')` → runs `CLEAN_NOZZLE`.
     - `purge`: `has('purge_nozzle')` → runs `PURGE_NOZZLE`.
     - `load`: `has('load_filament')` → runs `LOAD_FILAMENT` (without `T=0`, and without requiring `_load_settings` / `T0_filament_sensor`!).
     - `unload`: `has('unload_filament')` → runs `UNLOAD_FILAMENT` (without `T=0`).
     - Safety guards on single-tool `toolActionReason`: require online, `klipperState === 'ready'`, no active job, not printing/paused/busy, and `homedAxes` containing `xyz` for `clean`/`purge` (for `load`/`unload`, only check macro exists + idle + ready, since standard Klipper `LOAD_FILAMENT`/`UNLOAD_FILAMENT` macros handle heating/extrusion themselves without requiring XYZ homing!).
7. **`server/temperature.mjs` & `server/presets.mjs` (builder-check call — zero breakage on existing tests):**
   - `temperatureHistory(store, sampledAt = new Date().toISOString(), { toolCount = null } = {})`:
     - When `toolCount` is explicitly provided (`1..8`), build series for `0..toolCount-1` extruders (label `'Extruder'` when `toolCount === 1`, `'T0'..'Tn'` when `toolCount > 1`) plus `heater_bed` (`'Bett'`).
     - When `toolCount` is omitted (`null`), preserve the existing 2-argument default (`T0..T5` + `Bett`, length 7) so `tests/temperature.test.mjs` passes **100% unmodified**.
     - In `GET /api/temperature-history` (`server/printer.mjs`), pass `toolCount: capabilityCache?.toolCount ?? inferExtruderCountFromStore(data.result)` so cold-start requests (e.g., landing directly on `#controls` before `/api/status`) still return exact heaters (`Extruder` + `Bett` on single-tool) with zero extra Moonraker roundtrips!
   - `normalizePresets({ mainsail, legacy, toolCount })`: return `tools` array sized cleanly to `Math.max(1, toolCount)` (defaulting to `6` when `toolCount` omitted for backwards compatibility with existing unit tests).

### 4.4 Calibration Data (`server/calibration.mjs` & `server/printer.mjs`)

- Add `'z_tilt'` to the objects queried by `GET /api/system/calibration`.
- Include `isToolchanger`, `toolCount`, and `zTilt: { configured, applied, retries, retryTolerance, horizontalMoveZ }` in `normalizeCalibrationData`.
- Expose `capabilities.zTilt = Boolean(settings.z_tilt)` alongside `capabilities.qgl`.

### 4.5 Settings Profile Schema (`server/settings.mjs` & `src/useSettings.js`)

Extend each printer profile with an optional, backwards-compatible `model` object (defaulting cleanly for existing `.dockyard-settings.json` files without migration breakage!):

```json
{
  "id": "trident-300",
  "name": "TRIDENT-300",
  "subtitle": "VORON Trident 300 mm",
  "url": "http://192.168.50.30",
  "mainsailUrl": "auto",
  "model": {
    "preset": "auto"
  },
  "cameras": []
}
```

- Valid `model.preset` values in Paket 1: `'auto' | 'stormtrooper-6tc' | 'none'` (Paket 2 will add `'stealthburner'`, `'mini-stealthburner'`, `'custom'` cleanly into the exact same object!).
- **Decoupled 3D Visibility vs. Hardware UI Mode (builder-check call):**
  - **Hardware UI Mode (`isSingleTool`):** Driven strictly by Klipper hardware (`status?.toolCount === 1 && !status?.isToolchanger`). Never controlled by `model.preset`!
  - **3D Scene Visibility (`show3dScene`):** Controls **ONLY** whether `<ToolScene>` renders above/beside the controls:
    - `preset === 'none'` → `show3dScene = false`. (On `STORMTROOPER`, this gives a clean compact 6-tool card/inspector layout **without** losing `T0–T5` cards, mount/load/unload, or `LOAD_WATCH`!)
    - `preset === 'stormtrooper-6tc'` → `show3dScene = true` (renders the 6-toolhead STORMTROOPER CAD even while offline/cold-booting; on a `< 6`-tool printer it displays the reference CAD with only `0..toolCount-1` live telemetry bound).
    - `preset === 'auto'` → `show3dScene = Boolean(status ? (status.isToolchanger && status.toolCount === 6) : false)` (wait: if `status === null` on cold boot/offline, `'auto'` avoids flashing the 6-tool STORMTROOPER CAD onto a V0.1/Trident; once live telemetry arrives, 6-TC immediately mounts `ToolScene`, and `STORMTROOPER` users who want the CAD visible offline can pick `'stormtrooper-6tc'`).
  - For N-toolchangers where `toolCount !== 6` (or `toolCount > 1 && !isToolchanger` like IDEX) in `'auto'` mode: `show3dScene = false`, and the main tab renders dynamic `T0..T(N-1)` cards + Inspector + Machine Deck without the mismatched 6-head CAD!
- Settings UI (`SettingsDialog.vue` → Tab 1 `Drucker & Verbindung`): add a clean `CockpitSelect` for **`3D-Ansicht / Modell`** (`Automatisch (Standard)`, `STORMTROOPER 6-Toolchanger (3D CAD)`, `Kompakt (ohne 3D-Szene)`).
- Export/Import in `src/useSettings.js` preserves `model.preset` cleanly.

---

## 5. Frontend UI Behavior (Single-Tool vs. Multi-Tool vs. 6-Toolchanger)

### 5.1 Tools / Übersicht (`src/App.vue`)
- **Nav tab label:** `Werkzeuge` when `toolCount > 1 || isToolchanger`; switches cleanly to `Übersicht` (`Overview`) when `isSingleTool` (keeping hash `#tools` unchanged so deep links & `defaultTab` never break!).
- **Page heading:**
  - Multi-Tool / Toolchanger: `"Deine Werkzeuge. Im Blick."`
  - Single-Tool (`isSingleTool`): `"Dein Drucker. Im Blick."` / subtitle `"Extruder, Heizbett, Maschine und Live-Sensoren im Überblick."`
- **Layout for Single-Tool (`isSingleTool === true`):**
  - Left main column: **Single-Tool Thermal & Status Card** (prominent Extruder + Bed dual thermal gauges using existing `ThermalGauge.vue`, inline target inputs for Extruder & Bed, filament sensor pill if present, live print progress/state, and dynamic sensor readings strip) + the existing **Compact Machine & LED Deck** (`Homen ALL/X/Y/Z`, `QGL` OR `Z-Tilt` if configured — omitted if neither like V0.1!, `Bed Mesh` if configured, `Motoren lösen` with QGL/Z-Tilt confirm, and `LEDs` if macros configured) + compact `ConsoleView`!
  - Right column / inspector: **Quick Extruder Actions** (if single-tool macros `Laden` / `Entladen` / `Clean` / `Purge` are configured) + **FanControl** + live printer details (`Bauplatte`, `Position X/Y/Z`, `Aktuelle Sensoren`).
  - Zero `T0–T5` cards, zero `Parken / Pickup / Wechseln / Toolchanger initialisieren / Einlegehilfe`!
- **Layout for Multi-Tool / Toolchanger (`!isSingleTool`):**
  - Renders `<ToolScene>` ONLY when `show3dScene === true`; always renders dynamic `0..toolCount-1` tool cards (`T0..T5` on STORMTROOPER) + Inspector + Machine & LED Deck (`Parken/Pickup/Wechseln/Initialize/LOAD_WATCH` gated on `isToolchanger`).
  - On `STORMTROOPER` with `show3dScene === true`: **100% identical to today** — pixel-for-pixel unchanged!

### 5.2 Controls (`src/components/ControlsView.vue`)
- **Motion Prep Bar:**
  - `ALL` (always)
  - `QGL` button when `capabilities.qgl` is true; `Z-Tilt` button when `!capabilities.qgl && capabilities.zTilt` is true; omitted cleanly when neither exists (V0.1)!
  - `Bed Mesh` button when `capabilities.mesh` is true (disabled/hidden if not configured).
  - `Motoren lösen` (with 2-step confirmation when `qglApplied || zTiltApplied`).
- **Heating Panel:**
  - When `toolCount === 1`: hide `"Alle Tools 140 °C"` button, show a single clean **`Extruder`** editable row (no `T0` multi-tool selection needed — presets directly fill Extruder!) + **`Druckbett`** below.
  - When `toolCount > 1`: render dynamic `0..toolCount-1` tool rows (identical to today for 6 tools).
- **Temperature Graph (`TemperatureGraph.vue`):**
  - Automatically renders the series returned by `/api/temperature-history` (for single-tool: `Extruder` + `Bett` in Acid Lime & White/Cyan; resets cleanly on printer switch via `:key`).
- **Fan Control (`FanControl.vue`):**
  - Automatically renders `[fan]` (`Bauteillüfter`) + all `fan_generic *` sliders with live percentages.

### 5.3 Print 3D Viewer (`src/components/PrintScene.vue` & `src/components/PrintView.vue`)
- Pass `:bed-size="status?.bedSize"` and `:printer-label="printerName"` (or subtitle) into `PrintScene.vue`.
- `PrintScene.vue` replaces constants `BED_SIZE = 350` / `HALF_BED = 175` with reactive `bedWidth`, `bedDepth`, `bedCenterX = originX + bedWidth / 2`, `bedCenterY = originY + bedDepth / 2`:
  - Vertex shader adds `uniform vec2 uBedCenter;` → `vec2 p1 = vec2(aStartEnd.x - uBedCenter.x, -(aStartEnd.y - uBedCenter.y));`.
  - Bed canvas draws exact `10 mm` minor and `50 mm` major grid across `bedWidth × bedDepth`, labeled with e.g. `TRIDENT-300 · 300 × 300 mm` or `VORON V0.1 · 120 × 120 mm` (never hardcoded `VORON 2.4 · 350 × 350 mm`!).
  - Rebuilds bed plate + crosshair cleanly if `bedSize` changes (e.g., switching from 350 mm V2.4 to 120 mm V0.1).
  - Live nozzle marker, exclude-object polygons, and camera `fitBed()` use the exact dynamic `bedWidth` / `bedDepth` / `bedCenter`!
- `PrintView.vue`: when `!isToolchanger && usedToolsList.length <= 1`, simplify tool color toggle / label (`Extruder` instead of multi-tool legend).

### 5.4 History (`src/components/HistoryView.vue`)
- When `!status?.isToolchanger`: hide the `Alle Werkzeuge / Multi-Tool / T0–T5` filter dropdown and only show tool weight badges if a job actually used >1 tool.

### 5.5 System Overview & Calibration (`src/components/SystemOverview.vue`, `src/components/SystemCalibration.vue`)
- **SystemOverview:** Replace the hardcoded 6-sensor list (`Bauraum / Raspberry Pi / Octopus / RP2350 / Beacon-Spule`) with `Druckbett` + dynamic `status.sensors` (falling back cleanly to legacy fields if `status.sensors` is absent in tests), and hide the `Toolchanger` / `Erkanntes Tool` rows when `!status?.isToolchanger`!
- **SystemCalibration:**
  - When `!data?.isToolchanger`: hide the `6×6 Toolchanger-Offsets (Nudge XY / Beacon Z)` matrix card and per-tool thermal expansion table; show **`Leveling (QGL / Z-Tilt)`** + **`Bed Mesh`** + **`Input Shaper / ShakeTune`** cleanly!
  - Support running `Z-Tilt` (`action: 'z_tilt'`) directly from Calibration when `capabilities.zTilt` is true!

---

## 6. Testing & Verification Strategy

1. **Backwards Compatibility:** All **125 existing tests** must pass unmodified (proving zero regression for `STORMTROOPER` 6-toolchanger).
2. **New Unit & Integration Tests (`tests/single-tool.test.mjs`):**
   - `normalizeStatus` on Single-Tool VORON 2.4 (QGL + `sb_leds` + `[fan]`), Trident (`z_tilt` + `300×300` bed + `filament_motion_sensor`), V0.1 (no leveling + `120×120` bed + no neopixels), Crucible (`150×150` bed + custom sensors).
   - `capabilities` & `commandFor`: `z_tilt` (`Z_TILT_ADJUST`) with homing/print guards; `[fan]` (`M106 S...`); `temperature` for single `extruder` (`Extruder auf 210 °C`); `temperature_all` rejected with `409` on single-tool; single-tool `RESUME` allowed without `toolchangerState`; single-tool `LOAD_FILAMENT` / `UNLOAD_FILAMENT` / `CLEAN_NOZZLE` / `PURGE_NOZZLE` without `T=0` or `PICKUP_TOOL`; `park`/`pickup`/`select` rejected on single-tool.
   - `temperatureHistory`: returns only present heaters (`Extruder` + `Bett` on single-tool; `T0–T5` + `Bett` on 6-tool).
   - `live.mjs`: dynamically polls `neopixel sb_leds` on single-tool and skips LED polling cleanly when printer has zero neopixels.
   - `settings.mjs` & `useSettings.js`: validates and roundtrips `model.preset` (`auto | stormtrooper-6tc | none`) and defaults cleanly for legacy settings files without `model`.
   - `tests/i18n.test.mjs`: 100% EN coverage for all new German UI & error strings.
3. **Live Headless Chromium QC:**
   - Mock a Single-Tool Trident (`300×300`, `z_tilt`, `[fan]`, `sb_leds`) AND a V0.1 (`120×120`, no leveling, no LEDs) AND `STORMTROOPER` (6-TC) in one session; switch between them live and visually verify Desktop (`1440×900`), Mobile (`390×844`), and 7" Display Mode (`1024×600`) across Tools/Overview, Controls, Print 3D (confirming `300×300` and `120×120` beds!), History, and System Calibration with 0 console/page errors!

---

## 7. Open Calls Left to Builder
- Exact CSS grid/card spacing for the Single-Tool Overview deck (strictly following `DESIGN.md` flat graphite/lime, zero box-shadows, 44px touch targets in Display Mode).
- Friendly German display-name mapping table for common Klipper temperature sensor names (e.g., `chamber`, `raspberry_pi`, `mcu`, `mcu_temp`, `ebb`, `sb2040`, `nhk`, `host`).
