# Eigene 3D-CADs für DOCKYARD exportieren (Fusion 360 & 3D Print Rig)

DOCKYARD bringt kompakte **StealthBurner**- und **Mini-StealthBurner**-Vorlagen (< 500 KB) direkt mit und lässt sich zusätzlich pro Druckerprofil mit eigenen `.glb`-Dateien kombinieren (z. B. **StealthBurner-Vorlage als Toolhead** + **dein VORON 2.4 / Trident / V0.1 / Crucible als Drucker-Ansicht**).

---

## Weg 1: Eigene Fusion-360-CADs exportieren (macOS Add-In)

### 1. DOCKYARD-Add-In einmalig in Fusion 360 installieren
```bash
./scripts/install-fusion-addin.sh
```
Das Skript installiert das Add-In `fusion-addin/DockyardExport` direkt in `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/DockyardExport`.

- **Falls Fusion bereits offen ist:** `Shift + S` → **Zusatzmodule** → **`DockyardExport`** → **Ausführen**.
- **Beim nächsten Start von Fusion:** Lädt automatisch (`runOnStartup: true`).
- Danach erscheint der grüne Button **„DOCKYARD Export“** direkt in der Fusion-Toolbar unter **Konstruktion → Dienstprogramme → Zusatzmodule**.

### 2. Drucker oder Toolhead exportieren
1. Öffne dein gewünschtes Fusion-Dokument (z. B. VORON 2.4 350 mm, VORON Trident 300 mm, VORON V0.1 oder Crucible).
2. Blende Hilfsgeometrien/Skizzen aus, die nicht sichtbar sein sollen.
3. Klicke in der Toolbar auf **„DOCKYARD Export“**:
   - **Export-Ziel:**
     - *Gesamter Drucker (`printer`)* exportiert alle sichtbaren Körper des Dokuments.
     - *Toolhead / Aktive Auswahl (`toolhead`)* exportiert nur aktuell ausgewählte Komponenten/Vorkommen (rekursiv inkl. Unterbaugruppen).
   - **Hochachse:** erkennt deine Fusion-Einstellung automatisch (*Z-oben* für VORON/STEP oder *Y-oben* für Fusion-Standard).
   - **Detailstufe:** *Kompakt — Empfohlen (0.04 cm)* reicht für das Cockpit völlig aus und hält die Dateigröße klein.
   - **Kleinteile ausblenden:** aktiviert lassen (überspringt Schrauben, Muttern, Unterlegscheiben, Gewindeeinsätze und Lager — spart 40–60 % der Dreiecke).
   - **Nach Export im Finder anzeigen:** öffnet direkt die fertige `.glb`-Datei zum Hineinziehen in DOCKYARD.
   - **Ausgabeordner:** standardmäßig `~/Desktop/dockyard-exports`.
4. Das Add-In richtet das Modell automatisch im glTF-Koordinatensystem aus (**Y-up**, Meter, X/Z zentriert, Boden bei `y = 0`), erkennt transparente Acryl-/Glas-Scheiben und schreibt `<dokument>-<slot>.glb`.

### 3. Direkt in DOCKYARD hochladen (automatische Browser-Kompression!)
Große Fusion-Exporte (bis **150 MB** Rohgröße, z. B. 57 MB Gesamtdrucker) kannst du **direkt per Drag & Drop in den DOCKYARD-Einstellungen hochladen** — DOCKYARD komprimiert sie automatisch im Browser per **Meshopt + Simplify** (z. B. 57 MB → 5 MB, `-91 %`), bevor die Datei an den Raspberry Pi gesendet wird.

Optional für Batch-Läufe im Terminal:
```bash
./scripts/optimize-dockyard-glb.sh ~/Desktop/dockyard-exports/voron24-printer.glb --preset printer
```

### 4. Optionale Live-Tags in Fusion 360
Wenn du in Fusion 360 bestimmten Körpern, Komponenten oder Darstellungen (Appearances) diese Namen gibst, animiert DOCKYARD sie live:
- **`VORON_ACCENT`** — wird live mit der gewählten **VORON-Akzentfarbe** aus den Drucker-Einstellungen eingefärbt.
- **`LED_LOGO`** — folgt Klippers Logo-LED (`tools[0].leds.number`).
- **`LED_NOZZLE_L`** / **`LED_NOZZLE_R`** — folgen den beiden Düsen-LEDs (`left` / `right`).

---

## Weg 2: Fertige Drucker aus `Psych0h3ad/3d-print-rig` importieren (73+ Modelle)

Für Standard-Drucker (z. B. VORON 2.4 250/300/350 Printed & LDO CNC, Trident 250/300/350, V0.2/V0.2r1, SIBOOR, FYSETC, Micron, Switchwire, RatRig, VzBot, Sovol SV08 u. a.) kannst du Modelle direkt lokal aus dem öffentlichen [3D Print Rig](https://github.com/Psych0h3ad/3d-print-rig)-Katalog laden und automatisch für DOCKYARD komprimieren:

```bash
# Katalog durchsuchen
./scripts/import-3d-print-rig.sh --list voron

# Modell herunterladen (SHA-256-geprüft) und automatisch per Meshopt komprimieren
./scripts/import-3d-print-rig.sh voron_v24_350_printed

# Optional direkt in ein laufendes DOCKYARD-Profil hochladen:
./scripts/import-3d-print-rig.sh voron_trident_300 --upload http://127.0.0.1:4173 trident-300
```

---

## Upload in DOCKYARD
1. Öffne **Einstellungen → Drucker & Verbindung** und wähle dein gespeichertes Druckerprofil.
2. Wähle unter **3D-Ansicht / Modell** dein gewünschtes Preset (`Automatisch`, `StealthBurner`, `Mini-StealthBurner` oder `Eigenes CAD`).
3. Ziehe die `.glb`-Datei (max. 25 MB) per Drag & Drop in den Slot **Drucker-CAD** (oder **Toolhead-CAD**).
4. Die Datei wird deploy-sicher in `.dockyard-models/<printerId>/` neben `.dockyard-settings.json` gespeichert und bleibt bei zukünftigen DOCKYARD-Updates (`scripts/deploy-pi.sh`) erhalten.
