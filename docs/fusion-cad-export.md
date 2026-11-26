# Eigene 3D-CADs für DOCKYARD exportieren (Fusion 360 & 3D Print Rig)

DOCKYARD bringt kompakte **StealthBurner**- und **Mini-StealthBurner**-Vorlagen (< 500 KB) direkt mit und lässt sich zusätzlich pro Druckerprofil mit eigenen `.glb`-Dateien kombinieren (z. B. **StealthBurner-Vorlage als Toolhead** + **dein VORON 2.4 / Trident / V0.1 / Crucible als Drucker-Ansicht**).

---

## Weg 1: Eigene Fusion-360-CADs exportieren (macOS)

### 1. Skript einmalig in Fusion 360 einbinden
1. Öffne **Fusion 360 Desktop** auf dem Mac.
2. Wähle **Dienstprogramme → Zusatzmodule → Skripte und Zusatzmodule** (`Shift + S`).
3. Klicke bei **Meine Skripte** auf **`+` → Skript oder Zusatzmodul vom Gerät hinzufügen** und wähle den Ordner `scripts/` dieses Repositories (bzw. `scripts/fusion-export-dockyard.py`).

### 2. Drucker oder Toolhead exportieren
1. Öffne dein gewünschtes Fusion-Dokument (z. B. VORON 2.4 350 mm, VORON Trident 300 mm, VORON V0.1 oder Crucible).
2. Blende Hilfsgeometrien/Skizzen aus, die nicht sichtbar sein sollen.
3. Starte **`fusion-export-dockyard`** über `Shift + S`:
   - **Export-Ziel:**
     - *Gesamter Drucker (`printer`)* exportiert alle sichtbaren Körper des Dokuments.
     - *Toolhead / Aktive Auswahl (`toolhead`)* exportiert nur aktuell ausgewählte Komponenten/Vorkommen (oder sonst alle sichtbaren Körper).
   - **Detailstufe:** *Kompakt — Empfohlen (0.04 cm)* reicht für das Cockpit völlig aus und hält die Dateigröße klein.
   - **Kleinteile ausblenden:** aktiviert lassen (überspringt Schrauben, Muttern, Unterlegscheiben, Gewindeeinsätze und Lager — spart 40–60 % der Dreiecke).
   - **Ausgabeordner:** standardmäßig `~/Desktop/dockyard-exports`.
4. Das Skript richtet das Modell automatisch im glTF-Koordinatensystem aus (**Y-up**, Meter, X/Z zentriert, Boden bei `y = 0`) und schreibt `<dokument>-<slot>.glb`.

### 3. Große Baugruppen komprimieren (empfohlen ab ~5 MB)
```bash
./scripts/optimize-dockyard-glb.sh ~/Desktop/dockyard-exports/voron24-printer.glb --preset printer
```
Typische Fusion-Exporte schrumpfen per **Meshopt + Simplify** um **75–90 %** (z. B. 25 MB → 3 MB) — ideal für Raspberry Pi und 7"-Kiosk-Display.

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
