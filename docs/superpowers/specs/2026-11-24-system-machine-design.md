# Ausbaustufe 1 — System als Machine-Werkzeugkasten (Design-Spezifikation)

**Datum:** 2026-11-24  
**Scope:** STORMTROOPER Toolchanger Cockpit (`System`-Reiter + gemeinsame CSS-Tokens)  
**Roadmap-Kontext:** Ausbaustufe 1 von 3 (danach folgen Ausbaustufe 2: Druck-Bedienbarkeit und Ausbaustufe 3: Drucker-Display-/Kiosk-Modus).

---

## 1. Absicht & Warum

Der Reiter **`Werkzeuge`** ist und bleibt die tägliche Hauptansicht für Werkzeugwechsel, Temperaturen, Filament, Purging/Cleaning und Kameras. Für Konfigurationsänderungen (`printer.cfg`, `macros.cfg`, `moonraker.conf`, `crowsnest.conf`), Dienst-Neustarts, Host-Telemetrie, Update-Prüfungen und Log-Analyse muss derzeit noch auf Mainsail ausgewichen werden.

Ziel dieser Ausbaustufe ist es, den bestehenden Reiter **`System`** zu einem vollwertigen, ruhigen **Machine-Werkzeugkasten** auszubauen — ohne `Werkzeuge` oder die Hauptnavigation zu überladen und unter Wahrung der strengen Sicherheits- und Designprinzipien des STORMTROOPER-Cockpits.

---

## 2. Ziele, Nicht-Ziele & Anti-Ziele

### Ziele
- **Vollständige System-Übersicht:** Host-Kennzahlen (CPU-Auslastung, RAM-Nutzung, CPU-Temperatur, Uptime, Throttling-Hinweise, System-Info) zusätzlich zum bestehenden Druckerstatus, Temperatursensoren und CAD-Hinweis.
- **Sichere Dienst- & Firmware-Neustarts:** Kontrollierte Neustarts von Klipper, Firmware/MCU, Moonraker, Crowsnest und weiteren verfügbaren Moonraker-Diensten mit inline Zwei-Schritt-Bestätigung und konsequenter Sperre während aktivem oder pausiertem Druck.
- **Inline-Konfigurationseditor:** Durchsuchbarer Dateibaum für `root=config` mit vollflächigem Code-Editor (Zeilennummern, Klipper-Syntax-Hervorhebung, Suche im Editor, Dirty-Indikator, Schutz vor ungespeichertem Verlust, `Speichern` und kontextabhängigem `Speichern & Neustart`).
- **Toolchanger-Kalibrierung (`Kalibrierung`):** Kompakte Übersicht aller realen Kalibrierdaten dieses 6-Toolchangers (Werkzeug-Offsets X/Y/Z, Nudge-Ring-Schlussfehler & 6×6-Paarmatrix für XY/Z, Düsen-Ausdehnungskoeffizienten, QGL/Bed-Mesh inkl. 2D-Heatmap, Beacon-Status, aktive Input-Shaper-Werte & klickbare ShakeTune-Diagramme) plus sicherheitsgeprüftes Auslösen der vorhandenen Klipper-Kalibriermakros.
- **Update-Transparenz inkl. Patch-Schutz:** Übersicht aller von Moonraker verwalteten Komponenten mit klarer **Amber-Warnung (`Lokal geändert`)** für Repositories mit lokalen Änderungen (`is_dirty: true`, z. B. `klipper-toolchanger-extended`), plus manuelle Aktualisierungsprüfung.
- **Schnelle Log-Analyse ohne Browser-Freeze:** Tail-Ansicht (letzte ~400 Zeilen via HTTP `Range`) für Moonraker-Logs (`klippy.log`, `moonraker.log`, `crowsnest.log` usw., auch bei Dateien > 100 MB) mit direktem Streaming-Download der vollständigen Datei.
- **Visuelle Konsolidierung (Impeccable):** Semantische Oberflächen-, Linien-, Status- und Monospace-CSS-Tokens in `src/style.css` sowie ruhige Skeleton-Ladezustände.

### Nicht-Ziele (Phase 1)
- Keine Änderungen an **`Werkzeuge`**, **`Bedienung`**, **`Druck`** oder **`Verlauf`**.
- Keine Power-Device-Steuerung (Moonraker `/machine/device_power/devices` ist auf der Maschine nicht konfiguriert und liefert `404`).
- Keine Host-Shutdown-/-Reboot-Befehle (`POST /machine/shutdown` / `/machine/reboot`).
- Keine Datei-Verwaltungsoperationen wie Datei erstellen, umbenennen, löschen, Ordner anlegen oder ZIP-/Binär-Upload im Konfigurationsbrowser.
- Keine 1-Klick-Git-/System-Upgrades (`POST /machine/update/upgrade`) — siehe Abschnitt 6 (Builder-Entscheidungen).
- Keine Live-WebSocket-Log-Verfolgung (`tail -f`); manuelles Nachladen genügt in Phase 1.

### Anti-Ziele (Woran die Umsetzung scheitern würde)
- **Kein Überladen von `Werkzeuge` oder der Hauptnavigation:** Die Top-Navigation bleibt unverändert (keine neuen Hauptreiter).
- **Kein versehentliches Überschreiben während des Drucks:** Konfigurations-Speichern und Dienst-Neustarts dürfen während `printing`, `paused` oder einem laufenden Control-Job weder im Frontend noch im Backend möglich sein.
- **Kein stilles Überschreiben lokaler Patches:** Repositories mit `is_dirty: true` dürfen niemals als harmlos „aktuell“ erscheinen.
- **Kein Memory-/Browser-Crash durch riesige Logs:** Logdateien können auf der Maschine > 170 MB groß sein (verifiziert: `klippy.log.*` bis 174 MB, `mainsail-access.log` 133 MB). Weder Backend noch Browser dürfen vollständige Logs in den RAM puffern.
- **Kein Stilbruch:** Keine modalen Editor-Popups, keine `window.confirm()`-Dialoge, keine CSS-`box-shadow`-Karten, keine ungetrackten privaten IPs/Seriennummern im Repository.

---

## 3. Betrachtete Ansätze & Entscheidung

Vor Erstellung dieser Spezifikation wurden drei architektonische Ansätze für die Unterbringung der Machine-Funktionen verglichen:

1. **Ansatz 1 — Sub-Navigation im Reiter `System` (`Übersicht` | `Konfiguration` | `Kalibrierung` | `Wartung`) — GEWÄHLT**
   - *Vorteile:* Hauptnavigation bleibt unverändert ruhig; der Konfigurationseditor erhält volle Breite (`1680px`-Shell) statt eines engen Modals; Übersicht, Konfiguration, Kalibrierung und Wartung trennen tägliche Statuskontrolle klar von Eingriffen.
   - *Nachteile:* Ein Klick mehr innerhalb von `System`, um zwischen den Unterbereichen zu wechseln (abgemildert durch permanente Sub-Navigation und Hash-Routing `#system/...`).
2. **Ansatz 2 — Alles auf einer langen scrollbaren `System`-Seite**
   - *Abgelehnt:* Würde Status, Sensoren, Dateibaum, Code-Editor, 16 Update-Einträge und Logs vertikal vermischen; schlechte Übersicht und unruhiger Scroll-Fluss.
3. **Ansatz 3 — Neue Hauptreiter in der Top-Navigation (`Config`, `Machine`)**
   - *Abgelehnt:* Bläht die Hauptnavigation von 7 auf 8–9 Reiter auf und widerspricht dem Fokus auf `Werkzeuge`.

---

## 4. Verifizierte Rahmenbedingungen & Einschränkungen

### Moonraker-API-Realität (read-only gegen Zielsystem geprüft)
- `GET /machine/proc_stats`: liefert `cpu_temp`, `throttled_state.flags`, `system_cpu_usage` (`cpu`, `cpu0..3`), `system_memory` (`total`, `available`, `used` in kB), `system_uptime` (Sekunden) und `moonraker_stats`.
- `GET /machine/system_info`: liefert `cpu_info` (`model`, `cpu_count`, `total_memory`, `bits`), `distribution` (`name`, `release_info`, `kernel_version`), `available_services` und `service_state` (`active_state`, `sub_state`). Seriennummern (`cpu_info.serial_number`) und Netzwerk-MACs werden **nicht** ins Frontend durchgereicht.
- `GET /server/files/list?root=config`: enthält ~330 Dateien inkl. `.theme/` (44 Dateien), Binärdateien (`.png`, `.svg`, `.zip`, `.bin`, `.stdata`), Backups (`.bak*`, `.bkp`, `*-old`, `backup/`, `backups/`) sowie schreibgeschützte Dateien (`permissions: "r"`, z. B. `mainsail.cfg`, `timelapse.cfg`).
- `GET /server/files/config/<path>`: liefert den Dateiinhalt als `text/plain`.
- `POST /server/files/upload`: akzeptiert `multipart/form-data` mit `root=config`, optional `path=<unterordner>` und `file=<Blob mit Dateinamen>`.
- `POST /printer/restart` und `POST /printer/firmware_restart`: Klipper-Soft-Neustart bzw. vollständiger Firmware-/MCU-Neustart (funktionieren auch im `shutdown`/`error`-Zustand von Klipper).
- `POST /machine/services/restart`: startet einen erlaubten systemd-Dienst über Moonraker neu (`service=<name>`).
- `GET /machine/update/status` & `POST /machine/update/refresh`: liefert `version_info` für 16 Komponenten (Typen: `git_repo`, `web`, `system`), inkl. `is_dirty`, `is_valid`, `corrupt`, `version`, `remote_version`, `package_count`, `warnings`, `anomalies` sowie `busy`.
- `GET /server/files/list?root=logs` & `GET /server/files/logs/<path>`: unterstützt `Accept-Ranges: bytes` und `Range: bytes=-<N>` (`206 Partial Content` mit `Content-Range`). Enthält sowohl 0-Byte-Dateien (`mainsail-error.log`, bei denen `Range` `416` liefert) als auch Dateien > 170 MB.

### Sicherheit & Schutzregeln
- **Origin- & Header-Schutz:** Alle schreibenden `POST /api/system/*`-Endpunkte nutzen `Content-Type: application/json`, `X-Cockpit-Request: 1` und den bestehenden `sameOriginRequest(req)`-Guard aus `server/control.mjs`.
- **Druckschutz & Klipper-Wiederherstellung (Backend + Frontend, zweistufig):**
  - Konfigurations-Speichern (`POST /api/system/config/save`) und Neustarts (`POST /api/system/service/restart`) prüfen live gegen Moonraker:
    1. Zunächst `GET /printer/objects/query?print_stats&webhooks&idle_timeout`.
    2. Falls Klippy nicht verbunden ist (HTTP `503`) oder bei einem Config-Parse-Fehler `print_stats` fehlt, folgt ein Fallback auf `GET /server/info`: Wenn Moonraker erreichbar ist und `klippy_connected === false` oder `klippy_state` in `['error', 'shutdown', 'startup']` meldet, läuft garantiert kein Druck — **sowohl `config/save` als auch `service/restart` bleiben erlaubt**, damit ein Tippfehler in `printer.cfg` direkt im Cockpit behoben und neu gestartet werden kann. Ist Moonraker selbst nicht erreichbar, schlägt der Guard weiterhin fail-closed fehl (`502`/`503`).
  - Blockiert (`409 Conflict`), wenn `print_stats.state` in `['printing', 'paused']` liegt, `idle_timeout.state === 'Printing'` ist oder ein aktiver (nicht-`uncertain`) Control-Job läuft.
  - **Kein Deadlock bei `job.uncertain === true` + Klipper `shutdown`/`error`:** Wenn ein früherer Control-Job in `uncertain` endete und Klipper zugleich in `shutdown`/`error`/disconnected steht, bleiben `klipper_restart`, `firmware_restart`, der `klipper`-Dienst-Neustart sowie `config/save` zulässig. Der Zustand `job.uncertain` bleibt dabei bewusst erhalten, sodass nach dem Wiederanlauf auf `ready` weiterhin die normale Sichtprüfungs-Freigabe (`acknowledge`) erforderlich ist, bevor wieder Fahr-/Werkzeugbefehle gesendet werden.
  - **Eigenständiger Moonraker-Online-Status in `System`:** `SystemView` leitet die Verfügbarkeit von Konfiguration, Logs, Updates und Neustarts aus der Erreichbarkeit von Moonraker ab (nicht aus dem Klippy-Objektstatus `online` in `App.vue`). Außerdem wird `server/printer.mjs` beim Fehlen von `configfile` im Klipper-Fehlerfall null-sicher gehärtet.
- **Pfad-Validierung & Read/Write-Trennung (`server/machine.mjs`):**
  - Alle Konfigurationspfade: relative POSIX-Pfade ohne führenden `/`, ohne `..`, ohne Nullbytes/Steuerzeichen, ohne `.theme/`-Präfix, Größenlimit **512 KB**, Binärinhalte (Nullbytes) werden abgelehnt.
  - **Lesbare Dateien (`GET /api/system/config/file`):** `.cfg`, `.conf`, `.md`, `.txt`, `.json`, `.sh`, `.py` sowie lesbare Text-Backups (`.bak*`, `.bkp`, `.backup*`, `*-old`, `.full-*`, `.ring-*` innerhalb von `root=config`).
  - **Schreibbare Dateien (`POST /api/system/config/save`):** strikt begrenzt auf aktive Konfigurations-/Textdateien (`.cfg`, `.conf`, `.md`, `.txt`, `.json`) mit Moonraker-`permissions === 'rw'` und `isBackup === false`.
  - **Erzwungener Schreibschutz (`readonly: true`, HTTP `403` beim Speichern):**
    - Dateien mit Moonraker-`permissions !== 'rw'` (z. B. `mainsail.cfg`, `timelapse.cfg`)
    - Backup-Dateien (`isBackup === true`: `.bak*`, `.bkp`, `.backup*`, `*-old`, `.full-*`, `.ring-*`, `backup/`, `backups/`, `ShakeTune_results/`)
    - Ausführbare Skripte (`.sh`, `.py`) — im Editor einsehbar, aber über HTTP nicht überschreibbar, da das lokale Cockpit keine Benutzer-Authentifizierung besitzt.
  - **Schutz vor externen Änderungen (`SAVE_CONFIG`-Konfliktschutz):** `POST /api/system/config/save` prüft optional `expectedModified` gegen den aktuellen `modified`-Zeitstempel aus Moonraker `/server/files/list?root=config`. Wurde die Datei zwischenzeitlich extern verändert (z. B. durch Klippers `SAVE_CONFIG` für Beacon-/Z-Offset-Kalibrierung), antwortet das Backend mit `409 Conflict` (`{ code: 'FILE_CHANGED', currentModified }`), solange nicht explizit `force: true` gesendet wird.
  - Logpfade: relative Pfade aus `/server/files/list?root=logs` ohne `..`, ohne Steuerzeichen, keine Verzeichniswechsel.
- **Dienst-Whitelist:** Neustarts sind nur für eine explizite Allowlist zulässig (`klipper_restart`, `firmware_restart`, sowie systemd-Dienste `klipper`, `moonraker`, `crowsnest`, `sonar`, `mobileraker`, `helixscreen`, `klipper-mcu`, zusätzlich abgeglichen gegen `available_services` aus `/machine/system_info`).
- **i18n:** Alle neuen deutschen UI-Texte erhalten eine englische Übersetzung in `src/locales/en.json` (durch `tests/i18n.test.mjs` abgesichert).
- **Keine privaten Daten im Repo:** Keine IP-Adressen, Hostnamen, Seriennummern oder lokalen Benutzerpfade in Code, Tests oder Doku.

---

## 5. Vom Nutzer bestätigtes Design (Ansatz 1 + Impeccable 1–4)

### 5.1 Designsystem-Konsolidierung (`src/style.css`) — Impeccable #1
- Neue semantische CSS-Variablen in `:root`:
  - Oberflächen: `--surface-deep` (`#12191d`), `--surface-subtle` (`#151d21`), `--surface-hover` (`#212c32`)
  - Grenzen: `--line-subtle` (`#263137`), `--line-strong` (`#4c5d64`)
  - Semantische Status-Tints: `--amber-tint` (`#2d2a20`), `--amber-line` (`#766543`), `--danger` (`#ffd5d1`), `--danger-tint` (`#412526`), `--danger-line` (`#b56563`), `--lime-line` (`#627c43`)
  - Monospace-Token: `--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` — einheitlich genutzt in Konsole, Konfigurations-Editor und Log-Viewer (statt verstreuter `SFMono-Regular`-Literale).
- Neue `System`-Komponenten verwenden ausschließlich diese Tokens; bestehende lose Hex-Werte in `src/style.css` werden schrittweise auf die Tokens vereinheitlicht, ohne bestehende Ansichten visuell zu verändern.
- Weiterhin **keine `box-shadow`**, flache Tonwert-Trennung mit 1 px Rahmen, `tabular-nums` für alle Messwerte/Dateigrößen/Zeilennummern.

### 5.2 Struktur des `System`-Reiters (`src/components/SystemView.vue`)
Am Kopf von `System` sitzt eine ruhige Sub-Navigation (im Stil der bestehenden `.segmented`-Gruppe oder Unter-Tab-Leiste) mit vier Ansichten:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [ Übersicht ]  [ Konfiguration ]  [ Kalibrierung ]  [ Wartung ]         │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Hash-Synchronisierung (Builder-Entscheidung):** `#system` (Standard = `Übersicht`), `#system/config`, `#system/calibration`, `#system/maintenance`.
- **Persistenter Editor-Entwurf über Tab-Wechsel hinweg (Builder-Entscheidung):** Der geöffnete Datei-Buffer und Dirty-Status liegen in einem leichten Store (`src/useConfigEditor.js`, analog zu `src/useConsole.js`). Dadurch bleiben ungespeicherte Änderungen erhalten, wenn man zwischendurch in `Konsole`, `Werkzeuge` oder `System → Übersicht` wechselt, um einen Sensor/Pin/Befehl nachzuschauen. Ein dezenter Amber-Punkt am Reiter `System` bzw. `Konfiguration` erinnert an ungespeicherte Änderungen. Beim Schließen/Neuladen des Browser-Tabs warnt `beforeunload`.

#### Unteransicht 1: `Übersicht`
1. **Host-Metrik-Leiste (horizontal, analog zur Totals-Leiste in `Verlauf`):**
   - 4 Zellen in einer Zeile (mobil 2×2): **CPU-Auslastung** (`%`, Tooltip/Subtext mit Kernzahl), **Arbeitsspeicher** (`genutzt / gesamt GB` + `%`), **Host-Temperatur** (`°C`), **Laufzeit** (`Tage / Std. / Min.`).
   - Falls `throttled_state.flags` nicht leer ist: ruhiges Amber-Hinweisbanner direkt unter der Leiste mit den konkreten Flags (z. B. Unterspannung/Temperaturdrosselung).
   - Host-Meta-Unterzeile: Board-/OS-Info (`Raspberry Pi 4 … · MainsailOS … · Kernel …`, sofern von `/machine/system_info` geliefert).
   - Während des initialen Ladens: **ruhige Skeleton-Platzhalter** (Impeccable #4).
2. **Zweispaltiger Kernbereich (wie bisher, ergänzt um Dienste):**
   - Links: **Druckerstatus** (Klipper, Druckstatus, Datei/Fortschritt/Druckzeit, Toolchanger, aktives/erkanntes Werkzeug, referenzierte Achsen, Klipper-Statusmeldung).
   - Rechts: **Temperaturen** (Druckbett, Bauraum, Raspberry Pi, Octopus, RP2350, Beacon-Spule + Live-Transport-Hinweis).
3. **Panel „Neustart & Dienste“ (volle Breite):**
   - Primäre Firmware-/Klipper-Aktionen: **Klipper neu starten** (`POST /printer/restart`) und **Firmware-Neustart** (`POST /printer/firmware_restart`).
   - Dienst-Liste aus `available_services` (gefiltert durch Whitelist): zeigt pro Dienst Name, Live-Status (`Aktiv` in Lime / `Inaktiv` in Muted/Amber) und einen kompakten **Neu starten**-Button.
   - **Zwei-Schritt-Bestätigung inline:** Erster Klick wechselt den Button in den Zustand `Wirklich neu starten?` + `Abbrechen` (automatischer Rückfall nach 6 s). Kein Browser-`confirm()`.
   - **Druckschutz-Hinweis:** Bei aktivem/pausiertem Druck oder laufendem Control-Job sind alle Neustart-Buttons deaktiviert mit klarem Hinweisbanner („Neustarts sind während eines aktiven oder pausierten Drucks gesperrt.“).
   - Nach Auslösen eines Klipper-/Moonraker-Neustarts erscheint ein ruhiges Statusfeedback („Neustart gesendet — Verbindung wird automatisch neu aufgebaut …“).
4. **CAD-Hinweis** am Seitenende (beibehalten wie bisher).

#### Unteransicht 2: `Konfiguration` — Impeccable #2 (Inline Full-Width)
Volle Breite innerhalb der `1680px`-Shell, zweispaltiges Split-Layout (`280px–310px` Dateibaum links, flexibler Code-Editor rechts; auf Mobilgeräten vertikal gestapelt mit einklappbarer Dateiliste):

```
┌───────────────────────────┬──────────────────────────────────────────────┐
│ [ Suche nach Datei ... ]  │ printer.cfg · 33,4 KB  [ Ungespeichert ]     │
│ [ ] Backups anzeigen      │              [ Verwerfen ] [ Speichern ]     │
│                           │              [ Speichern & Klipper-Neustart ]│
│ ▾ (Hauptverzeichnis)      ├──────────────────────────────────────────────┤
│   bedfans.cfg             │   1 │ [include mainsail.cfg]                 │
│   crowsnest.conf          │   2 │ [include macros.cfg]                   │
│   macros.cfg              │   3 │ # ...                                  │
│   mainsail.cfg  [RO]      │   4 │ [extruder]                             │
│ > printer.cfg             │   5 │ step_pin: ...                          │
│ ▸ atom (12)               │     │                                        │
│ ▸ helixscreen (4)         │     │  (CodeMirror 6, Klipper-Highlighting,  │
│ ▸ Margt NEW (18)          │     │   Cmd/Ctrl+F Suche, Cmd/Ctrl+S)        │
└───────────────────────────┴──────────────────────────────────────────────┘
```

- **Dateibaum (links):**
  - Versteckt standardmäßig `.theme/` und Binärdateien dauerhaft.
  - Filter-Suchfeld (filtert über Pfad & Dateinamen in Echtzeit).
  - Toggle **`Backups anzeigen`** (Standard: aus) blendet `.bak*`, `.bkp`, `.backup*`, `*-old`, `.full-*`, `.ring-*`, `backup/`, `backups/` und `ShakeTune_results/` bei Bedarf ein.
  - Gruppiert nach Ordnern (Root zuerst, dann alphabetisch sortierte Unterordner; auf-/zuklappbar, bei aktiver Suche automatisch aufgeklappt).
  - Markiert schreibgeschützte Dateien (`readonly === true`: `permissions !== 'rw'`, Backups oder `.sh`/`.py`-Skripte) mit einem dezenten `RO`-Tag.
- **Inline Code-Editor (rechts):**
  - Kopfzeile mit aktuellem Pfad, Dateigröße, Änderungsdatum und Status-Pill:
    - `Ungespeichert` (Amber) bei abweichendem Buffer
    - `Schreibgeschützt` (Muted/Amber) bei `readonly === true` (Moonraker `permissions !== 'rw'`, Backup oder `.sh`/`.py`-Skript) oder während aktivem/pausiertem Druck
  - Aktionen in der Kopfzeile:
    - `Verwerfen` (setzt auf zuletzt geladenen Inhalt zurück, nur aktiv wenn dirty)
    - `Speichern` (disabled wenn unverändert, schreibgeschützt, Moonraker nicht erreichbar, Druck aktiv/pausiert oder Speichervorgang läuft; auch per `Cmd/Ctrl+S`; bleibt **aktiv**, wenn Klippy wegen eines Config-Fehlers im `error`/`shutdown`-Zustand ist, solange Moonraker erreichbar ist!)
    - Kontext-abhängiges `Speichern & Neustart` (nur für beschreibbare `.cfg`- und `.conf`-Dateien):
      - für `moonraker.conf` → `Speichern & Moonraker-Neustart`
      - für `crowsnest.conf` → `Speichern & Crowsnest-Neustart`
      - für alle anderen `.cfg`/`.conf`-Dateien → `Speichern & Klipper-Neustart`
  - **Konflikt-Banner bei externer Änderung (`409 FILE_CHANGED`):** Wurde die Datei seit dem Laden extern geändert (z. B. durch `SAVE_CONFIG`), erscheint im Editor-Kopf ein ruhiges Amber-Banner („Datei wurde inzwischen auf dem Drucker geändert, z. B. durch SAVE_CONFIG.“) mit **`Neu laden (Änderungen verwerfen)`** und **`Trotzdem überschreiben`**.
  - **Schutz beim Dateiwahl-Wechsel:** Beim Anklicken einer anderen Datei im Dateibaum mit ungespeicherten Änderungen erscheint eine ruhige inline Amber-Leiste im Editor-Kopf („Ungespeicherte Änderungen in `<datei>` — trotzdem wechseln?“ mit `Verwerfen & wechseln` / `Bleiben`).
  - Browser-`beforeunload`-Schutz, solange ungespeicherte Änderungen bestehen.
  - Während des Dateiladens: ruhiges Skeleton im Editor-Container.

#### Unteransicht 3: `Kalibrierung`
Spezialisierte Kalibrierungsansicht für den 6-Toolchanger (alle Daten live aus Klipper `save_variables`, `bed_mesh`, `quad_gantry_level`, `beacon`, `tools_calibrate`, `configfile.settings.input_shaper`, `_BEACON_BATCH_STATE` sowie `ShakeTune_results/`):

1. **Werkzeug-Offsets (`T0`–`T5`) — Nudge XY, Beacon Z & Thermik:**
   - Kompakte 6-Zeilen-Tabelle (`tabular-nums`) für `T0`–`T5`: X-Offset, Y-Offset, Z-Offset, ΔZ relativ zum Initial-Tool, Z-Feinanpassung (`tool_z_adjust_t*`), Düsen-Ausdehnungskoeffizient (`nozzle_expansion_coefficient_t*` in µm/°C) und Pressure Advance.
   - **Nudge-Ring-Schlussfehler** (`nudge_ring_closure`: X / Y in mm) prominent im Kopfbereich als Qualitätsindikator; darunter eine aufklappbare **6×6-Paar-Matrix** mit Umschalter **Nudge XY** / **Beacon Z** (wählbares Referenz-Tool `T0`–`T5`).
   - **Live-Batch-Hinweis:** Falls `_BEACON_BATCH_STATE.running === 1` ist, erscheint ein ruhiges Statusbanner mit Fortschritt (`X / 30 Messungen`) und einem **`Batch-Kalibrierung abbrechen`**-Button (`BEACON_BATCH_ABORT`).
   - **Sicherheitsgeprüfte Kalibrier-Aktionen** (alle capability-geprüft gegen vorhandene Makros, nur bei Klipper `ready`, kein laufender/pausierter Druck, kein aktiver Job, inline Zwei-Schritt-Bestätigung, mit Hinweis falls `SAVE_CONFIG` + Klipper-Neustart am Ende erfolgt oder `XYZ`-Homing erforderlich ist):
     - *XY (Nudge):* `Nudge Ring XY` (`NUDGE_CALIBRATE_RING_XY`, 12 Messungen, endet mit `SAVE_CONFIG`), `Nudge Voll XY` (`NUDGE_CALIBRATE_ALL_TOOLS_XY`, 30 Messungen, endet mit `SAVE_CONFIG`), `Nudge-Offsets wiederherstellen` (`NUDGE_RESTORE_OFFSETS`).
     - *Z & Thermik (Beacon):* `Beacon Z (Referenz T0–T5)` (`BEACON_CALIBRATE_Z INITIAL_TOOL=…`, erfordert `XYZ`-Homing), `Beacon Z alle Tools` (`BEACON_CALIBRATE_ALL_TOOLS_Z`, erfordert `XYZ`-Homing), `Düsen-Ausdehnung (T0–T5)` (`BEACON_CALIBRATE_NOZZLE_TEMP_OFFSET INITIAL_TOOL=…`), `Z-Anpassungen zurücksetzen` (`RESET_ALL_TOOL_Z_ADJUSTMENTS`).
   - Direkter Sprunglink **`Ergebnisse in der Konsole ansehen`** nach dem Starten von Messmakros.
2. **Geometrie, Bett-Mesh & Beacon:**
   - **QGL & Bett:** Status von `quad_gantry_level` (`Ausgerichtet` / `Nicht ausgerichtet`) mit **`QGL`** (`QUAD_GANTRY_LEVEL`), **`Fein-QGL`** (`FINE_QUAD_GANTRY_LEVEL`, erfordert `XYZ`-Homing) und **`Bett vermessen`** (`BED_MESH_CALIBRATE`, erfordert `XYZ`-Homing).
   - **Aktives Bed-Mesh:** Profilname, Min / Max / Spannweite (Range in mm) und ruhige 2D-Heatmap (SVG/Canvas im gedeckten STORMTROOPER-Farbverlauf mit Hover-Z-Messwert pro Punkt) — bzw. ruhiger Leerzustand, wenn aktuell kein Mesh geladen ist.
   - **Beacon-Sensor:** Aktives Modell (`beacon.model`), Spulentemperatur (`beacon_coil`), letzte Frequenz; Aktionen **`Gantry-Twist messen`** (`BEACON_MEASURE_GANTRY_TWIST`) und **`Beacon Poke-Test`** (`BEACON_POKE_TEST`).
3. **Input Shaper & ShakeTune:**
   - Aktive Shaper-Parameter für **X** und **Y** (Typ, Frequenz in Hz, Dämpfungsfaktor) sowie **`Shaper kalibrieren (FOC)`** (`SHAPER_CALIBRATE_FOC` für `X`, `Y` oder `X+Y`, erfordert `XYZ`-Homing).
   - **ShakeTune-Diagramme (`ShakeTune_results/`):** Kompakte Galerie der neuesten Diagramme (Filter `Alle` / `Input Shaper` / `Riemen` / `Vibrationen`) mit Lightbox-Großansicht (wie in `Druck` & `Verlauf`, geladen über den strikt auf `ShakeTune_results/**/*.png` begrenzten Bild-Proxy).

#### Unteransicht 4: `Wartung` — Impeccable #3 & #4
Zwei klar getrennte Panels übereinander (oder auf sehr breiten Screens übersichtlich gestapelt, damit die Log-Konsole volle Breite bekommt):

1. **Software & Updates (Moonraker Update Manager):**
   - Kopfzeile mit Zusammenfassung (z. B. `16 Komponenten · 1 Update verfügbar · 1 lokal geändert`) und Button **`Status prüfen`** (`POST /api/system/updates/refresh`, deaktiviert während Druck oder wenn `busy: true`).
   - Kompakte tabellarische Liste aller Komponenten mit:
     - Komponentenname + Typ/Branch (`git_repo`, `web`, `system`)
     - Installierte Version → Remote-Version (tabular-nums)
     - **Status-Badge mit eindeutiger Priorität:**
       1. **`Lokal geändert`** (Amber-Tint + Amber-Text + Warn-Icon) sobald `is_dirty === true` — **höchste Sichtbarkeit**, mit ausklappbarem oder direkt lesbarem Hinweis auf die geänderten Dateien aus `warnings` (z. B. `klipper/extras/toolchanger.py`), damit lokale Patches niemals versehentlich überschrieben werden!
       2. **`Prüfen`** / **`Abweichend`** (Amber) bei `corrupt === true` oder `is_valid === false && !is_dirty` (z. B. `tmc-4671` auf eigenem Remote/Branch), inkl. kurzer Begründung aus `anomalies`/`warnings`.
       3. **`Update verfügbar`** (Lime-Tint / hervorgehobene Versionsdifferenz) wenn `version !== remote_version` (oder `package_count > 0` bei `system`).
       4. **`Aktuell`** (Muted) bei sauberem, aktuellem Stand.
   - Hinweis zu `klipper`/`moonraker` `anomalies` mit `untracked source files`: werden nicht als Fehler-Alarm gewertet, sondern nur dezent als ausklappbare Details angezeigt, solange `is_valid === true && !is_dirty`.

2. **Log-Viewer (Tail + Download):**
   - Auswahlleiste links/oben: Schnellauswahl für die Haupt-Logs (`klippy.log`, `moonraker.log`, `crowsnest.log`, `mobileraker.log`) sowie Dropdown (`CockpitSelect`) für alle übrigen rotierten Logdateien mit Dateigröße und Zeitstempel.
   - Aktionen rechts: **`Aktualisieren`** (lädt Tail neu), **`Nach unten`**, Textfilter innerhalb der geladenen Zeilen (inkl. Filter `Nur Fehler/Warnungen`), und **`Vollständig laden`** (nativer Download-Link auf `/api/system/logs/download?path=...`).
   - Zeigt klar an, wenn nur der Auszug geladen ist: z. B. `Letzte 400 Zeilen (128 KB von 5,39 MB)`.
   - Monospace-Ausgabe (`--font-mono`), Zeilenumbrüche sauber formatiert, Fehler-/Shutdown-/Traceback-Zeilen dezent hervorgehoben (`--danger` / `--amber`), leerer Zustand sauber für 0-Byte-Logs, Skeleton beim Laden.

---

## 6. Explizite Builder-Entscheidungen (zur Bestätigung durch den Nutzer)

Die folgenden Detailentscheidungen wurden auf Basis der Projektarchitektur und einer unabhängigen Review-Prüfung getroffen und können vor dem Plan noch angepasst werden:

1. **CodeMirror 6 (lazy-loaded) statt einfachem `<textarea>`:**
   - Pakete: `@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language`.
   - Wird per dynamischem `import()` (`defineAsyncComponent`) ausschließlich beim Öffnen von `System → Konfiguration` geladen; das initiale Bundle für `Werkzeuge` wächst um **0 KB**.
   - Eigener leichter Klipper/INI-`StreamLanguage`-Tokenizer (Sections `[...]`, Schlüssel, Zahlen/Booleans, `#`/`;`-Kommentare, Jinja2-Blöcke `{% ... %}` / `{{ ... }}` in Makros) + maßgeschneidertes STORMTROOPER-Theme auf Basis der neuen CSS-Tokens.
2. **Updates zunächst nur zur Übersicht + manuellem Status-Refresh (kein 1-Klick-Upgrade):**
   - Schützt lokal gepatchte Repos (`klipper-toolchanger-extended`) und verhindert unbeabsichtigte Dienst-Neustarts während laufender Sitzungen.
   - *Alternative, falls gewünscht:* Gezieltes Auslösen von `POST /machine/update/upgrade` nur für saubere (`!is_dirty && is_valid`) Komponenten — bewusst für Phase 1 weggelassen, sofern nicht ausdrücklich gewünscht.
3. **Konfigurations-Editor bearbeitet bestehende Dateien (kein Anlegen/Löschen/Umbenennen in Phase 1):**
   - Deckt 95 % der realen Nutzung (`printer.cfg`, `macros.cfg`, `moonraker.conf`, `crowsnest.conf`, `atom/*.cfg`) mit minimaler Fehlerfläche ab.
4. **Erzwungener Schreibschutz für Backups sowie `.sh`/`.py`-Skripte:**
   - Backups (`isBackup`) und Skripte (`.sh`, `.py`) lassen sich im Editor sauber ansehen, aber nicht per HTTP überschreiben (Schutz vor versehentlichem Backup-Verlust und vor Code-Ausführung ohne Login-Schicht).
5. **Wiederherstellung bei Klipper-Fehler (`error`/`shutdown`/Klippy getrennt) direkt im Cockpit:**
   - Solange Moonraker erreichbar ist und Klippy nicht druckt (bzw. getrennt/im Fehlerzustand ist), bleiben `Speichern` und `Klipper-/Firmware-Neustart` nutzbar — auch wenn ein vorheriger Control-Job `uncertain` war (`uncertain` bleibt bis zur manuellen Bestätigung nach Wiederanlauf aktiv). So lassen sich Tippfehler in `printer.cfg` ohne Wechsel zu Mainsail/SSH korrigieren.
6. **`SAVE_CONFIG`-Konfliktschutz (Optimistic Concurrency):**
   - Beim Speichern wird der geladene `modified`-Zeitstempel geprüft; wurde die Datei extern (z. B. durch `SAVE_CONFIG`) verändert, warnt ein inline Banner statt die Kalibrierungsdaten still zu überschreiben.
7. **Entwurf bleibt beim Tab-Wechsel erhalten:**
   - Ungespeicherte Änderungen bleiben im Hintergrund erhalten, wenn man kurz in `Konsole` oder `Werkzeuge` nachschaut; ein Amber-Punkt am `System`-Tab zeigt offene Änderungen an. Beim Wechsel auf eine andere Datei im Dateibaum warnt ein inline Banner.
8. **Kontextsensitives `Speichern & Neustart`:**
   - Bei `moonraker.conf` wird Moonraker neu gestartet, bei `crowsnest.conf` Crowsnest, bei allen übrigen `.cfg`/`.conf`-Dateien Klipper (`POST /printer/restart`). Nach erfolglosem Speichern wird **kein** Neustart ausgelöst.
9. **Log-Tail über HTTP `Range: bytes=-131072` (128 KB) begrenzt auf die letzten 400 Zeilen:**
   - Sofortige Ladezeit auch bei 174-MB-Logs; vollständige Datei jederzeit über Streaming-Download abrufbar.
10. **Sub-Tab-URLs als Hash (`#system`, `#system/config`, `#system/calibration`, `#system/maintenance`):**
    - Ermöglicht direktes Neuladen im richtigen Unterbereich; bestehende `#system`-Links funktionieren unverändert.
11. **Kalibrier-Aktionen laufen über den bestehenden WS-Control-Kanal (`/api/control`):**
    - Alle langlaufenden Kalibriermakros (`NUDGE_CALIBRATE_RING_XY`, `BEACON_CALIBRATE_Z`, `FINE_QUAD_GANTRY_LEVEL`, `SHAPER_CALIBRATE_FOC` usw.) nutzen die bewährte asynchrone WebSocket-Job-Ausführung (`executeGcodeScript` mit 45-Minuten-Timeout für Kalibrierungen, Not-Aus-Abbruch, globalem Job-Banner und striktem `commandFor`-Allowlisting + `configfile.settings`-Capability-Prüfung). Bei `SAVE_CONFIG`-Makros (`NUDGE_CALIBRATE_*`) wird ein abschließender Klipper-Neustart sauber behandelt statt fälschlich eine Fehler-Sperre auszulösen.

---

## 7. Backend-API-Vertrag (`server/machine.mjs` + `server/printer.mjs`)

| Methode & Pfad | Typ | Moonraker-Quelle | Hinweise / Schutz |
|---|---|---|---|
| `GET /api/system/overview` | Read | `/machine/proc_stats` + `/machine/system_info` + `/server/info` | Normalisierte Host-Metriken, OS/CPU-Info (ohne Seriennummer), Klippy-Status, gefilterte Dienste + Status |
| `GET /api/system/calibration` | Read | `/printer/objects/query` (`bed_mesh`, `quad_gantry_level`, `beacon`, `tools_calibrate`, `save_variables`, `gcode_macro _BEACON_BATCH_STATE`, `configfile=settings`) + `/server/files/list?root=config` | Normalisierte 6×6-Offsets, Ring-Schlussfehler, Düsen-Ausdehnung, Bed-Mesh-Matrix, Beacon-Status, Input-Shaper-Werte, verfügbare Kalibriermakros & Liste der ShakeTune-PNGs |
| `GET /api/system/calibration/shaketune-image?path=...` | Read | `/server/files/config/ShakeTune_results/<encoded>` | Strikt auf `ShakeTune_results/**/*.png` begrenzt (kein `..`), `Content-Type: image/png`, max. 8 MB |
| `POST /api/control` (erweitert um Kalibrier-Aktionen) | Write | Moonraker WS `printer.gcode.script` | Whitelisted Kalibrier-Actions (`calibrate_nudge_ring`, `calibrate_nudge_all`, `calibrate_nudge_restore`, `calibrate_beacon_z`, `calibrate_beacon_all_z`, `calibrate_beacon_abort`, `calibrate_nozzle_expansion`, `calibrate_reset_z_adjust`, `calibrate_fine_qgl`, `calibrate_gantry_twist`, `calibrate_beacon_poke`, `calibrate_shaper_foc`) mit strikten Parameter-, Homing-, Druckstatus- & Capability-Prüfungen |
| `GET /api/system/config/list` | Read | `/server/files/list?root=config` | Filtert `.theme/` & Binärdateien, markiert `isBackup` & `readonly` (`permissions !== 'rw' \|\| isBackup \|\| scriptExt`) |
| `GET /api/system/config/file?path=...` | Read | `/server/files/config/<encoded>` + Metadaten | Pfad-Validierung, max. 512 KB, lehnt Binärdateien ab, liefert `{ path, content, size, modified, readonly, isBackup }` |
| `POST /api/system/config/save` | Write | `/server/files/upload` (`root=config`) + optional Restart | `sameOriginRequest`, zweistufiger Print-/Klippy-Guard (`409`), erzwingt `readonly === false` (`403`), prüft `expectedModified` (`409 FILE_CHANGED` außer `force: true`), max. 512 KB, optional `restart: 'none' \| 'klipper_restart' \| 'moonraker' \| 'crowsnest'` |
| `POST /api/system/service/restart` | Write | `/printer/restart`, `/printer/firmware_restart` oder `/machine/services/restart` | `sameOriginRequest`, zweistufiger Print-/Klippy-Guard (`409`, kein Deadlock bei `uncertain` + `shutdown`/`error`), explizite Target-Allowlist + `available_services`-Check |
| `GET /api/system/updates` | Read | `/machine/update/status` | Normalisiert alle Komponenten inkl. `status` (`dirty` / `invalid` / `outdated` / `up_to_date`), `warnings`, `anomalies`, `busy` |
| `POST /api/system/updates/refresh` | Write | `/machine/update/refresh` | `sameOriginRequest`, blockiert während aktivem Druck (`409`), liefert aktualisierten Status |
| `GET /api/system/logs/list` | Read | `/server/files/list?root=logs` | Sortiert (Haupt-Logs oben, sonst nach `modified` desc) mit `path`, `size`, `modified` |
| `GET /api/system/logs/tail?path=...` | Read | `/server/files/logs/<encoded>` (`Range: bytes=-131072`) | Behandelt 0-Byte/`416`/`200`/`206` sauber, gibt letzte max. 400 Zeilen + `truncated`, `totalBytes`, `fetchedBytes` zurück |
| `GET /api/system/logs/download?path=...` | Read | `/server/files/logs/<encoded>` (Stream) | Piped direkt ohne Voll-Pufferung im RAM, `Content-Disposition: attachment; filename="..."` |

---

## 8. Was dem Builder überlassen bleibt

- Konkrete Aufteilung der Vue-Unterkomponenten (z. B. `SystemView.vue`, `SystemOverview.vue`, `ConfigEditor.vue`, `SystemMaintenance.vue`) und genaue CSS-Klassennamen.
- Exakte Token-Farbzuordnung für das Klipper-Syntax-Highlighting im STORMTROOPER-Farbschema (gedeckte Kontraste ohne bunte Neon-Optik).
- Polling-Intervall für Host-Metriken in `System → Übersicht` (nur aktiv, solange der Reiter `System` und Unteransicht `Übersicht` sichtbar sind; gestoppt beim Verlassen des Reiters für 0 %-Idle-Effizienz).
- Konkrete Unit-Test-Struktur in `tests/machine.test.mjs` (Pfad-Traversal, Schreibschutz, Print-Guard, Service-Allowlist, `is_dirty`-Klassifizierung, Log-Tail-Handling inkl. 0-Byte & 206, Multipart-Upload-Format).
