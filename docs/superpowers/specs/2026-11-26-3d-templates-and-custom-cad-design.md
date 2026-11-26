# DOCKYARD 3D-Templates & Eigene Fusion-360-CADs — Design-Spezifikation (Paket 2)

**Datum:** 2026-11-26  
**Basis:** `main` (`9e75f8d`, Paket 1 Single-Tool & Multi-Printer Klipper Support abgeschlossen)  
**Zielgruppe:** DOCKYARD-Betreiber mit gemischter VORON-Flotte (z. B. STORMTROOPER 6-Toolchanger, VORON 2.4 350 mm, VORON Trident 300 mm, VORON V0.1, Crucible / Printer for Ants) auf macOS (Fusion 360 Desktop) und Raspberry Pi (Kiosk + LAN).

---

## 1. Absicht & Motivation

Mit Paket 1 unterstützt DOCKYARD beliebige Single-Tool- und Multi-Tool-Klipper-Drucker über Profile, zeigt bei Single-Tool-Druckern bisher jedoch ausschließlich die kartenbasierte Live-Übersicht (`SingleToolOverview.vue`) ohne 3D-Visualisierung.

Paket 2 bringt das charakteristische DOCKYARD-3D-Studio-Erlebnis auf die gesamte Flotte — **kompakt, leichtgewichtig und praxistauglich für Raspberry Pi & 7"-Display**:

1. **Eingebaute, echte VoronDesign-Templates (< 1 MB):** **StealthBurner** (VORON 2.4 / Trident) und **Mini-StealthBurner** (VORON V0.1 / Crucible / Printer for Ants) als fokussierte Toolhead-Hero-Modelle mit Live-Klipper-LEDs, Düsen-Hitze-Glow, Live-Filamentfarbe (inkl. Spoolman) und pro Drucker wählbarer VORON-Akzentfarbe.
2. **Eigene CAD-Dateien (`.glb`) pro Druckerprofil:** Deploy-sicherer Upload direkt in den DOCKYARD-Einstellungen — kombinierbar mit den eingebauten Templates (z. B. StealthBurner-Template als *Toolhead* + eigenes Fusion-360-Drucker-`.glb` als *Drucker*) oder komplett als *Eigenes CAD* (1 oder 2 Slots).
3. **Generische Fusion-360-Desktop-Export-Pipeline (macOS):** Wiederverwendbares Fusion-Python-Skript + Meshopt-Optimierer für beliebige Drucker- und Toolhead-Baugruppen statt der bisherigen STORMTROOPER-Sonderlogik.
4. **Native Moonraker-Spoolman-Integration:** Automatische Erkennung von `[spoolman]` in Moonraker, Anzeige der aktiven Spule (Farbe, Material, Name, Restgewicht), direkte Spulen-Auswahl im Cockpit und Live-Färbung des 3D-Filament-Einlaufs.

---

## 2. Ziele, Nicht-Ziele & Anti-Ziele

### Ziele
- **Null Regression für STORMTROOPER 6-TC:** `ToolScene.vue`, `/models/tools.glb`, `/models/printer.glb` und `/models/lights.json` funktionieren unverändert weiter.
- **Kompakte, authentische Templates:** Echte VoronDesign-Geometrie (GPLv3-attribuiert in `NOTICE.md` und `public/models/provenance.json`), Meshopt-komprimiert auf **< 800 KB** (`stealthburner.glb`) bzw. **< 600 KB** (`mini-stealthburner.glb`).
- **Live-Telemetrie in 3D:** Klipper-RGBW-LEDs (Logo + 2× Düsen-LED), `nozzleThermalGlow`, Filament-Einlauf/Farbe und reaktive Akzentfarbe funktionieren auf beiden Templates sowie auf konventionskonform getaggten eigenen `.glb`-Dateien.
- **Kombiniert & flexibel:** Template + optionales eigenes Drucker-`.glb` schalten automatisch den Modus-Umschalter `Toolhead / Drucker` frei; liegt nur ein Modell vor, erscheint kein überflüssiger Umschalter.
- **Deploy-sichere Speicherung:** Hochgeladene `.glb`-Dateien liegen außerhalb von `dist/` und `public/` neben `.dockyard-settings.json`, sodass `npm run build` und `scripts/deploy-pi.sh` sie niemals löschen.
- **Einfacher macOS-Fusion-Workflow:** Ein generisches Fusion-360-Skript (`scripts/fusion-export-dockyard.py`) plus 1-Befehl-Optimierer (`scripts/optimize-dockyard-glb.sh`) und kurze Export-Anleitung.
- **Spoolman-Integration (auto-erkannt):** Wenn Moonraker `[spoolman]` aktiviert hat, zeigt die Extruder-Karte die aktive Spule inkl. Restgewicht, erlaubt direktes Wechseln/Leeren der aktiven Spule und färbt den 3D-Filament-Einlauf live (auch im Leerlauf); Drucker ohne Spoolman bleiben komplett unberührt.
- **Design-System & Responsivität:** Flat-Graphite/Acid-Lime-Ästhetik gemäß `DESIGN.md` (keine Box-Shadows, `Onest`, `1px solid #354147`), sauberes Layout für Desktop (`1440×900`), 7"-Display-Modus (`1024×600`, 44 px Touch-Ziele) und Mobile (`390×844`), vollständig DE + EN.

### Nicht-Ziele
- **Keine Live-Kinematik-Animation:** Wie bei STORMTROOPER bleiben die 3D-CADs eine statische Studio-Referenz (Live-Druckvorschau/Werkzeugpfade bleiben in `PrintScene.vue`).
- **Keine parametrischen Drucker-Rahmen:** Der Nutzer hat sich bewusst für kompakte **Toolhead-Hero**-Templates + eigene Fusion-`.glb`-Uploads für komplette Drucker entschieden.
- **Keine serverseitige STEP/F3D/STL-Konvertierung auf dem Pi:** Export & Meshopt-Kompression laufen auf dem Mac; der DOCKYARD-Server validiert, speichert und liefert `.glb` (glTF 2.0 Binary).
- **Keine Spoolman-Verwaltung (Spulen anlegen/bearbeiten/archivieren):** DOCKYARD bindet die aktive Spule inkl. Spulen-Wechsel über Moonraker ein; Stammdatenpflege bleibt in der Spoolman-Weboberfläche.
- **Keine `.glb`-Binärdaten im JSON-Profil-Backup:** `dockyard-printers-backup.json` bleibt schlankes JSON; Custom-CADs sind lokal pro Instanz.
- **Kein Multi-Tool-Lineup-Konfigurator für andere Toolchanger:** Multi-Tool-Pick/Lineup bleibt STORMTROOPER (`ToolScene.vue`); andere Multi-Tool-Drucker können jedoch über `custom` ein eigenes `printer.glb` oder `toolhead.glb` anzeigen.

### Anti-Ziele
- Aufgeblähte Templates (> 2 MB) oder dauerhafte 60-FPS-Renderloops, die den Raspberry Pi oder das 7"-Kiosk-Display auslasten.
- Datenverlust hochgeladener `.glb`-Dateien bei einem normalen Build oder RPi-Deploy.
- Leere WebGL-Flächen oder 404-Fehlerkonsolen, wenn `preset: 'custom'` noch keine hochgeladene Datei hat.
- Manuelle Dateikopien per SSH/Terminal oder JSON-Edits, nur um einem Druckerprofil ein `.glb` zuzuweisen.

---

## 3. Betrachtete Ansätze & Entscheidung

| Ansatz | Kurzbeschreibung | Abwägung |
|---|---|---|
| **A — Gewählt (Nutzerentscheidung)** | Dedizierte `PrinterScene.vue` + gemeinsame `src/scene-utils.mjs` + echte VoronDesign-Meshopt-Templates (< 1 MB) + persistenter `.dockyard-models/`-Store & generisches Fusion-Skript | **Pro:** Authentischer Voron-Look auf STORMTROOPER-Niveau, null Regressionsrisiko für `ToolScene.vue`, extrem schnelle Ladezeiten, vollständig deploy-sicher. **Contra:** Einmaliger Erstellungsaufwand für die zwei VoronDesign-Template-GLBs via Blender + Meshopt. |
| **B — Monolithische `ToolScene.vue`** | Erweiterung der bestehenden 1015-Zeilen-`ToolScene.vue` um Single-Tool-Logik, Akzentfarben und Custom-Slots | **Contra:** Stark mit STORMTROOPER-Spezialitäten (`lights.json`, 6-Bay-Boden, Dock-Rail/Shuttle-Kameras, OutlinePass) verwoben; hohes Regressionsrisiko und schwer wartbar. |
| **C — Prozedurale Three.js-Templates** | Stilisierte Toolheads aus Three.js-Primitives ohne externe CAD-Geometrie | **Contra:** Fällt visuell deutlich hinter STORMTROOPERs echtem Fusion-CAD zurück, obwohl echte Meshopt-GLBs unter 1 MB bleiben. |

---

## 4. Architektur & Detail-Spezifikation

### 4.1 Modell-Konfiguration & Preset-Auflösung

#### Persistiertes Profil-Schema (`server/settings.mjs`, `src/useSettings.js`)
Erweiterung von `MODEL_PRESETS`:
```js
export const MODEL_PRESETS = [
  'auto',
  'stormtrooper-6tc',
  'stealthburner',
  'mini-stealthburner',
  'custom',
  'none',
]
export const DEFAULT_ACCENT_COLOR = '#c5f76b'
```

Pro Druckerprofil wird in `.dockyard-settings.json` unter `printer.model` persistiert:
```json
{
  "preset": "stealthburner",
  "accentColor": "#d62828"
}
```
- `preset`: muss in `MODEL_PRESETS` liegen (Default: `'auto'`).
- `accentColor`: optionaler 6-stelliger Hex-Farbwert `#rrggbb` (normalisiert zu Kleinbuchstaben; fehlt er oder ist leer, wird `'#c5f76b'` genutzt; ungültige Strings werden bei `POST /api/settings` mit HTTP `400` abgelehnt).
- Abwärtskompatibilität: Bestehende `.dockyard-settings.json`-Dateien ohne `accentColor` werden beim Laden nahtlos auf `{ preset, accentColor: '#c5f76b' }` normalisiert.

#### Server-verwaltete `customModels`-Metadaten (Read-Only im Public-Profil)
Um zu verhindern, dass `POST /api/settings` versehentlich Datei-Metadaten überschreibt oder Clients Dateigrößen fälschen können, liegen hochgeladene Datei-Metadaten **nicht** im beschreibbaren `printer.model`, sondern werden vom Server beim Ausliefern von `getPublicSettings()` aus dem Dateisystem-Store als Read-Only-Feld `printer.customModels` angehängt:

```json
"customModels": {
  "toolhead": null,
  "printer": {
    "filename": "voron24-350.glb",
    "bytes": 3910400,
    "updatedAt": "2026-11-26T10:32:00.000Z",
    "etag": "\"a1b2c3...\""
  }
}
```
- `exportProfiles()` exportiert ausschließlich `model: { preset, accentColor }` (keine `customModels`-Binärverweise).
- Beim Löschen eines Druckerprofils über `POST /api/settings` löscht der Server automatisch den zugehörigen Ordner `.dockyard-models/<printerId>/`.

#### Deterministische Szenen-Auflösung (`src/model-config.mjs`)
Ein reines Shared-Modul `src/model-config.mjs` (unit-getestet) stellt `resolveSceneConfig(printerProfile, status, { settingsLoaded })` bereit und liefert genau eines von drei Ergebnissen:

1. `{ kind: 'none' }` — Keine 3D-Szene (kompakte Live-Übersicht wie in Paket 1).
2. `{ kind: 'stormtrooper-6tc' }` — Bestehende `ToolScene.vue` (STORMTROOPER 6-TC, unverändert).
3. `{ kind: 'printer-scene', effectivePreset, accentColor, defaultView, emptyCustom, views: { toolhead: ModelSource | null, printer: ModelSource | null } }` — Neue `PrinterScene.vue`.

Dabei ist `ModelSource`:
```js
{
  url: string,           // '/models/templates/stealthburner.glb' oder '/api/models/<id>/<slot>?v=<updatedAt>'
  sourceKind: 'template' | 'custom',
  templateId?: 'stealthburner' | 'mini-stealthburner',
  filename?: string,
  bytes?: number,
}
```

**Exakte Auflösungsregeln:**
- Ist `!settingsLoaded` → `{ kind: 'none' }` (verhindert Kaltstart-Flackern vor dem Laden der Einstellungen).
- `preset === 'none'` → `{ kind: 'none' }`.
- `preset === 'stormtrooper-6tc'`:
  - Wenn `!status || (status.isToolchanger && status.toolCount === 6)` → `{ kind: 'stormtrooper-6tc' }`.
  - Sonst (verbundener Drucker ist kein 6-TC) → `{ kind: 'none' }`.
- `preset === 'stealthburner'` oder `'mini-stealthburner'`:
  - Sofort aktiv (auch offline vor dem ersten Status-Frame):
    - `views.toolhead` = Template (`/models/templates/<preset>.glb`)
    - `views.printer` = `customModels.printer` (falls vorhanden, sonst `null`)
    - `defaultView = 'toolhead'`, `emptyCustom = false`.
- `preset === 'custom'`:
  - `views.toolhead = customModels.toolhead` (falls vorhanden, sonst `null`)
  - `views.printer = customModels.printer` (falls vorhanden, sonst `null`)
  - Wenn beide `null`: `{ kind: 'printer-scene', emptyCustom: true, views: { toolhead: null, printer: null }, ... }` → zeigt eine kompakte leere Kachel mit Button **„CAD in Einstellungen hochladen“** (kein WebGL-Kontext, keine 404s).
  - Wenn nur `printer` vorhanden: `defaultView = 'printer'`.
  - Wenn `toolhead` (allein oder mit `printer`) vorhanden: `defaultView = 'toolhead'`.
- `preset === 'auto'` *(Entscheidung des Autors — bitte bei Freigabe prüfen)*:
  - Wenn `!status` (offline / verbindet noch) → `{ kind: 'none' }` (verhindert sowohl ein kurzes StealthBurner-Aufblitzen bei STORMTROOPER als auch Modell-Wechsel direkt nach dem Verbinden; für sofortige Offline-Vorschau ohne Klipper-Verbindung einfach ein explizites Preset wie `stealthburner`, `mini-stealthburner` oder `custom` wählen).
  - Wenn `status.isToolchanger && status.toolCount === 6` → `{ kind: 'stormtrooper-6tc' }`.
  - Wenn Single-Tool (`!status.isToolchanger && status.toolCount === 1`):
    - Automatische Template-Wahl anhand `status.bedSize`: `width <= 165` (z. B. VORON V0.1 120 mm, Crucible ~150 mm) → `'mini-stealthburner'`; sonst (z. B. VORON 2.4 350 mm, Trident 300 mm oder unbekannte Bettgröße) → `'stealthburner'`.
    - Kombiniert mit `customModels.printer`, falls ein eigenes Drucker-CAD hochgeladen wurde (`customModels.toolhead` wird unter `auto` ignoriert, da der Toolhead-Slot nur bei `preset === 'custom'` aktiv ist).
  - Sonstige Multi-Tool-Drucker (`status.toolCount > 1`, sowohl Nicht-6-TC-Toolchanger als auch Multi-Extruder/IDEX ohne Toolchanger):
    - Falls `customModels.toolhead` oder `customModels.printer` hochgeladen sind → `{ kind: 'printer-scene' }` mit diesen Custom-Slots (`defaultView = toolhead ?? printer`), sonst `{ kind: 'none' }`.

> **Wichtig für `App.vue`:** `PrinterScene.vue` wird bei Single-Tool-Druckern innerhalb von `SingleToolOverview.vue` gerendert; bei Nicht-6-TC-Multi-Toolchangern mit `kind === 'printer-scene'` rendert `PrinterScene.vue` in `.scene-column` oberhalb der Tool-Karten (ohne Multi-Tool-Picking).

---

### 4.2 Persistenter Custom-Model-Speicher & HTTP-API

#### Speicherort & Deploy-Sicherheit (`server/config.mjs`, `server/models.mjs`)
- Neues Konfig-Feld `modelsDir` in `server/config.mjs`:
  ```js
  export const modelsDir =
    (process.env.DOCKYARD_MODELS_DIR || '').trim() ||
    path.join(path.dirname(settingsFilePath), '.dockyard-models')
  ```
- Verzeichnisstruktur:
  ```text
  .dockyard-models/
    <printerId>/
      toolhead.glb
      toolhead.meta.json
      printer.glb
      printer.meta.json
  ```
- `.dockyard-models/` wird in `.gitignore` aufgenommen.
- `scripts/deploy-pi.sh` synchronisiert ausschließlich `dist/`, `server/`, `src/` und `package.json` — `.dockyard-models/` im Deploy-Ordner auf dem Raspberry Pi bleibt bei jedem Update vollständig erhalten.

#### Strenge GLB-v2-Validierung (`server/models.mjs`)
- **Größenlimit:** **25 MB** (`26_214_400` Bytes) hartes Limit beim Einlesen des Streams (bei Überschreitung wird der Stream sofort abgebrochen und HTTP `413` mit Hinweis auf `scripts/optimize-dockyard-glb.sh` zurückgegeben). Mindestgröße: 28 Bytes.
- **Header- & Strukturprüfung (`validateGlbBuffer(buffer)`):**
  1. Magic Bytes `0..3` === `0x46546C67` (`"glTF"`).
  2. Version `4..7` (uint32 LE) === `2`.
  3. Gesamtlänge `8..11` (uint32 LE) === `buffer.byteLength`.
  4. Erster Chunk (`12..19`): Chunk-Typ === `0x4E4F534A` (`"JSON"`), Chunk-Länge liegt innerhalb des Buffers, Payload ist gültiges UTF-8-JSON-Objekt mit `asset.version` beginnend mit `'2'`.
- **Pfadsicherheit:** `printerId` gegen `/^[a-z0-9][a-z0-9_-]{0,31}$/` geprüft, `slot` strikt auf `'toolhead' | 'printer'` gewhitelistet; Zielpfad zusätzlich gegen `path.resolve(modelsDir)` verifiziert.
- **Atomares Schreiben:** `.glb.<rand>.tmp` + `.meta.json.<rand>.tmp` schreiben und per `rename` atomar ersetzen; SHA-256-Hash als `etag` speichern.

#### HTTP-Endpunkte (`server/printer.mjs`)
Route: `/^\/api\/models\/([a-z0-9][a-z0-9_-]{0,31})\/(toolhead|printer)$/`

| Methode | Zweck | Schutz & Verhalten |
|---|---|---|
| `GET /api/models/:printerId/:slot` | Liefert die `.glb`-Binärdatei | `Content-Type: model/gltf-binary`, `X-Content-Type-Options: nosniff`, `ETag`, `Cache-Control: private, no-cache`, `If-None-Match` → `304`, sonst `404` JSON. |
| `POST /api/models/:printerId/:slot` | Lädt eine neue/aktualisierte `.glb` hoch | **`sameOriginRequest`-Guard (`403`)**, prüft ob `printerId` im gespeicherten Profilbestand existiert (`404` bei ungespeichertem Entwurf), Raw-Binary-Body (`application/octet-stream` oder `model/gltf-binary`), Dateiname via Header `X-Model-Filename` (URL-decodiert, nur Basename, max. 120 Zeichen, Fallback `<slot>.glb`), `validateGlbBuffer`, atomares Speichern. Antwort `200`: `{ ok: true, printerId, slot, meta, settings }`. |
| `DELETE /api/models/:printerId/:slot` | Entfernt die `.glb`-Datei eines Slots | **`sameOriginRequest`-Guard (`403`)**, idempotentes Löschen von `.glb` + `.meta.json` + leerem Druckerordner. Antwort `200`: `{ ok: true, printerId, slot, settings }`. |

*Hinweis:* Die Middleware `printerMiddleware` läuft identisch im Vite-Dev-Server und in `server/start.mjs` — damit funktionieren alle drei Endpunkte nahtlos in Entwicklung, Vorschau und auf dem Raspberry Pi.

---

### 4.3 Eingebaute VoronDesign-3D-Templates

#### Ziel-Assets & Budget
- `public/models/templates/stealthburner.glb` — **Zielgröße < 800 KB** (Meshopt-komprimiert, ~15.000–40.000 Dreiecke)
- `public/models/templates/mini-stealthburner.glb` — **Zielgröße < 600 KB** (Meshopt-komprimiert, ~12.000–35.000 Dreiecke)

#### Quellen, Reproduzierbarkeit & Lizenzierung
- Offizielle VoronDesign-STLs/CADs (GPLv3):
  - **StealthBurner:** `VoronDesign/Voron-Stealthburner` (Main Body, Faceplate/Accent-Shell, Clockwork 2 Body & Latch, Hotend/Nozzle-Silhouette, Logo- & Düsen-LED-Diffusoren).
  - **Mini-StealthBurner:** `VoronDesign/Voron-0` (`Voron0.2r1`, `STLs/Toolheads/Mini_Stealthburner`: Main Body, Cowling/Accent, Mini-Extruder-Body, Hotend/Nozzle-Silhouette, Logo- & Düsen-LED-Diffusoren).
- Reproduzierbares Blender-Python-Build-Skript `scripts/build-voron-templates.py` (erzeugt die Roh-GLBs mit exakten Materialien/Tags) + Nachbearbeitung mit `scripts/optimize-dockyard-glb.sh` (`@gltf-transform/cli` + Meshopt).
- Vollständige Dokumentation in `public/models/provenance.json` (Upstream-Repos, Commit/Tag, Dateigrößen, Dreieckszahlen, Optimierungs-Parameter) sowie GPLv3-Attribution in `NOTICE.md`.

#### Einheitliche Node-/Material-Konvention (Templates & eigene Fusion-Exports)
- **Koordinaten:** glTF-Standard **Y-up**, **Meter**, X/Z auf Ursprung zentriert, tiefster Punkt (Düsenspitze beim Toolhead bzw. Füße beim Drucker) auf `y = 0`, Vorderseite zeigt Richtung `+Z`.
- **Standard-Materialien auf Templates:**
  - Hauptkörper: Mattes VORON-Graphit (`#242a2e`, `roughness: 0.58`, `metalness: 0.08`)
  - Mechanik/Metall (Hotend/Düsenblock/Schraubenakzente): Satiniertes Metall (`#8b969c`, `roughness: 0.36`, `metalness: 0.45`)
  - Akzentteile (StealthBurner-Faceplate / Mini-SB-Cowling & Latch): Material- und/oder Node-Name **`VORON_ACCENT`** → wird zur Laufzeit dynamisch mit `printer.model.accentColor` eingefärbt.
- **Reservierte Live-Node-Namen (case-insensitive, auch via glTF `extras.dockyardRole`):**
  - `VORON_ACCENT` — Akzentfarbe (reaktiv aus Druckerprofil)
  - `LED_LOGO` — Klipper `tools[0].leds.number` (Emissive-Stärke `2.3`)
  - `LED_NOZZLE_L` — Klipper `tools[0].leds.left` (Emissive-Stärke `4.5`)
  - `LED_NOZZLE_R` — Klipper `tools[0].leds.right` (Emissive-Stärke `4.5`)
  - `NOZZLE_TIP` (Empty-Node, optional) — Ankerpunkt für Düsen-Hitze-Glow; ohne Marker automatische Erkennung über die tiefsten Vertices (analog `ToolScene.vue`)
  - `FILAMENT_INLET` (Empty-Node, optional) — Ankerpunkt für den kurzen transluzenten PTFE-Einlauf + farbigen Filamentstrang

*Custom `.glb`-Dateien ohne diese Tags funktionieren trotzdem problemlos* als dreh- und zoombare CAD-Ansicht auf dem Studio-Boden; wer die Namen in Fusion vergibt, bekommt Live-LEDs und Akzentfarbe gratis dazu.

---

### 4.4 Shared Three.js-Helfer (`src/scene-utils.mjs`) & `PrinterScene.vue`

#### Gemeinsame Helfer (`src/scene-utils.mjs`)
Saubere Extraktion aus `ToolScene.vue` ohne Verhaltensänderung bei STORMTROOPER:
- LED-Farbkonstanten & Interpolation (`LED_OFF_COLOR`, `LED_ZERO_COLOR`, `LED_DISCRETE_LERP_MS`, `colorNear`, `klipperRgbwToColor`, `stepLedAnimations`)
- Studio-Setup (`createStudioLights`, `buildThermalGlowTexture`, `buildFloorVeilTexture`, `disposeObjectTree`)
- Modell-Analyse (`classifyModelNodes(root)` für `VORON_ACCENT`, `LED_*`, `NOZZLE_TIP`, `FILAMENT_INLET`; `detectNozzleTip(root)`)

#### Neue Komponente `src/components/PrinterScene.vue`
- **Props:** `sceneConfig`, `tool`, `online`, `printerName`, `bedSize`.
- **Emits:** `open-settings` (öffnet Einstellungen direkt im Drucker-Tab beim Klick auf den Upload-Button im leeren Custom-Zustand).
- **Render-Pipeline (Pi-optimiert):**
  - `WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })`, `pixelRatio <= 1.75`, `ACESFilmicToneMapping` (`exposure: 1.3`), Hintergrund `#1b252a`.
  - `EffectComposer` + `RenderPass` + `UnrealBloomPass` + `OutputPass` (bewusst **ohne** `OutlinePass` für noch geringere GPU-Last).
  - Demand-driven Rendering (`invalidate()` nur bei Interaktion, Resize, aktiver LED-/Kamera-Animation oder geänderter visueller Signatur; `IntersectionObserver` + `visibilitychange` pausieren unsichtbare Tabs).
  - Dynamisch auf die Modell-Bounding-Box skalierter `Reflector`-Boden + radialer Studio-Schleier (`#1b252a`), sodass sowohl ein 12 cm Toolhead als auch ein 55 cm VORON 2.4 sauber im Studio stehen.
- **Live-Bindings:**
  - **LEDs:** `LED_LOGO` / `LED_NOZZLE_L` / `LED_NOZZLE_R` folgen `tool?.leds` mit derselben sanften LERP-Animation wie `ToolScene.vue` (`prefers-reduced-motion` respektiert).
  - **Düsen-Hitze-Glow:** Aktiv im `toolhead`-Modus via `nozzleThermalGlow(tool?.temperature, online)` am `NOZZLE_TIP`-Anker (Spitzen-Glow + subtiler Boden-Lichtpool).
  - **Filament-Einlauf:** Im `toolhead`-Modus an `FILAMENT_INLET` (wenn vorhanden): transluzenter PTFE-Stummel + Filamentstrang in `tool?.material?.color ?? '#bec9cc'` (bei vorhandenem Filamentsensor sichtbar sobald `filamentDetected === true`; bei Druckern ohne Filamentsensor dezent sichtbar solange `online`). Priorität für `tools[0].material` bei Single-Tool-Druckern: **1. Aktive Spoolman-Spule** (Abschnitt 4.7, auch im Leerlauf) → **2. 1-Slot-Slicer-Metadaten** aus `server/materials.mjs` während laufender/pausierter Drucke (OrcaSlicer/PrusaSlicer/SuperSlicer `filament_type` & `filament_colors`; 6-TC-Verhalten bleibt unverändert) → **3. Neutraler Fallback `#bec9cc`**.
  - **Live-Akzentfarbe:** Ändert sich `sceneConfig.accentColor`, werden alle `VORON_ACCENT`-Materialien sofort live aktualisiert (kein erneutes Laden der `.glb`).
- **Toolbar & Aktionen:**
  - Links: Segmentierter Umschalter **`Toolhead | Drucker`** — **nur sichtbar**, wenn beide Slots (`views.toolhead` UND `views.printer`) existieren.
  - Rechts:
    - `Unterseite / Düse` (`ArrowDownToLine`, nur im `toolhead`-Modus — schwenkt nach unten auf Düse & Düsen-LEDs)
    - `Ansicht zurücksetzen` (`RotateCcw`)
- **Fußzeile:** Kompakter Badge (`StealthBurner · Vorlage`, `Mini-StealthBurner · Vorlage` oder `<filename> · Eigenes CAD`) + Bedienhinweis (`Ziehen zum Drehen · Scrollen zum Zoomen`).
- **Speicher- & Wechsel-Sicherheit:** Jeder Ladevorgang nutzt ein Generation-Token; alte/abgebrochene Modelle werden zuverlässig mit `disposeObjectTree()` freigegeben, damit häufiges Drucker-Wechseln auf dem Raspberry Pi keinen WebGL-Speicher leakt.

#### Layout in `SingleToolOverview.vue` (Desktop / 7"-Display / Mobile)
Das bewährte Paket-1-Layout von `SingleToolOverview.vue` bleibt vollständig erhalten (`LedControls` links, `Schnellaktionen` + `FanControl` im 316-px-Inspector rechts, `ConsoleView compact` darunter in `App.vue`, `TemperatureGraph` bleibt im Tab `Steuerung`). `PrinterScene.vue` wird lediglich kompakt oben in `.single-tool-main` eingefügt:

```text
Desktop (1440×900):
┌──────────────────────────────────────────────┬────────────────────────┐
│ [PrinterScene: Toolhead / Drucker]           │ Inspektor (316 px)     │
│  height: clamp(260px, 34vh, 360px)           │  - Schnellaktionen     │
├──────────────────────┬───────────────────────┤    (wenn konfiguriert) │
│ Extruder (Ist/Soll)  │ Druckbett (Ist/Soll)  │  - Lüfter (FanControl) │
├──────────────────────┴───────────────────────┤                        │
│ Telemetrie-Streifen (XYZ, Status, Sensoren)  │                        │
├──────────────────────────────────────────────┤                        │
│ Maschine & Vorbereitung (LedControls:        │                        │
│ Homing, QGL/Z-Tilt, Motoren aus, LED-Deck)   │                        │
├──────────────────────────────────────────────┴────────────────────────┤
│ Kompakte Konsole (ConsoleView compact in App.vue — unverändert)       │
└───────────────────────────────────────────────────────────────────────┘
```
- **7"-Display-Modus (`1024×600`, `.app-shell.display-mode`):** Kompakte Bühnenhöhe `210px`, alle Toolbar-Buttons `44px × 44px`.
- **Mobile (`<= 700px`):** Bühnenhöhe `240px`, Thermal-Karten 1-spaltig darunter, `0 px` horizontaler Überlauf.

---

### 4.5 Einstellungs-UI (`SettingsDialog.vue`, `useSettings.js`)

Im Abschnitt **Druckerprofil → 3D-Ansicht / Modell**:

1. **Preset-Auswahl (`CockpitSelect`):**
   - `Automatisch (empfohlen)` (`auto`)
   - `StealthBurner (VORON 2.4 / Trident)` (`stealthburner`)
   - `Mini-StealthBurner (V0 / Ants)` (`mini-stealthburner`)
   - `STORMTROOPER 6-Toolchanger (3D CAD)` (`stormtrooper-6tc`)
   - `Eigenes CAD (.glb)` (`custom`)
   - `Kein 3D (nur Live-Übersicht)` (`none`)

2. **Akzentfarbe** *(sichtbar bei allen Presets außer `none` und `stormtrooper-6tc` — also `auto`, `stealthburner`, `mini-stealthburner` und `custom`, damit auch `VORON_ACCENT`-getaggte eigene `.glb`-Exporte direkt einfärbbar sind)*:
   - 7 kuratierte VORON-Swatches (`VORON-Rot #d62828`, `Acid-Lime #c5f76b`, `Arctic-Weiß #dce6e2`, `Signal-Amber #f3c67b`, `Kobaltblau #3b82f6`, `Violett #9b5de5`, `Graphit #495860`) + nativer Color-Picker / Hex-Eingabe.
   - `aria-pressed`, lesbare Farbnamen, 44 px Touch-Größe im Display-Modus.

3. **Eigene CAD-Dateien (`.glb`)** *(sichtbar bei allen Presets außer `none` und `stormtrooper-6tc`)*:
   - Bei einem **noch ungespeicherten neuen Drucker-Entwurf**: kompakter Hinweis *„Profil zuerst speichern, um eigene `.glb`-Dateien hochzuladen.“* (verhindert verwaiste Dateien bei Abbruch).
   - Bei gespeicherten Profilen:
     - **Slot `Drucker-CAD (.glb)`** (bei `auto`, `stealthburner`, `mini-stealthburner`, `custom`): zeigt aktuelle Datei (`voron24-350.glb · 3,4 MB`), *Ersetzen*- und *Entfernen*-Button bzw. Drag-&-Drop-Zone / *`.glb` hochladen*-Button (max. 25 MB).
     - **Slot `Toolhead-CAD (.glb)`** (zusätzlich bei `custom`): identische Bedienung.
   - Upload & Löschen wirken sofort über `/api/models/:printerId/:slot` und aktualisieren den Store live, ohne ungespeicherte Textänderungen im Einstellungsentwurf zu verlieren.
   - Einklappbare **Fusion-360-Export-Hilfe (`<details>`)** mit Kurz-Anleitung (`scripts/fusion-export-dockyard.py` → optional `scripts/optimize-dockyard-glb.sh`) und den optionalen Node-/Material-Namen (`VORON_ACCENT`, `LED_LOGO`, `LED_NOZZLE_L`, `LED_NOZZLE_R`).

4. **Backup/Import-Hinweis:** Beim Importieren einer Backup-JSON-Datei weist die Import-Vorschau dezent darauf hin, falls Profile `preset: 'custom'` enthalten, dass eigene `.glb`-Dateien nicht Teil der JSON-Sicherung sind.

---

### 4.6 Generische Fusion-360-Desktop-Export-Pipeline (macOS)

#### 1. `scripts/fusion-export-dockyard.py` (Fusion 360 *Utilities → Scripts & Add-Ins*)
Reine Fusion-API + Python-Standardbibliothek (keine Drittpakete nötig):
- Funktioniert mit **jedem** beliebigen offenen Fusion-360-Dokument (keine hartkodierten STORMTROOPER-Namen).
- Nativer Fusion-Dialog beim Ausführen:
  1. **Export-Slot:** `Gesamter Drucker (printer)` oder `Toolhead / Aktuelle Auswahl (toolhead)` (bei `toolhead` + aktiver Auswahl in Fusion wird nur die ausgewählte Unterbaugruppe exportiert, sonst alle sichtbaren Körper).
  2. **Qualität:** `Kompakt — Empfohlen` (`LowQualityTriangleMesh`, `surfaceTolerance = 0.04 cm`) oder `Detailreich` (`NormalQualityTriangleMesh`, `surfaceTolerance = 0.02 cm`).
  3. **Kleinteile ausblenden (Standard: An):** überspringt Schrauben, Muttern, Unterlegscheiben, Gewindeeinsätze, Stifte und Kugellager anhand robuster Namensmuster (spart typisch 40–60 % der Dreiecke).
  4. **Ausgabeordner:** Standard `~/Desktop/dockyard-exports` (optional via `DOCKYARD_EXPORT_DIR` überschreibbar).
- **Geometrie-Normalisierung:**
  - Rechtshändige Transformation Fusion Z-up (cm) → glTF Y-up (m): `(x, y, z) -> (x * 0.01, z * 0.01, -y * 0.01)` (erhält Flächennormalen ohne Inversion).
  - X/Z zentriert auf `0`, tiefster Punkt auf `y = 0`.
  - Verschmilzt BRep-Meshes pro `(dockyardRole, materialKey)` zu wenigen Draw-Calls.
  - Erkennt optionale Tags aus Body-/Component-/Appearance-Namen (`VORON_ACCENT`, `LED_LOGO`, `LED_NOZZLE_L`, `LED_NOZZLE_R`, sowie Fusion-`LED -`-Appearances) und schreibt sie in Node-Namen & glTF-`extras.dockyardRole`.
- Schreibt sofort eine gültige, direkt in DOCKYARD hochladbare `.glb`-Datei (`<doc-slug>-<slot>.glb`) und zeigt im Abschlussdialog Dateigröße, Dreieckszahl sowie (ab ~5 MB) den kopierfertigen Optimierungsbefehl an.

#### 2. `scripts/optimize-dockyard-glb.sh`
- Aufruf: `./scripts/optimize-dockyard-glb.sh <eingabe.glb> [ausgabe.glb] [--preset toolhead|printer]`
- Nutzt `npx --yes @gltf-transform/cli@4.5.1 optimize` mit `--compress meshopt` und maßvoller Simplifizierung (schrumpft typische Fusion-Drucker-Exporte von 20–50 MB auf **2–6 MB**), wobei benannte Tag-Nodes (`VORON_ACCENT`, `LED_*`, `NOZZLE_TIP`, `FILAMENT_INLET`) erhalten bleiben (`--flatten false --join false` bzw. gezielter Schutz).
- Prüft die resultierende Dateigröße gegen das 25-MB-Upload-Limit und meldet Erfolg oder stärkere Kompressionsoption.

#### 3. `scripts/import-3d-print-rig.sh` (On-Demand-Katalogimport aus `Psych0h3ad/3d-print-rig`)
- Greift auf das öffentliche Manifest `APPROVED_DELIVERY.json` von `Psych0h3ad/3d-print-rig` zu (73+ fertige Drucker-Assemblies: VORON 2.4 Printed/LDO CNC, Trident, V0.2/V0.2r1, SIBOOR, FYSETC, Micron, Switchwire, RatRig, VzBot, Sovol SV08, Mercury, Rook, Annex u. a.).
- Modi:
  - `./scripts/import-3d-print-rig.sh --list [suchwort]` — listet verfügbare `machine_ids` inkl. Downloadgröße (`.glb.gz`).
  - `./scripts/import-3d-print-rig.sh <machine-id> [--out <datei.glb>] [--upload <dockyard-url> <printer-id>]` — lädt `model.glb.gz` herunter, prüft SHA-256 gegen das Manifest, entpackt, optimiert automatisch mit `scripts/optimize-dockyard-glb.sh --preset printer` (typisch 30–85 MB → 2–6 MB Meshopt) und lädt auf Wunsch direkt per `POST /api/models/<printer-id>/printer` ins Profil hoch.
- Keine Weiterverteilung fremder Modelle im Git-Repo; jedes geladene Modell bleibt lokal auf der Maschine des Nutzers in `.dockyard-models/`.

#### 4. `docs/fusion-cad-export.md`
Kurze Schritt-für-Schritt-Anleitung für Fusion 360 Desktop auf macOS (einmalige Einrichtung des Skripts, Export für V2.4 / Trident / V0.1 / Crucible, optionale LED-/Akzent-Benennung, Optimierung, 3D-Print-Rig-Katalogimport & Upload in DOCKYARD).

---

### 4.7 Native Moonraker-Spoolman-Integration (`server/spoolman.mjs`, `SpoolmanPicker.vue`)

#### Backend-Reader & Auto-Erkennung (`server/spoolman.mjs`)
Kein separates Spoolman-URL-Feld nötig — DOCKYARD kommuniziert ausschließlich über Moonrakers eingebaute Spoolman-Komponente:
- **`createSpoolmanReader(getPrinter, fetchImpl, onUpdate)`:**
  - Fragt `GET <printer>/server/spoolman/status` ab (Timeout 5 s, `redirect: 'error'`, Cache 15 s).
  - Meldet Moonraker `404` / nicht konfiguriert → `{ available: false, connected: false, spoolId: null, activeSpool: null }` mit 60 s Backoff (null Fehler-Logs, null UI-Elemente bei Druckern ohne `[spoolman]`).
  - Bei `spoolman_connected === true` und gesetzter `spool_id` (positive Ganzzahl): holt Spulendetails über `POST <printer>/server/spoolman/proxy` mit `{ request_method: 'GET', path: '/v1/spool/' + spoolId }` (Cache 30 s, sofortige Aktualisierung bei Wechsel von `spool_id` oder `invalidate()`).
  - Normalisierte Spulenstruktur:
    ```js
    {
      id: number,
      name: string,               // filament.name (Fallback `#${id}`)
      vendor: string | null,      // filament.vendor?.name
      material: string | null,    // filament.material (z. B. 'ABS', 'PLA', 'ASA')
      color: string | null,       // '#rrggbb' aus filament.color_hex (Fallback erster Eintrag aus multi_color_hexes)
      remainingWeight: number | null, // Gramm (1 Nachkommastelle)
      initialWeight: number | null,
      lotNr: string | null,
      archived: boolean,
    }
    ```
  - `reset()` wird beim Druckerwechsel in `applyRuntimeSettingsChange()` aufgerufen, sodass keine Spulendaten zwischen Druckern leaken.
- **Status-Integration (`server/printer.mjs`):**
  - `status.spoolman` wird in `/api/status` & `/api/events` bereitgestellt: `{ available, connected, spoolId, activeSpool }`.
  - Bei **Single-Tool-Druckern (`toolCount === 1`)**: ist `activeSpool` vorhanden, setzt `normalized()` `tools[0].material = { type: spool.material ?? 'Filament', name: ..., color: spool.color, source: 'Spoolman', spoolId: spool.id, remainingWeight: spool.remainingWeight }` (höchste Priorität vor 1-Slot-Slicer-Metadaten).
  - Bei **Multi-Tool-Druckern (`toolCount > 1`, inkl. STORMTROOPER 6-TC)**: die bestehende 6-Slot-OrcaSlicer-Zuordnung bleibt unverändert; `status.spoolman` steht dennoch als Metadatum bereit.

#### HTTP-Endpunkte (`server/printer.mjs`)
- **`GET /api/spoolman/spools`:**
  - Ruft über Moonraker `POST /server/spoolman/proxy` mit `{ request_method: 'GET', path: '/v1/spool', query: 'allow_archived=false' }` alle aktiven (nicht archivierten) Spulen ab und normalisiert sie.
  - Antwort `200`: `{ available: true, connected: true, activeSpoolId, spools: [...] }` (aktive Spule zuerst, danach alphabetisch nach Hersteller/Material/Name sortiert).
  - Ist Spoolman nicht verfügbar/verbunden: `503` / `404` mit klarer deutscher Meldung.
- **`POST /api/spoolman/active`:**
  - **`sameOriginRequest`-Guard (`403`)** wie `/api/control` & `/api/settings`!
  - Body: `{ spoolId: number | null }` (validiert positive Ganzzahl oder `null` zum Leeren).
  - Sendet `POST <printer>/server/spoolman/spool_id` mit `{ spool_id: spoolId }` (Timeout 5 s).
  - Ruft `spoolmanReader.invalidate()` + `live?.notify()` auf, sodass Extruder-Karte und 3D-Filamentfarbe sofort reagieren.
  - Antwort `200`: `{ ok: true, spoolId, activeSpool }`.

#### UI (`src/components/SpoolmanPicker.vue` in `SingleToolOverview.vue`)
- **Nur sichtbar**, wenn `status?.spoolman?.available && status?.spoolman?.connected` (bei Druckern ohne Spoolman komplett ausgeblendet).
- **Kompaktes Spulen-Badge in der Extruder-Karte** (neben Filament-Status / PA):
  - Farbpunkt (`activeSpool.color ?? '#879499'`), Material + Name (z. B. `ABS · Voron Red`) + Restgewicht (`742 g`) — oder *„Keine Spule“*, wenn `spoolId == null`.
- **Spulen-Auswahl-Popover (`SpoolmanPicker.vue`):**
  - Öffnet sich beim Klick auf das Spulen-Badge, lädt beim Öffnen frisch `GET /api/spoolman/spools`.
  - Suchfeld (filtert nach Name, Hersteller, Material, Spulen-ID `#12`), kompakte Liste mit Farbpunkt, Material, Hersteller/Name, Restgewicht (`g`) und aktivem Haken.
  - Button **„Spule entfernen“** (`spoolId: null`), wenn aktuell eine Spule aktiv ist.
  - Barrierefrei (`Escape` schließt, Fokus-Management, 44 px Zeilenhöhe im 7"-Display-Modus); bei fehlendem Schreibrecht (`!canWrite`) oder offline wird die Auswahl als schreibgeschützt angezeigt.

---

## 5. Sicherheit, Tests & Abnahme

### Sicherheit
- Alle Schreib-Endpunkte (`POST`/`DELETE /api/models/:printerId/:slot` sowie `POST /api/spoolman/active`) durch `sameOriginRequest` geschützt.
- Strikte Whitelists für `printerId` und `slot`, kein Path Traversal möglich.
- Streaming-Body-Limit (25 MB) + strenge GLB-v2-Header-/JSON-Validierung verhindern OOM und das Ablegen fremder Dateitypen (HTML/SVG/JS).
- `X-Content-Type-Options: nosniff` + festes `Content-Type: model/gltf-binary` bei Auslieferung.

### Verifikation & Tests
- **Unit- & API-Tests (`npm test`):**
  - `server/models.mjs`: GLB-v2-Validierung (gültig, ungültige Magic-Bytes, falsche Version, abgeschnittene Länge, kaputtes JSON, > 25 MB), atomares Speichern/Lesen/Löschen, Path-Traversal-Schutz, ETag/`304`, Profil-Lösch-Cleanup.
  - `server/settings.mjs`: erweiterte `MODEL_PRESETS`, `accentColor`-Validierung & Migration alter Settings-Dateien, unveränderte `customModels`-Integrität nach `POST /api/settings`.
  - `server/materials.mjs`: 1-Slot-Slicer-Metadaten für Single-Tool-Drucker während laufender Drucke bei unverändertem 6-Slot-Verhalten für 6-Toolchanger.
  - `server/spoolman.mjs`: Spulen-Normalisierung (`color_hex` mit/ohne `#`, `multi_color_hexes`-Fallback, Restgewicht), `404`-Backoff für Drucker ohne Spoolman, Priorität Spoolman > 1-Slot-Slicer auf Single-Tool, Reset bei Druckerwechsel, HTTP-Tests für `GET /api/spoolman/spools` und `POST /api/spoolman/active` (Origin-Check `403`, Validierung `400`, Setzen & Leeren `200`).
  - `src/model-config.mjs`: vollständige Auflösungsmatrix (`auto` mit V0.1/Crucible/V2.4/Trident/STORMTROOPER/2-TC/offline, explizite Templates + Custom-Drucker, `custom` leer/1-Slot/2-Slots, `none`).
  - `src/scene-utils.mjs`: Node-Tag-Erkennung (`VORON_ACCENT`, `LED_*`, `NOZZLE_TIP`, `FILAMENT_INLET`) & LED-Interpolation.
  - HTTP-Integrationstests für `GET`/`POST`/`DELETE /api/models/:printerId/:slot` (Origin-Check `403`, ungespeichertes Profil `404`, gültiger Upload `200`, `If-None-Match` `304`, `DELETE` `200`).
  - i18n-Paritätstest (`src/locales/en.json`).
- **Asset-Verifikation:** Beide gebauten Templates (`stealthburner.glb`, `mini-stealthburner.glb`) passieren `validateGlbBuffer`, bleiben unter 800 KB bzw. 600 KB und enthalten die erwarteten `VORON_ACCENT`-/`LED_*`-/`NOZZLE_TIP`-/`FILAMENT_INLET`-Nodes.
- **Live-Browser-QC (Headless Chromium / Playwright):** Visuelle Prüfung + Konsolen-/HTTP-Fehlerfreiheit auf Desktop (`1440×900`), 7"-Display (`1024×600`) und Mobile (`390×844`) über STORMTROOPER (6-TC), VORON 2.4 (StealthBurner + Custom-Drucker-`.glb` Umschalter + Akzentfarbe + Spoolman-Spulenwechsel), VORON V0.1 (Mini-StealthBurner + Live-LEDs + Düsen-Glow + ohne Spoolman) und Crucible (`custom` leer → Upload → gerendert).

---

## 6. Entscheidungen, die dem Umsetzer überlassen bleiben

- Feintuning der Kamera-Framing-Faktoren, Lichtintensitäten und Boden-Schleier-Proportionen in `PrinterScene.vue`.
- Exakte VoronDesign-STL-Teileauswahl und Decimation-Parameter in `scripts/build-voron-templates.py`, solange die charakteristische StealthBurner-/Mini-StealthBurner-Silhouette, die LED-Diffusor-Positionen und das Größenbudget (< 800 KB / < 600 KB) eingehalten werden.
- Interne Hilfsfunktions-Struktur innerhalb von `server/models.mjs`, `src/scene-utils.mjs` und `scripts/fusion-export-dockyard.py`.
