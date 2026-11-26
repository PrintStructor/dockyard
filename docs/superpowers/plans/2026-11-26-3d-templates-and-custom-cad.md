# DOCKYARD 3D-Templates, Custom Fusion CADs & Spoolman Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver compact VoronDesign StealthBurner & Mini-StealthBurner 3D toolhead templates (< 1 MB each), deploy-safe per-printer custom `.glb` CAD upload & rendering, native Moonraker Spoolman integration (live spool display + switching + 3D filament color), and a generic macOS Fusion 360 Desktop CAD export pipeline.

**Architecture:** Extract shared Three.js studio/LED/thermal helpers into `src/scene-utils.mjs` and add a lightweight `src/components/PrinterScene.vue` for single-tool templates and custom `.glb` slots while leaving STORMTROOPER 6-TC's `ToolScene.vue` behavior unchanged. Store uploaded `.glb` files outside `dist/` in `.dockyard-models/<printerId>/` managed by `server/models.mjs` and exposed via `/api/models/:printerId/:slot` alongside Moonraker Spoolman endpoints in `server/spoolman.mjs` + `server/printer.mjs`.

**Tech Stack:** Vue 3, Three.js (`GLTFLoader`, `MeshoptDecoder`, `OrbitControls`, `Reflector`, `UnrealBloomPass`), Node.js 22+ built-in `http`/`fs`/`crypto`/`node:test` (zero new runtime npm dependencies), Blender CLI + `@gltf-transform/cli@4.5.1` (Meshopt), Fusion 360 Desktop Python API (macOS).

**Spec:** `docs/superpowers/specs/2026-11-26-3d-templates-and-custom-cad-design.md`

## Global Constraints

- Zero regressions on STORMTROOPER 6-TC (`ToolScene.vue`, `/models/tools.glb`, `/models/printer.glb`, `/models/lights.json`).
- Zero new runtime npm dependencies in `package.json`; use Node.js 22+ stdlib on the server and existing `three` / `vue` / `@lucide/vue` on the client.
- Template asset size budgets: `public/models/templates/stealthburner.glb` < `800_000` bytes; `public/models/templates/mini-stealthburner.glb` < `600_000` bytes (Meshopt-compressed, GPLv3-attributed in `NOTICE.md` and `public/models/provenance.json`).
- Custom `.glb` uploads live in `DOCKYARD_MODELS_DIR` (default sibling `.dockyard-models/` next to `.dockyard-settings.json`, gitignored, untouched by `npm run build` and `scripts/deploy-pi.sh`), max `26_214_400` bytes (25 MB), strict GLB v2 validation, origin-guarded via `sameOriginRequest`.
- Design system (`DESIGN.md`): flat graphite (`#111618` / `#192125` / `#1b252a`), `1px solid #354147`, Acid-Lime (`#c5f76b`), Amber (`#f3c67b`), `Onest` font, zero CSS box-shadows, 44 px minimum touch targets in `.app-shell.display-mode`, full DE + EN (`src/locales/en.json`).
- Preserve existing Paket 1 `SingleToolOverview.vue` layout (`PrinterScene.vue` added above thermal cards in `.single-tool-main`; `LedControls` stays left, `FanControl`/Quick Actions right, `ConsoleView compact` below in `App.vue`).
- Node/npm shell commands on macOS require `export PATH="/opt/homebrew/bin:$PATH"`.
- Never send mutating commands to any physical printer, never push to remote, and never run `scripts/deploy-pi.sh`.

## Review Focus

1. **Corrupted, disguised, or oversized `.glb` uploads** (`.stl`/HTML renamed to `.glb`, mismatched GLB declared byte length, malformed JSON chunk, or > 25 MB stream) must return HTTP `400`/`413`, never leave `.tmp` files behind, and never overwrite an existing valid `.glb` in the same slot — pinned in Tasks 1 & 2.
2. **Cache invalidation on overwrite & cascade cleanup on profile deletion:** Re-uploading a `.glb` to the same slot must rotate `updatedAt`/`etag` so `resolveSceneConfig` emits a fresh `?v=` URL, and deleting a printer in `POST /api/settings` must remove `.dockyard-models/<printerId>/` — pinned in Tasks 1 & 2.
3. **Spoolman absent, unreachable, or malformed metadata:** Printers without `[spoolman]` (`404`) must back off silently with zero status breakage; missing `vendor`, unprefixed `color_hex`, or `multi_color_hexes` must normalize safely; switching printers must immediately reset cached spool state — pinned in Task 2.
4. **Race conditions & unsaved draft guards:** Uploading to an unsaved printer ID returns HTTP `404` and is guarded in `SettingsDialog.vue`; rapid view/printer switches mid-GLB-load must discard stale loads via generation tokens and dispose geometries cleanly — pinned in Tasks 2 & 4.
5. **Meshopt optimization preserving live scene tags:** `@gltf-transform/cli optimize` can flatten or merge away named nodes unless explicitly protected; both built-in templates and `scripts/optimize-dockyard-glb.sh` must retain `VORON_ACCENT`, `LED_LOGO`, `LED_NOZZLE_L`, `LED_NOZZLE_R`, `NOZZLE_TIP`, and `FILAMENT_INLET` — pinned in Task 3.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `.gitignore` | Modify | Ignore `.dockyard-models/` |
| `server/config.mjs` | Modify | Export `modelsDir` (`DOCKYARD_MODELS_DIR` or sibling `.dockyard-models`) |
| `server/models.mjs` | Create | Strict GLB v2 validation, filename sanitization, atomic per-printer `toolhead`/`printer` storage & metadata |
| `server/settings.mjs` | Modify | Extend `MODEL_PRESETS` + `DEFAULT_ACCENT_COLOR` + `accentColor` validation in `normalizeModelSetting` |
| `src/model-config.mjs` | Create | Shared `MODEL_PRESETS`, `ACCENT_SWATCHES`, `DEFAULT_ACCENT_COLOR`, pure `resolveSceneConfig()` |
| `src/useSettings.js` | Modify | Support expanded `model` (`preset`, `accentColor`), add `uploadModel()` & `deleteModel()` |
| `server/materials.mjs` | Modify | Support 1-slot slicer metadata when `toolCount === 1` while keeping 6-slot OrcaSlicer behavior unchanged |
| `server/spoolman.mjs` | Create | Moonraker `/server/spoolman/*` auto-discovery reader, spool normalizer, list & active-spool switch helpers |
| `server/printer.mjs` | Modify | Inject `modelStore` + `fetchImpl`, attach read-only `customModels`, cascade cleanup, `/api/models/*` & `/api/spoolman/*` routes, integrate Spoolman into `normalized()` |
| `scripts/build-voron-templates.py` | Create | Reproducible Blender CLI script building `stealthburner.glb` & `mini-stealthburner.glb` from VoronDesign STLs with reserved tags |
| `scripts/optimize-dockyard-glb.sh` | Create | Reusable `@gltf-transform/cli@4.5.1` Meshopt optimizer preserving live tag nodes |
| `public/models/templates/stealthburner.glb` | Create | Meshopt-compressed StealthBurner template (< 800 KB) |
| `public/models/templates/mini-stealthburner.glb` | Create | Meshopt-compressed Mini-StealthBurner template (< 600 KB) |
| `public/models/provenance.json` | Modify | Record template provenance, commit/tag, sizes, triangle counts, optimization settings |
| `NOTICE.md` | Modify | Add GPLv3 upstream attribution for Voron-Stealthburner & Voron-0 Mini-Stealthburner |
| `src/scene-utils.mjs` | Create | Shared Three.js studio lighting, LED interpolation, thermal glow texture, cyclorama floor veil, node classifier, nozzle tip detector, disposal |
| `src/components/ToolScene.vue` | Modify | Reuse shared helpers from `src/scene-utils.mjs` with zero behavioral change |
| `src/components/PrinterScene.vue` | Create | Lightweight 3D Toolhead-Hero & Custom CAD viewer with `Toolhead / Drucker` switch, live LEDs/glow/filament/accent |
| `src/components/SpoolmanPicker.vue` | Create | Compact Extruder spool badge + searchable spool switcher/clear popover |
| `src/components/SingleToolOverview.vue` | Modify | Mount `PrinterScene.vue` above thermal cards and `SpoolmanPicker.vue` in Extruder card |
| `src/App.vue` | Modify | Use `resolveSceneConfig()`, wire `PrinterScene` for single-tool & non-6-TC fallback, open Settings to active printer from empty-custom CTA |
| `src/components/SettingsDialog.vue` | Modify | 6-preset selector, VORON accent swatches + hex picker, `.glb` upload/replace/delete UI, Fusion export `<details>`, backup import note |
| `src/style.css` | Modify | Flat graphite/lime styles for `PrinterScene`, `SpoolmanPicker`, Settings swatches/upload cards, Desktop/7"/Mobile breakpoints |
| `src/locales/en.json` | Modify | English translations for all new German UI strings |
| `scripts/fusion-export-dockyard.py` | Create | Generic macOS Fusion 360 Desktop export script with dialog, fastener filter, Y-up normalization, LED/accent tagging, GLB v2 writer |
| `scripts/import-3d-print-rig.sh` | Create | On-demand CLI importer for all 73+ machines in `Psych0h3ad/3d-print-rig` (`--list`, SHA-256 verify, gunzip, auto Meshopt optimize, optional `--upload`) |
| `docs/fusion-cad-export.md` | Create | Concise macOS Fusion 360 export, 3D-Print-Rig import & optimization guide |

---

### Task 1: Model Config Schema, Preset Resolver & Persistent `.dockyard-models/` Store

**Files:**
- Modify: `.gitignore`
- Modify: `server/config.mjs:54-58`
- Create: `server/models.mjs`
- Modify: `server/settings.mjs:16-22,278-288,384-403`
- Create: `src/model-config.mjs`
- Modify: `src/useSettings.js:1-10,70-88,295-334`
- Test: `tests/models.test.mjs`, `tests/model-config.test.mjs`, `tests/settings.test.mjs`, `tests/settings-client.test.mjs`

**Interfaces:**
- Produces in `server/config.mjs`:
  - `export const modelsDir: string` (`DOCKYARD_MODELS_DIR` or `path.join(path.dirname(settingsFilePath), '.dockyard-models')`)
- Produces in `server/models.mjs`:
  - `export const MAX_MODEL_BYTES = 25 * 1024 * 1024`
  - `export const MODEL_SLOTS = ['toolhead', 'printer']`
  - `export function sanitizeModelFilename(raw, fallbackSlot = 'printer'): string`
  - `export function validateGlbBuffer(buffer: Buffer): { byteLength: number, jsonChunkLength: number, assetVersion: string }` (throws `Error` with German user-facing message on invalid input)
  - `export function createModelStore({ dir = defaultModelsDir } = {}): { dir, describePrinter(printerId), saveModel(printerId, slot, buffer, filename), readModel(printerId, slot), deleteModel(printerId, slot), removePrinter(printerId) }`
    - `describePrinter(printerId)` returns `{ toolhead: ModelMeta | null, printer: ModelMeta | null }` where `ModelMeta = { filename, bytes, updatedAt, etag }`.
    - `readModel(printerId, slot)` returns `{ buffer: Buffer, meta: ModelMeta } | null`.
- Produces in `server/settings.mjs`:
  - `export const MODEL_PRESETS = ['auto', 'stormtrooper-6tc', 'stealthburner', 'mini-stealthburner', 'custom', 'none']`
  - `export const DEFAULT_ACCENT_COLOR = '#c5f76b'`
  - `export function normalizeModelSetting(raw): { preset: string, accentColor: string }`
- Produces in `src/model-config.mjs`:
  - `export const MODEL_PRESETS` (same 6 values)
  - `export const DEFAULT_ACCENT_COLOR = '#c5f76b'`
  - `export const ACCENT_SWATCHES: Array<{ id, label, hex }>` (7 curated VORON colors)
  - `export const TEMPLATE_URLS = { stealthburner: '/models/templates/stealthburner.glb', 'mini-stealthburner': '/models/templates/mini-stealthburner.glb' }`
  - `export function normalizeAccentColor(raw, fallback = DEFAULT_ACCENT_COLOR): string`
  - `export function resolveSceneConfig(printerProfile, status, { settingsLoaded = true } = {}): { kind: 'none' } | { kind: 'stormtrooper-6tc' } | { kind: 'printer-scene', effectivePreset, accentColor, defaultView, emptyCustom, views: { toolhead: ModelSource | null, printer: ModelSource | null } }`
- Produces in `src/useSettings.js`:
  - `uploadModel(printerId, slot, file)` → `POST /api/models/:printerId/:slot` with `X-Cockpit-Request: 1` & `X-Model-Filename: encodeURIComponent(file.name)`
  - `deleteModel(printerId, slot)` → `DELETE /api/models/:printerId/:slot` with `X-Cockpit-Request: 1`

- [ ] **Step 1: Write failing tests for `server/models.mjs`, `src/model-config.mjs`, and updated `server/settings.mjs` / `src/useSettings.js`**

Create `tests/models.test.mjs` with a helper `makeValidGlb(jsonObj = { asset: { version: '2.0' } }, binBytes = Buffer.alloc(0))` asserting:
- `validateGlbBuffer(makeValidGlb())` returns `{ byteLength, jsonChunkLength, assetVersion: '2.0' }`.
- `validateGlbBuffer` rejects non-GLB magic (`Buffer.from('solid stl...')`), GLB version `1`, truncated/mismatched `declaredLength`, non-JSON first chunk, corrupt JSON, missing/non-`2.x` `asset.version`, and buffers > `MAX_MODEL_BYTES`.
- `createModelStore({ dir: tmpDir })`:
  - `saveModel('voron-24', 'printer', glb1, '../evil/my printer.glb')` writes atomically, returns `{ filename: 'my printer.glb', bytes, updatedAt, etag }`, leaves zero `.tmp` files in `dir/voron-24/`.
  - `describePrinter('voron-24')` returns `{ toolhead: null, printer: meta }` and survives a fresh `createModelStore({ dir: tmpDir })` instance.
  - Overwriting with `glb2` rotates `etag` and `updatedAt`; a failed overwrite with invalid buffer throws AND leaves `glb1` intact on disk with zero `.tmp` files.
  - `saveModel('../escape', 'printer', glb1)` and `saveModel('voron-24', 'other', glb1)` reject with validation errors.
  - `deleteModel('voron-24', 'printer')` removes `.glb`, `.meta.json`, and empty directory; second delete is idempotent.
  - `removePrinter('voron-24')` removes both slots and directory cleanly.

Create `tests/model-config.test.mjs` testing `resolveSceneConfig`:
- `!settingsLoaded` → `{ kind: 'none' }`.
- `preset: 'none'` → `{ kind: 'none' }`.
- `preset: 'stormtrooper-6tc'` → `{ kind: 'stormtrooper-6tc' }` when offline or 6-TC; `{ kind: 'none' }` when single-tool or 2-TC.
- `preset: 'auto'`:
  - offline (`status = null`) even with uploaded `customModels` → `{ kind: 'none' }`.
  - 6-TC → `{ kind: 'stormtrooper-6tc' }`.
  - Single-tool `bedSize.width = 120` (V0.1) & `150` (Crucible) & `165` → `kind: 'printer-scene'`, `effectivePreset: 'mini-stealthburner'`, `views.toolhead.url === '/models/templates/mini-stealthburner.glb'`.
  - Single-tool `bedSize.width = 300` (Trident) & `350` (V2.4) & `bedSize: null` → `effectivePreset: 'stealthburner'`.
  - Single-tool `auto` with `customModels.printer` uploaded → `views.toolhead` is template, `views.printer.url` is `/api/models/<id>/printer?v=<updatedAt>`, `defaultView === 'toolhead'`; `customModels.toolhead` is ignored under `auto`.
  - Multi-extruder non-TC (`toolCount: 2, isToolchanger: false`) and 4-TC (`toolCount: 4, isToolchanger: true`) → `{ kind: 'none' }` without custom files, `{ kind: 'printer-scene' }` with custom files.
- `preset: 'stealthburner'` and `'mini-stealthburner'` work offline (`status = null`) and combine with `customModels.printer` if present.
- `preset: 'custom'`:
  - neither slot uploaded → `emptyCustom: true`, `views: { toolhead: null, printer: null }`.
  - only `printer` uploaded → `emptyCustom: false`, `defaultView: 'printer'`.
  - only `toolhead` uploaded → `emptyCustom: false`, `defaultView: 'toolhead'`.
  - both uploaded → `emptyCustom: false`, `defaultView: 'toolhead'`, both `views` populated with `?v=` cache-busting query.

Update `tests/settings.test.mjs` and `tests/settings-client.test.mjs` for the expanded 6 `MODEL_PRESETS` and `accentColor` default (`'#c5f76b'`), lowercase normalization, invalid hex rejection, and backup export/import round-trip (stripping any `customModels`).

- [ ] **Step 2: Run tests to verify failure**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/models.test.mjs tests/model-config.test.mjs tests/settings.test.mjs tests/settings-client.test.mjs`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `server/models.mjs` and `src/model-config.mjs`, assertion failures on `MODEL_PRESETS`).

- [ ] **Step 3: Implement `.gitignore`, `server/config.mjs`, `server/models.mjs`, `server/settings.mjs`, `src/model-config.mjs`, and `src/useSettings.js`**

- Add `.dockyard-models/` to `.gitignore`.
- Export `modelsDir` from `server/config.mjs` using `process.env.DOCKYARD_MODELS_DIR` fallback `path.join(path.dirname(settingsFilePath), '.dockyard-models')`.
- Implement `server/models.mjs`: validate `printerId` (`/^[a-z0-9][a-z0-9_-]{0,31}$/`) & `slot` (`'toolhead' | 'printer'`), verify resolved path stays inside `path.resolve(dir)`, validate GLB v2 header + JSON chunk (`validateGlbBuffer`), write `.glb.<pid>.<seq>.tmp` + `.meta.json.<pid>.<seq>.tmp` and atomically `rename`, clean up `.tmp` on any failure, compute SHA-256 weak/strong quoted `etag`, implement synchronous `describePrinter(printerId)` (or disk-backed metadata read so `getPublicSettings()` stays synchronous!).
- Update `server/settings.mjs`: expand `MODEL_PRESETS`, export `DEFAULT_ACCENT_COLOR = '#c5f76b'`, validate `#rrggbb` `accentColor` in `normalizeModelSetting`, include `accentColor: DEFAULT_ACCENT_COLOR` in `bootstrapFromEnv`.
- Implement `src/model-config.mjs` with the 7 curated `ACCENT_SWATCHES` (`VORON-Rot #d62828`, `Acid-Lime #c5f76b`, `Arctic-Weiß #dce6e2`, `Signal-Amber #f3c67b`, `Kobaltblau #3b82f6`, `Violett #9b5de5`, `Graphit #495860`) and `resolveSceneConfig()`.
- Update `src/useSettings.js`: import `MODEL_PRESETS`, `DEFAULT_ACCENT_COLOR`, `normalizeAccentColor` from `./model-config.mjs`, preserve `accentColor` in `cloneModel`, omit `customModels` from `buildPrintersExport`, add `uploadModel(printerId, slot, file)` and `deleteModel(printerId, slot)` calling `applyRemoteSettings(data.settings)` on success.

- [ ] **Step 4: Run test suite to verify green**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm test`
Expected: PASS (all existing + new Task 1 tests green).

- [ ] **Step 5: Commit Task 1**

```bash
git add .gitignore server/config.mjs server/models.mjs server/settings.mjs src/model-config.mjs src/useSettings.js tests/models.test.mjs tests/model-config.test.mjs tests/settings.test.mjs tests/settings-client.test.mjs
git commit -m "feat: add model presets, accent config, scene resolver and persistent GLB store"
```

---

### Task 2: Single-Tool Materials, Moonraker Spoolman Reader & Server HTTP Endpoints (`/api/models/*`, `/api/spoolman/*`)

**Files:**
- Modify: `server/materials.mjs:12-92`
- Create: `server/spoolman.mjs`
- Modify: `server/printer.mjs:1-50,112-135,190-230,420-445,925-1055,1625-1701`
- Test: `tests/materials.test.mjs`, `tests/spoolman.test.mjs`, `tests/models-http.test.mjs`

**Interfaces:**
- Consumes from Task 1: `createModelStore`, `MAX_MODEL_BYTES`, `validateGlbBuffer` from `server/models.mjs`; `modelsDir` from `server/config.mjs`.
- Produces in `server/materials.mjs`:
  - `export function materialsFromMetadata(metadata, filename, toolCount = 6): Array<Material | null>` (when `toolCount === 1`, parses single-slot `filament_type` & `filament_colors` from OrcaSlicer, PrusaSlicer, SuperSlicer, or any slicer providing those fields — supports JSON arrays, string arrays, and semicolon-delimited strings; when `toolCount === 6`, preserves exact existing OrcaSlicer 6-slot contract).
  - `createMaterialsReader(printerOrGetter, fetchImpl, onUpdate)` → `read(raw, toolCount = 6)` (caches by `${toolCount}:${filename}`).
- Produces in `server/spoolman.mjs`:
  - `export function normalizeSpool(raw): NormalizedSpool | null` (`{ id, name, vendor, material, color, remainingWeight, initialWeight, lotNr, archived }`; normalizes `color_hex` with/without leading `#`, falls back to first hex of `multi_color_hexes`).
  - `export function spoolToToolMaterial(spool): { type, name, color, source: 'Spoolman', spoolId, remainingWeight } | null`
  - `export function createSpoolmanReader(printerOrGetter, fetchImpl, onUpdate): { read(): SpoolmanState, invalidate(): void, reset(): void }`
    - `SpoolmanState = { available: boolean, connected: boolean, spoolId: number | null, activeSpool: NormalizedSpool | null }`.
    - Silent 60 s backoff on HTTP `404` / unsupported; 15 s status TTL; 30 s active-spool detail TTL; immediate refresh on `spool_id` change or `invalidate()`.
  - `export async function fetchSpoolmanList(printerUrl, fetchImpl): Promise<{ available, connected, activeSpoolId, spools }>` (calls `/server/spoolman/status` + `POST /server/spoolman/proxy` with `{ request_method: 'GET', path: '/v1/spool', query: 'allow_archived=false' }`).
  - `export async function setActiveSpoolmanSpool(printerUrl, spoolId, fetchImpl): Promise<{ spoolId: number | null, activeSpool: NormalizedSpool | null }>` (validates positive integer or `null`, posts `{ spool_id: spoolId }` to `/server/spoolman/spool_id`, fetches normalized spool if non-null).
- Produces in `server/printer.mjs`:
  - `createPrinterRuntime({ store, modelStore, fetchImpl } = {})`
  - Public settings enriched with `customModels: modelStore.describePrinter(p.id)` on every printer and on `activePrinter`.
  - Routes:
    - `GET /api/models/:printerId/:slot` (`200` binary + `ETag` + `X-Content-Type-Options: nosniff`, `304` on matching `If-None-Match`, `404` when missing)
    - `POST /api/models/:printerId/:slot` (Origin-guarded `403`, printer existence check `404`, streaming 25 MB limit `413`, GLB validation `400`, returns `{ ok: true, printerId, slot, meta, settings }`)
    - `DELETE /api/models/:printerId/:slot` (Origin-guarded `403`, returns `{ ok: true, printerId, slot, settings }`)
    - `GET /api/spoolman/spools` (`200` list or `404`/`503` when unavailable)
    - `POST /api/spoolman/active` (Origin-guarded `403`, validates `spoolId`, calls `setActiveSpoolmanSpool`, invalidates reader + notifies live feed, returns `{ ok: true, spoolId, activeSpool }`)
  - `POST /api/settings` removes `.dockyard-models/<removedId>/` for any deleted printer profiles.
  - `normalized(raw)` includes `data.spoolman = readSpoolman.read()` and assigns `tools[0].material` on single-tool with priority: `spoolToToolMaterial(spoolman.activeSpool) ?? materials[0] ?? null`.

- [ ] **Step 1: Write failing tests for single-tool materials, Spoolman, and HTTP endpoints**

Extend `tests/materials.test.mjs`:
- Single-tool (`toolCount = 1`) parses OrcaSlicer `["ABS"]` + `["#d62828"]`, PrusaSlicer `"PETG"` + `"#3b82f6"`, and semicolon-delimited `"PLA;PLA"` + `"#c5f76b;#000000"` into slot `[0]`, while existing 6-slot assertions remain identical.

Create `tests/spoolman.test.mjs`:
- `normalizeSpool` handles unprefixed `color_hex: "d62828"`, prefixed `"#c5f76b"`, `multi_color_hexes: "ff0000,00ff00"`, missing `vendor`, rounded `remaining_weight`, and rejects invalid objects without integer `id`.
- `createSpoolmanReader`:
  - HTTP `404` sets `{ available: false, connected: false, spoolId: null, activeSpool: null }` and does not re-fetch within backoff window.
  - Connected with `spool_id: 7` fetches `/v1/spool/7` via proxy and triggers `onUpdate()`, populating `activeSpool`.
  - `reset()` immediately clears cached spool state (simulating printer switch).
  - `invalidate()` triggers fresh fetch on next `read()`.
- HTTP integration via `createPrinterRuntime({ store, modelStore, fetchImpl })`:
  - `GET /api/spoolman/spools` returns sorted non-archived spools with active spool first; returns `404` when Moonraker lacks `[spoolman]`.
  - `POST /api/spoolman/active` rejects untrusted origin with `403`, rejects `{ spoolId: -1 }` / `{ spoolId: 'abc' }` with `400`, accepts `{ spoolId: 7 }` and `{ spoolId: null }` with `200`, forwards `{ spool_id }` to Moonraker.
  - `GET /api/status` on single-tool prefers Spoolman `activeSpool` over 1-slot slicer metadata, and falls back to 1-slot slicer metadata when `spoolId` is `null`; 6-TC keeps 6-slot OrcaSlicer materials intact.

Create `tests/models-http.test.mjs`:
- Uses `createPrinterRuntime({ store: tempStore, modelStore: tempModelStore })` with mock `req`/`res` or ephemeral `http.createServer`.
- Tests: `POST /api/models/voron24/printer` with valid GLB (`200` + `settings.printers[0].customModels.printer` populated), untrusted origin (`403`), unknown/unsaved printer ID (`404`), invalid binary (`400`), oversized stream > 25 MB (`413`), `GET /api/models/voron24/printer` (`200` + `model/gltf-binary` + `nosniff` + `ETag`), `If-None-Match` (`304`), `DELETE /api/models/voron24/printer` (`200` + `customModels.printer === null`), and deleting a printer via `POST /api/settings` removes its stored `.glb` directory on disk.

- [ ] **Step 2: Run tests to verify failure**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/materials.test.mjs tests/spoolman.test.mjs tests/models-http.test.mjs`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `server/spoolman.mjs`, missing routes/exports).

- [ ] **Step 3: Implement `server/materials.mjs`, `server/spoolman.mjs`, and `server/printer.mjs`**

- Update `server/materials.mjs` to support optional `toolCount = 6` cleanly.
- Implement `server/spoolman.mjs` with strict timeouts (`5000 ms`), `redirect: 'error'`, backoff on `404`, and clean normalization.
- Update `server/printer.mjs`:
  - Add `modelStore = defaultModelStore` and `fetchImpl = fetchUpstream` parameters to `createPrinterRuntime` (keeping default runtime export identical).
  - Add helper `enrichPublicSettings(publicSettings)` attaching `customModels` to each printer and `activePrinter`.
  - Add streaming `readRawBody(req, MAX_MODEL_BYTES)` helper (aborts immediately on > 25 MB with `ControlError(..., 413)`).
  - Wire `modelRoute` (`GET`, `POST`, `DELETE`) and `spoolmanRoute` (`GET /api/spoolman/spools`, `POST /api/spoolman/active`) into method & `sameOriginRequest` write checks.
  - Wire `readSpoolman.reset()` inside `applyRuntimeSettingsChange` and cascade `modelStore.removePrinter(removedId)` inside `POST /api/settings`.
  - Pass `data.toolCount` into `readMaterials(raw, data.toolCount)` and apply Spoolman > slicer priority on single-tool in `normalized()`.

- [ ] **Step 4: Run full test suite**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm test`
Expected: PASS (all existing + new Task 2 tests green).

- [ ] **Step 5: Commit Task 2**

```bash
git add server/materials.mjs server/spoolman.mjs server/printer.mjs tests/materials.test.mjs tests/spoolman.test.mjs tests/models-http.test.mjs
git commit -m "feat: add custom GLB HTTP API, single-tool materials and Moonraker Spoolman integration"
```

---

### Task 3: VoronDesign Built-In 3D Templates (`stealthburner.glb`, `mini-stealthburner.glb`) & Meshopt Optimizer

**Files:**
- Create: `scripts/optimize-dockyard-glb.sh`
- Create: `scripts/build-voron-templates.py`
- Create: `public/models/templates/stealthburner.glb`
- Create: `public/models/templates/mini-stealthburner.glb`
- Modify: `public/models/provenance.json`
- Modify: `NOTICE.md`
- Test: `tests/templates-assets.test.mjs`

**Interfaces:**
- Produces in `scripts/optimize-dockyard-glb.sh`:
  - CLI: `./scripts/optimize-dockyard-glb.sh <input.glb> [output.glb] [--preset toolhead|printer]`
  - Runs `npx --yes @gltf-transform/cli@4.5.1 optimize` with `--compress meshopt --simplify --flatten false --join false` so reserved node/material tags (`VORON_ACCENT`, `LED_LOGO`, `LED_NOZZLE_L`, `LED_NOZZLE_R`, `NOZZLE_TIP`, `FILAMENT_INLET`) are preserved; prints before/after byte sizes and checks against 25 MB limit.
- Produces in `public/models/templates/`:
  - `stealthburner.glb` (< `800_000` bytes) & `mini-stealthburner.glb` (< `600_000` bytes), each Y-up meters, X/Z centered at `0`, nozzle tip grounded at `y = 0`, front facing `+Z`, containing:
    - Primary matte graphite body mesh
    - Accent mesh(es) using material/node name `VORON_ACCENT`
    - LED diffuser meshes named `LED_LOGO`, `LED_NOZZLE_L`, `LED_NOZZLE_R`
    - Marker nodes `NOZZLE_TIP` (at `y ≈ 0`) and `FILAMENT_INLET` (at extruder top inlet)

- [ ] **Step 1: Write failing asset verification test `tests/templates-assets.test.mjs`**

Assert for both `public/models/templates/stealthburner.glb` (max `800_000` bytes) and `public/models/templates/mini-stealthburner.glb` (max `600_000` bytes):
- File exists and passes `validateGlbBuffer(buf)` with `assetVersion === '2.0'`.
- Byte size <= budget (`800_000` / `600_000`) and > `10_000` (not an empty stub).
- Parses the GLB JSON chunk and verifies:
  - `extensionsUsed` includes `'EXT_meshopt_compression'`.
  - Nodes or materials contain `VORON_ACCENT`, `LED_LOGO`, `LED_NOZZLE_L`, `LED_NOZZLE_R`, `NOZZLE_TIP`, and `FILAMENT_INLET`.
  - Every mesh primitive has valid `POSITION` accessor min/max bounds within realistic toolhead meter dimensions (height `0.05`–`0.22 m`, bottom `minY` within `[-0.005, 0.005]`).

- [ ] **Step 2: Run test to verify failure**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/templates-assets.test.mjs`
Expected: FAIL (`ENOENT` — template GLBs do not exist yet).

- [ ] **Step 3: Create `scripts/optimize-dockyard-glb.sh` and `scripts/build-voron-templates.py`, download official VoronDesign STLs to a temporary build folder, build & optimize both templates, and update `provenance.json` + `NOTICE.md`**

- Create `scripts/optimize-dockyard-glb.sh` (`chmod +x`) wrapping `npx --yes @gltf-transform/cli@4.5.1 optimize --compress meshopt --flatten false --join false --simplify --simplify-ratio <ratio> --simplify-error <err>` (`toolhead`: ratio `0.35`, error `0.001`; `printer`: ratio `0.25`, error `0.0005`).
- Fetch official VoronDesign STLs into a temp dir outside the repo (`/tmp/voron-template-sources`, never committed):
  - From `VoronDesign/Voron-Stealthburner`: main body, faceplate/accent, Clockwork 2 main body + motor plate + latch, LED carrier/diffusers (record exact commit SHA).
  - From `VoronDesign/Voron-0` (`Voron0.2r1`): `STLs/Toolheads/Mini_Stealthburner/` main body, cowling/accent, Mini-AfterSherpa / extruder body, LED diffusers (record exact commit SHA).
- Write `scripts/build-voron-templates.py` for `/Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/build-voron-templates.py -- ...`:
  - Imports the official STLs, aligns them into exact assembled StealthBurner & Mini-StealthBurner orientation (mm → m scale `0.001`, front `+Z`, grounded so nozzle tip is at `y = 0`, X/Z centered), adds subtle machined hotend/nozzle silhouette below the shroud where STL assembly omits metal hotend hardware, places `LED_LOGO`, `LED_NOZZLE_L`, `LED_NOZZLE_R` diffuser meshes accurately inside the Voron logo & underside nozzle LED pockets, places `NOZZLE_TIP` and `FILAMENT_INLET` empties, assigns matte graphite / satin metal / `VORON_ACCENT` PBR materials, decimates modestly if needed, and exports raw GLBs.
- Run Blender CLI + `./scripts/optimize-dockyard-glb.sh --preset toolhead` to produce `public/models/templates/stealthburner.glb` and `public/models/templates/mini-stealthburner.glb`.
- Visually sanity-check both rendered templates (e.g. quick Blender render or Three.js check) so orientation, proportions, accent faceplate, and LED pocket placement look crisp and authentic.
- Record upstream repo URLs, commit SHAs, STL file lists, byte sizes, triangle counts, and Meshopt settings in `public/models/provenance.json` (`templates` block) and add GPLv3 attribution in `NOTICE.md`.

- [ ] **Step 4: Run asset test & full test suite**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/templates-assets.test.mjs && npm test`
Expected: PASS (both GLBs valid, Meshopt-compressed, under budget, all 6 reserved nodes/materials present).

- [ ] **Step 5: Commit Task 3**

```bash
git add scripts/optimize-dockyard-glb.sh scripts/build-voron-templates.py public/models/templates/stealthburner.glb public/models/templates/mini-stealthburner.glb public/models/provenance.json NOTICE.md tests/templates-assets.test.mjs
git commit -m "feat: add VoronDesign StealthBurner and Mini-StealthBurner Meshopt 3D templates"
```

---

### Task 4: Shared Three.js Utilities (`src/scene-utils.mjs`) & `PrinterScene.vue`

**Files:**
- Create: `src/scene-utils.mjs`
- Modify: `src/components/ToolScene.vue:1-120,260-365,580-780`
- Create: `src/components/PrinterScene.vue`
- Test: `tests/scene-utils.test.mjs`

**Interfaces:**
- Consumes from Task 1: `DEFAULT_ACCENT_COLOR`, `normalizeAccentColor` from `src/model-config.mjs`.
- Consumes existing: `nozzleThermalGlow` from `src/thermal-glow.mjs`, `t` / `language` from `src/i18n.mjs`.
- Produces in `src/scene-utils.mjs`:
  - `export const LED_OFF_COLOR` (`0x1b2226`), `export const LED_ZERO_COLOR` (`0x000000`), `export const LED_DISCRETE_LERP_MS = 220`
  - `export function colorNear(a, b, eps = 1e-3): boolean`
  - `export function klipperRgbwToColor(rgbw): THREE.Color`
  - `export function stepLedMeshes(ledMeshes, now): boolean` (returns `true` if any animation still active)
  - `export function applyLedTargets(ledMeshes, getRgbwForMesh, { now, duration, force, reducedMotion }): boolean`
  - `export function createStudioLights(): THREE.Light[]` (exact Hemisphere + 3-point key/fill/rim rig matching `ToolScene.vue`)
  - `export function buildThermalGlowTexture(): THREE.CanvasTexture`
  - `export function buildStudioFloorVeil({ width, depth, tickXs = [] }): THREE.Mesh`
  - `export function classifyModelNodes(root): { accentMeshes: THREE.Mesh[], ledMeshes: THREE.Mesh[], nozzleTipNode: THREE.Object3D | null, filamentInletNode: THREE.Object3D | null }` (recognizes exact/substring case-insensitive names or `userData.dockyardRole`: `VORON_ACCENT`/`accent`, `LED_LOGO`/`led-logo` → `ledRole: 'number'`, `LED_NOZZLE_L`/`led-nozzle-l` → `ledRole: 'left'`, `LED_NOZZLE_R`/`led-nozzle-r` → `ledRole: 'right'`, `NOZZLE_TIP`, `FILAMENT_INLET`)
  - `export function detectNozzleTip(root, nozzleTipNode = null): THREE.Vector3 | null`
  - `export function disposeObjectTree(root): void`
- Produces in `src/components/PrinterScene.vue`:
  - Props: `sceneConfig: Object` (required), `tool: Object`, `online: Boolean`, `printerName: String`, `bedSize: Object`, `canWrite: Boolean`.
  - Emits: `open-settings`.
  - Renders either the compact empty-custom CTA card (`sceneConfig.emptyCustom === true`, no WebGL context) OR the Three.js studio viewport with conditional `Toolhead | Drucker` segmented switch, underside/reset camera buttons, live LEDs, thermal glow, filament inlet strand, live `VORON_ACCENT` tinting, and footer badge (`<source label>` + orbit hint).

- [ ] **Step 1: Write failing unit tests `tests/scene-utils.test.mjs`**

Using `three` directly in Node (pure geometry/scene graph tests — no WebGL required):
- `klipperRgbwToColor([0.8, 0.1, 0.1, 0.2])` clamps white-boosted RGB channels into `[0, 1]`.
- `classifyModelNodes(group)` identifies:
  - Mesh with material name `'VORON_ACCENT'` and mesh with node name `'Cowling_VORON_ACCENT'` → both in `accentMeshes`.
  - Meshes named `'LED_LOGO'`, `'LED_NOZZLE_L'`, `'LED_NOZZLE_R'` (and a node with `userData: { dockyardRole: 'led-logo' }`) → mapped to `ledRole` `'number'`, `'left'`, `'right'` in `ledMeshes`.
  - Empty nodes `'NOZZLE_TIP'` and `'FILAMENT_INLET'` → returned in `nozzleTipNode` / `filamentInletNode`.
- `detectNozzleTip(group, nozzleTipNode)` uses `nozzleTipNode`'s world position when present, and falls back to the centroid of lowest-Y vertices when `nozzleTipNode` is `null`.
- `applyLedTargets` + `stepLedMeshes` sets immediate values when `force: true` or `reducedMotion: true`, and smoothly interpolates over `duration` otherwise, returning `false` once settled.
- `disposeObjectTree` calls `.dispose()` on geometries and materials (including material arrays) without double-disposing shared resources.

- [ ] **Step 2: Run test to verify failure**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/scene-utils.test.mjs`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `src/scene-utils.mjs`).

- [ ] **Step 3: Implement `src/scene-utils.mjs`, refactor `ToolScene.vue` to reuse it, and create `src/components/PrinterScene.vue`**

- Implement `src/scene-utils.mjs` cleanly (guard `document.createElement('canvas')` inside browser-only texture helpers so pure helpers run cleanly in Node tests).
- Refactor `src/components/ToolScene.vue` to import `LED_OFF_COLOR`, `LED_ZERO_COLOR`, `LED_DISCRETE_LERP_MS`, `colorNear`, `klipperRgbwToColor`, `createStudioLights`, `buildThermalGlowTexture`, `disposeObjectTree` from `../scene-utils.mjs` without altering any STORMTROOPER visual parameter, geometry, or camera preset.
- Implement `src/components/PrinterScene.vue`:
  - Uses `GLTFLoader` + `MeshoptDecoder`, `EffectComposer` + `RenderPass` + `UnrealBloomPass` + `OutputPass` (no `OutlinePass`), `Reflector` + `buildStudioFloorVeil` scaled proportionally to loaded bounding box (`maxDim * 3.4` × `maxDim * 2.4`), positioned just below `box.min.y`.
  - Uses a monotonic `loadGeneration` counter so concurrent view/printer switches cancel stale loads and immediately `disposeObjectTree()` stale scenes.
  - Watches `sceneConfig.accentColor` to tint `accentMeshes` immediately without reloading GLBs; watches `sceneConfig.views` URLs to reload only when the active view URL changes; watches `[tool, online]` to update LEDs, `nozzleThermalGlow`, and PTFE/filament strand color (`tool?.material?.color ?? '#bec9cc'`, visible when `filamentEnabled === true ? filamentDetected === true : online`).
  - Demand-driven `requestAnimationFrame` loop paused via `IntersectionObserver` & `visibilitychange`; honors `prefers-reduced-motion`.
  - Clean `webglcontextlost` and load-error fallback with retry button.

- [ ] **Step 4: Run tests and production build check**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm test && VITE_MAINSAIL_URL=auto npm run build`
Expected: PASS (`tests/scene-utils.test.mjs` and all tests green, Vite build succeeds with zero warnings/errors).

- [ ] **Step 5: Commit Task 4**

```bash
git add src/scene-utils.mjs src/components/ToolScene.vue src/components/PrinterScene.vue tests/scene-utils.test.mjs
git commit -m "feat: extract shared 3D scene utilities and add PrinterScene component"
```

---

### Task 5: Cockpit UI Integration (`SpoolmanPicker.vue`, `SingleToolOverview.vue`, `SettingsDialog.vue`, `App.vue`, CSS & i18n)

**Files:**
- Create: `src/components/SpoolmanPicker.vue`
- Modify: `src/components/SingleToolOverview.vue:1-165,195-210`
- Modify: `src/App.vue:1-50,390-420,1080-1120,1485-1513`
- Modify: `src/components/SettingsDialog.vue:105-145,440-520,840-865`
- Modify: `src/style.css` (append compact flat-graphite styles for `PrinterScene`, `SpoolmanPicker`, Settings accent swatches & `.glb` upload cards, Display Mode 44 px rules)
- Modify: `src/locales/en.json`
- Test: `tests/i18n.test.mjs`, `npm test`, `npm run build`

**Interfaces:**
- Consumes from Tasks 1–4:
  - `resolveSceneConfig`, `ACCENT_SWATCHES`, `DEFAULT_ACCENT_COLOR`, `normalizeAccentColor` from `src/model-config.mjs`
  - `uploadModel`, `deleteModel` from `src/useSettings.js`
  - `PrinterScene.vue`
  - `/api/spoolman/spools`, `/api/spoolman/active`
- Produces in `src/components/SpoolmanPicker.vue`:
  - Props: `spoolman: Object` (`status?.spoolman`), `online: Boolean`, `canWrite: Boolean`.
  - Emits: `changed` (triggers immediate status refresh if desired).
  - Renders compact clickable pill in Extruder card when `spoolman?.available && spoolman?.connected`; opens searchable spool popover (`Escape`/outside-click closes, 44 px rows in `.app-shell.display-mode`), supports selecting a spool or clicking *„Spule entfernen“* (`POST /api/spoolman/active` with `X-Cockpit-Request: 1`), shows read-only state when `!canWrite` or `!online`.

- [ ] **Step 1: Implement `src/components/SpoolmanPicker.vue` and wire `SingleToolOverview.vue` + `App.vue`**

- Create `src/components/SpoolmanPicker.vue` matching flat graphite/lime design tokens (`--surface`, `--surface-deep`, `--line`, `--lime`, zero box-shadows).
- Update `src/components/SingleToolOverview.vue`:
  - Accept props `sceneConfig` (`Object`), `printerName` (`String`), `canWrite` (`Boolean`); emit `open-settings`, `refresh`.
  - Render `<PrinterScene v-if="sceneConfig?.kind === 'printer-scene'" ... @open-settings="emit('open-settings')" />` at the top of `.single-tool-main` above `.single-thermal-grid` (leaving `.single-thermal-grid`, `.single-metrics-strip`, `.tools-machine-panel` (`LedControls`), and `.single-tool-inspector` unchanged!).
  - Render `<SpoolmanPicker v-if="status?.spoolman?.available && status?.spoolman?.connected" :spoolman="status.spoolman" :online="online" :can-write="canWrite" @changed="emit('refresh')" />` in the Extruder card below `TemperatureTarget` / alongside `.single-thermal-meta`.
- Update `src/App.vue`:
  - Compute `sceneConfig = computed(() => resolveSceneConfig(settingsStore.activePrinter.value, status.value, { settingsLoaded: settingsStore.loaded.value }))`.
  - Derive `showStormtrooperScene = computed(() => sceneConfig.value.kind === 'stormtrooper-6tc')` and `hasAny3dScene = computed(() => sceneConfig.value.kind !== 'none' && !sceneConfig.value.emptyCustom)`.
  - Pass `:scene-config="sceneConfig"`, `:printer-name="printerName"`, `:can-write="settingsStore.runtime.value.canWrite !== false"` and `@open-settings="openSettings('printers')"` + `@refresh="refresh"` to `SingleToolOverview`.
  - In the multi-tool branch (`v-else`), render `<ToolScene v-if="showStormtrooperScene" ... />` OR `<PrinterScene v-else-if="sceneConfig.kind === 'printer-scene'" ... />` cleanly above `.tool-choices`.
  - Update footer `CAD-Referenz` badge to use `hasAny3dScene`.

- [ ] **Step 2: Extend `src/components/SettingsDialog.vue` for Presets, Accent Swatches & Custom `.glb` Upload/Delete**

- Update `modelPresetOptions` to all 6 presets (`auto`, `stealthburner`, `mini-stealthburner`, `stormtrooper-6tc`, `custom`, `none`) and update `cloneModelDraft` to preserve `accentColor` (normalized via `normalizeAccentColor`).
- Add **Akzentfarbe** picker shown whenever `selectedPrinter.model.preset` is not `'none'` and not `'stormtrooper-6tc'`:
  - 7 `ACCENT_SWATCHES` buttons with `aria-pressed`, accessible German labels, and a custom `<input type="color">` + hex readout (`settings-mono`).
- Add **Eigene CAD-Dateien (`.glb`)** block shown whenever `selectedPrinter.model.preset` is not `'none'` and not `'stormtrooper-6tc'`:
  - Detect whether `selectedPrinter.id` exists in persisted `settingsStore.printers.value` (`isPersistedPrinter`).
  - If `!isPersistedPrinter`: render compact hint *„Profil zuerst speichern, um eigene .glb-Dateien hochzuladen.“*.
  - If `isPersistedPrinter`:
    - Render slot card for **`Drucker-CAD (.glb)`** (`slot = 'printer'`), plus slot card for **`Toolhead-CAD (.glb)`** (`slot = 'toolhead'`) when `preset === 'custom'`.
    - Each card reads authoritative metadata from persisted `settingsStore.printers.value.find(p => p.id === selectedPrinter.id)?.customModels?.[slot]`, shows filename + formatted MB/KB size + *Ersetzen* + *Entfernen*, or drag-and-drop / file picker (`accept=".glb,model/gltf-binary"`), enforces client-side 25 MB hint before upload, displays uploading spinner & `role="status"` feedback, and calls `settingsStore.uploadModel` / `settingsStore.deleteModel` without resetting unsaved draft fields!
  - Add collapsible `<details>` **„Fusion-360-Export-Hilfe“** explaining `scripts/fusion-export-dockyard.py`, `scripts/optimize-dockyard-glb.sh`, and optional `VORON_ACCENT` / `LED_LOGO` / `LED_NOZZLE_L` / `LED_NOZZLE_R` naming.
- In import preview (`importPreview`), display a subtle note when any imported profile uses `preset === 'custom'` that local `.glb` files are not part of the JSON backup.

- [ ] **Step 3: Add CSS rules (`src/style.css`) and complete EN translations (`src/locales/en.json`)**

- Add crisp flat-graphite styles to `src/style.css` (zero CSS box-shadows):
  - `.printer-scene-panel` viewport height `clamp(260px, 34vh, 360px)` on desktop, `210px` in `.app-shell.display-mode`, `240px` at `@media(max-width:700px)`.
  - `.printer-scene-empty` compact dashed-border empty state for `emptyCustom`.
  - `.spoolman-wrap`, `.spoolman-pill`, `.spoolman-popover`, `.spoolman-search`, `.spoolman-list`, `.spoolman-row` (44 px min-height in `.app-shell.display-mode`).
  - `.settings-accent-row`, `.settings-swatch`, `.settings-model-slots`, `.settings-model-slot`, `.settings-dropzone` (dragover lime border, 44 px touch targets in Display Mode).
- Add every new German UI string introduced in Tasks 1–5 to `src/locales/en.json`.

- [ ] **Step 4: Run full test suite (including `tests/i18n.test.mjs`) and production build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm test && VITE_MAINSAIL_URL=auto npm run build`
Expected: PASS (100% tests green including i18n parity, clean Vite production build).

- [ ] **Step 5: Commit Task 5**

```bash
git add src/components/SpoolmanPicker.vue src/components/SingleToolOverview.vue src/App.vue src/components/SettingsDialog.vue src/style.css src/locales/en.json
git commit -m "feat: wire PrinterScene, SpoolmanPicker and custom CAD settings UI"
```

---

### Task 6: Generic macOS Fusion 360 Export Script, 3D-Print-Rig Importer, Guide & Live Multi-Printer Browser QC

**Files:**
- Create: `scripts/fusion-export-dockyard.py`
- Create: `scripts/import-3d-print-rig.sh`
- Create: `docs/fusion-cad-export.md`
- Test: `tests/fusion-export-syntax.test.mjs`

**Interfaces:**
- Produces in `scripts/fusion-export-dockyard.py`:
  - Pure-Python testable helper functions (usable without `adsk` loaded!):
    - `should_skip_fastener(name: str) -> bool`
    - `detect_dockyard_role(name: str, appearance_name: str = '') -> str | None` (`'accent' | 'led-logo' | 'led-nozzle-l' | 'led-nozzle-r' | None`)
    - `fusion_cm_to_gltf_m(x, y, z) -> (gx, gy, gz)` (`(x * 0.01, z * 0.01, -y * 0.01)`)
    - `build_glb_bytes(mesh_groups, source_name='') -> bytes` (packs normalized meshes + PBR materials + `extras.dockyardRole` + node names into valid GLB v2 binary)
  - Fusion 360 entry points `run(_context)` and `stop(_context)` presenting a native Fusion `CommandCreatedEventHandler` dialog with:
    1. Export slot (`Gesamter Drucker (printer)` | `Toolhead / Aktive Auswahl (toolhead)`)
    2. Quality preset (`Kompakt — Empfohlen` `0.04 cm` | `Detailreich` `0.02 cm`)
    3. Skip fasteners checkbox (default `True`)
    4. Output directory (default `~/Desktop/dockyard-exports`, overridable via `DOCKYARD_EXPORT_DIR`)
- Produces in `scripts/import-3d-print-rig.sh`:
  - CLI (`chmod +x`):
    - `--list [query]` (supports local `--manifest <path>` for offline tests, defaults to `https://raw.githubusercontent.com/Psych0h3ad/3d-print-rig/main/site/APPROVED_DELIVERY.json`)
    - `<machine-id> [--out <path>] [--upload <dockyard-url> <printer-id>] [--slot printer|toolhead] [--no-optimize]`
    - Verifies SHA-256 against manifest, gunzips, runs `scripts/optimize-dockyard-glb.sh --preset printer` by default, optionally uploads directly via `POST /api/models/<printer-id>/<slot>` with `X-Cockpit-Request: 1` & `X-Model-Filename`.
- Produces in `docs/fusion-cad-export.md`:
  - Practical step-by-step macOS guide for adding the script once in Fusion 360 Desktop, exporting V2.4 / Trident / V0.1 / Crucible, optional `VORON_ACCENT` / `LED_*` naming, importing any of the 73+ printers via `scripts/import-3d-print-rig.sh`, running `scripts/optimize-dockyard-glb.sh`, and uploading in DOCKYARD Settings.

- [ ] **Step 1: Write failing test `tests/fusion-export-syntax.test.mjs`**

Tests using `node:child_process` (`python3` + `bash`):
- Runs `python3 -m py_compile scripts/fusion-export-dockyard.py` and `bash -n scripts/import-3d-print-rig.sh` → both exit `0`.
- Imports `scripts/fusion-export-dockyard.py` in Python (guarding `adsk` import so pure helpers load cleanly outside Fusion!) and verifies:
  - `fusion_cm_to_gltf_m(10.0, 20.0, 30.0)` returns `(0.1, 0.3, -0.2)` (right-handed Z-up cm → Y-up m).
  - `should_skip_fastener('M3x8 SHCS')` is `True`; `should_skip_fastener('StealthBurner Main Body')` is `False`.
  - `detect_dockyard_role('LED_LOGO', '') === 'led-logo'`, `detect_dockyard_role('Faceplate', 'VORON_ACCENT Red') === 'accent'`, `detect_dockyard_role('LED_NOZZLE_L', '') === 'led-nozzle-l'`, `detect_dockyard_role('Frame Extrusion', 'Black Anodized') === null`.
  - `build_glb_bytes(...)` outputs raw bytes that pass Node's `validateGlbBuffer(buf)` from `server/models.mjs` and contain the expected node names & `extras.dockyardRole` in the glTF JSON chunk!
- Tests `scripts/import-3d-print-rig.sh --manifest <fixture.json> --list voron` against a local mock manifest JSON (offline, zero network calls) and verifies matching machine IDs and sizes are printed cleanly, and rejects unknown machine IDs with non-zero exit.

- [ ] **Step 2: Run test to verify failure**

Run: `export PATH="/opt/homebrew/bin:$PATH" && node --test tests/fusion-export-syntax.test.mjs`
Expected: FAIL (`scripts/fusion-export-dockyard.py` and `scripts/import-3d-print-rig.sh` do not exist yet).

- [ ] **Step 3: Implement `scripts/fusion-export-dockyard.py`, `scripts/import-3d-print-rig.sh`, and `docs/fusion-cad-export.md`**

- Implement `scripts/fusion-export-dockyard.py` cleanly with guarded `try: import adsk.core, adsk.fusion ... except ImportError: adsk = None` so pure helpers are unit-testable outside Fusion, while `run(_context)` opens the native Fusion Command Dialog, collects visible BRep bodies (or selected occurrences when `toolhead` + selection is active), applies right-handed Z-up cm → Y-up m transform, centers X/Z and grounds `minY = 0`, merges by `(role, materialKey)`, writes `<doc-slug>-<slot>.glb`, and displays a clear summary dialog with the copyable `./scripts/optimize-dockyard-glb.sh` command when output > 5 MB.
- Implement `scripts/import-3d-print-rig.sh` (`chmod +x`) supporting `--list [query]`, `--manifest <path>`, SHA-256 verification (`shasum -a 256`), `gunzip`, automatic `scripts/optimize-dockyard-glb.sh --preset printer`, and optional `--upload <url> <printer-id>`.
- Write concise, clear `docs/fusion-cad-export.md` covering setup in Fusion 360 Desktop on macOS, fleet workflow (V2.4, Trident, V0.1, Crucible), naming conventions, 3D-Print-Rig import, optimization, and DOCKYARD upload.

- [ ] **Step 4: Run full unit/integration test suite + production build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm test && VITE_MAINSAIL_URL=auto npm run build`
Expected: PASS (100% tests green, clean build).

- [ ] **Step 5: Run live Playwright Headless Chromium QC across 4 mock VORON printers**

Write a temporary verification script in `<artifactDir>/scratch/verify-paket2-ui.mjs` (never committed to repo) that spins up an isolated DOCKYARD server (`createPrinterRuntime` with temp `.dockyard-settings.json` + temp `.dockyard-models/`) and 4 mock Moonraker instances:
1. **STORMTROOPER (6-TC, `preset: 'auto'`)** — verify `ToolScene.vue` renders unchanged with 0 errors, 6 tools, `Werkzeuge / Drucker` switch.
2. **VORON 2.4 350 mm (Single-Tool, `preset: 'auto'`, Spoolman connected with 3 spools)** — verify StealthBurner template auto-selected, live LEDs + Spoolman badge (`ABS · Voron Red · 742 g`), open `SpoolmanPicker`, switch active spool (confirm `POST /api/spoolman/active` succeeds & pill updates), open Settings, change Accent Color swatch, upload a custom `printer.glb` via the Settings UI, confirm `Toolhead / Drucker` switcher appears and switches views cleanly.
3. **VORON V0.1 (Single-Tool 120 mm, `preset: 'auto'`, Spoolman 404)** — verify Mini-StealthBurner auto-selected, zero Spoolman UI clutter, zero 404 console errors, live nozzle thermal glow while heating.
4. **Crucible (Single-Tool, `preset: 'custom'`, no `.glb` yet)** — verify empty-custom CTA card renders cleanly with 0 errors, then upload `toolhead.glb` via Settings and verify it renders in `PrinterScene.vue`.

Inspect screenshots across Desktop (`1440×900`), 7" Display (`1024×600`, `?display=1`, verifying >= 44 px touch targets), and Mobile (`390×844`, verifying 0 horizontal overflow) — zero page errors, zero console errors, zero unexpected HTTP >= 400 responses.

- [ ] **Step 6: Commit Task 6**

```bash
git add scripts/fusion-export-dockyard.py scripts/import-3d-print-rig.sh docs/fusion-cad-export.md tests/fusion-export-syntax.test.mjs
git commit -m "feat: add generic Fusion 360 exporter, 3D-Print-Rig importer and export guide"
```
