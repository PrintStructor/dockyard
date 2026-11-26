import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { translate, savedLanguage, storageKey } from '../src/i18n.mjs'
import en from '../src/locales/en.json' with { type: 'json' }

test('dynamic command feedback, guards and parameters are localized without changing identifiers', () => {
  assert.equal(translate('Alle Tools auf 140 °C: abgeschlossen.', 'en'), 'All tools to 140 °C: completed.')
  assert.equal(
    translate('Zieltemperatur muss zwischen 0 und 295 °C liegen.', 'en'),
    'Target temperature must be between 0 and 295 °C.',
  )
  assert.equal(
    translate('Einziehen und purgen bei 240 °C, wischen, Heizung aus · wechselt zu diesem Tool', 'en'),
    'Load and purge at 240 °C, wipe, turn off heater · switches to this tool',
  )
  assert.equal(translate('T{0}: {1}. {2}', 'en', [2, 'Laden', 'Zuerst alle Achsen homen.']), 'T2: Load. Home all axes first.')
  assert.equal(translate('Nicht aufgenommen · zuletzt', 'en'), 'Not mounted · last known')
  assert.equal(
    translate('SET_HEATER_TEMPERATURE HEATER=extruder2 TARGET=240', 'en'),
    'SET_HEATER_TEMPERATURE HEATER=extruder2 TARGET=240',
  )
  assert.equal(translate('Zieltemperatur für T{0} übernehmen', 'de', [5]), 'Zieltemperatur für T5 übernehmen')
  assert.equal(translate('Unknown upstream response', 'en'), 'Unknown upstream response')
  assert.equal(translate('Alle Achsen homen gestartet …', 'en'), 'Home all axes started …')
  assert.equal(translate('Schritt {0}/{1} · {2}', 'en', [2, 4, 'T1 laden']), 'Step 2/4 · Load T1')
  assert.equal(
    translate('Cooldown ist während eines laufenden Drucks gesperrt. Bei einer Druckpause ist Cooldown verfügbar.', 'en'),
    'Cooldown is disabled while printing. Cooldown is available while paused.',
  )
  assert.equal(translate('printer.cfg gespeichert · Neustart ausgelöst.', 'en'), 'printer.cfg saved · restart triggered.')
  assert.equal(
    translate('Nudge Ring XY-Kalibrierung: abgeschlossen — Klipper startet neu.', 'en'),
    'Nudge Ring XY calibration: completed — Klipper is restarting.',
  )
  assert.equal(
    translate('Beacon Z-Kalibrierung (Referenz T2)', 'en'),
    'Beacon Z calibration (reference T2)',
  )
  assert.equal(translate('Auf T2 wechseln', 'en'), 'Switch to T2')
  assert.equal(translate('Auf T2 wechseln gestartet …', 'en'), 'Switch to T2 started …')
  assert.equal(translate('T1 parken und T2 aufnehmen', 'en'), 'Park T1 and pick up T2')
  assert.equal(
    translate('T{0}: {1}. {2}', 'en', [2, 'Wechseln', 'T1 parken und T2 aufnehmen']),
    'T2: Switch. Park T1 and pick up T2',
  )
  assert.equal(translate('Gewünschte Lüfterleistung für {0}', 'en', ['Bettlüfter']), 'Target fan speed for Bed fans')
  assert.equal(translate('CPAP Part Fan auf 75 %', 'en'), 'CPAP Part Fan to 75 %')
  assert.equal(translate('Nicht initialisiert', 'en'), 'Uninitialized')
  assert.equal(translate('Druck starten · benchy.gcode', 'en'), 'Start print · benchy.gcode')
  assert.equal(translate('Geschwindigkeit auf 120 %', 'en'), 'Speed to 120 %')
  assert.equal(translate('Fluss auf 95 %', 'en'), 'Flow to 95 %')
  assert.equal(translate('Z-Offset +0.010 mm', 'en'), 'Z offset +0.010 mm')
  assert.equal(translate('Objekt überspringen · Part_A', 'en'), 'Exclude object · Part_A')
  assert.equal(translate('X auf 175.5 mm', 'en'), 'Move X to 175.5 mm')
  assert.equal(
    translate('Backup enthält mehr als 20 Druckerprofile.', 'en'),
    'Backup contains more than 20 printer profiles.',
  )
  assert.equal(
    translate('Diese Zieladresse ist aus Sicherheitsgründen gesperrt.', 'en'),
    'This target address is blocked for security reasons.',
  )
  assert.equal(
    translate('Druckerprofil "VORON-V0" hat keine Moonraker-Adresse.', 'en'),
    'Printer profile "VORON-V0" is missing a Moonraker address.',
  )
})

test('saved language accepts supported choices and safely falls back with blocked storage', () => {
  assert.equal(
    savedLanguage({
      getItem(key) {
        assert.equal(key, storageKey)
        return 'en'
      },
    }),
    'en',
  )
  assert.equal(
    savedLanguage({
      getItem(key) {
        return key === 'stormtrooper.language' ? 'en' : null
      },
    }),
    'en',
  )
  assert.equal(savedLanguage({ getItem: () => 'fr' }), 'de')
  assert.equal(
    savedLanguage({
      getItem() {
        throw new Error('storage blocked')
      },
    }),
    'de',
  )
  assert.equal(savedLanguage(undefined), 'de')
})

async function listSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listSourceFiles(full)))
    else if (/\.(vue|js|mjs)$/.test(entry.name)) files.push(full)
  }
  return files
}

test('all static t(...) strings in src/ have English translations and no double-wrapped t(t(...)) calls remain', async () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url))
  const files = await listSourceFiles(srcDir)
  const missing = []
  const doubleWrapped = []

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    if (/\bt\(\s*t\(/.test(content)) doubleWrapped.push(path.relative(srcDir, file))
    for (const match of content.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const key = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"')
      if (!Object.hasOwn(en, key)) {
        missing.push(`${path.relative(srcDir, file)}: ${key}`)
      }
    }
  }

  assert.deepEqual(doubleWrapped, [], `Double-wrapped t(t(...)) calls found: ${doubleWrapped.join(', ')}`)
  assert.deepEqual(missing, [], `Missing en.json keys:\n${missing.join('\n')}`)
})

test('dynamic Paket 2 model, settings, and Spoolman error messages translate to English', () => {
  const dynamicMessages = [
    'Ungültige Drucker-ID für das 3D-Modell.',
    'Ungültiger Modell-Slot (nur toolhead oder printer erlaubt).',
    'Ungültige GLB-Daten.',
    'Die hochgeladene GLB-Datei ist leer.',
    'Die GLB-Datei überschreitet das Limit von 25 MB. Bitte zuerst mit scripts/optimize-dockyard-glb.sh komprimieren.',
    'Ungültige GLB-Datei (Header zu kurz).',
    'Ungültiges Dateiformat: Es werden nur binäre glTF-2.0-Dateien (.glb) unterstützt.',
    'Nicht unterstützte GLB-Version (1). Erforderlich ist glTF Version 2.',
    'Die GLB-Datei ist beschädigt oder unvollständig (Längenangabe weicht ab).',
    'Ungültige GLB-Struktur: Erster Block muss JSON sein.',
    'Ungültige GLB-Struktur: JSON-Block überschreitet Dateigröße.',
    'Ungültige GLB-Datei: JSON-Header ist beschädigt.',
    'Ungültige GLB-Datei: glTF 2.x asset.version fehlt.',
    'Ungültiger Modellpfad.',
    'Ungültige Akzentfarbe (erwartet wird ein Hex-Farbwert wie #d62828).',
    'Druckerprofil nicht gefunden. Bitte Profil zuerst speichern.',
    'Spoolman ist auf diesem Drucker in Moonraker nicht konfiguriert.',
    'Spoolman-Status konnte nicht geladen werden (HTTP 502).',
    'Spoolman-Server ist derzeit nicht mit Moonraker verbunden.',
    'Spoolman-Spulenliste konnte nicht geladen werden (HTTP 502).',
    'Ungültige Spulen-ID (positive Ganzzahl oder null erwartet).',
    'Aktive Spule konnte nicht gesetzt werden (HTTP 502).',
    'Upload fehlgeschlagen (HTTP 413).',
    'Verbindungsfehler beim Hochladen.',
    'Löschen fehlgeschlagen (HTTP 500).',
    'Verbindungsfehler beim Löschen.',
    'Datei ist größer als 150 MB. Bitte in Fusion 360 mit „Kompakt“ und „Kleinteile ausblenden“ exportieren.',
    'Optimiere 3D-Modell im Browser (57.00 MB) …',
    'Das 3D-Modell überschreitet selbst nach automatischer Komprimierung das 25-MB-Limit. Bitte in Fusion 360 mit „Kompakt“ exportieren.',
    '3D-Modell automatisch optimiert (57.00 MB → 5.00 MB) und live aktiviert.',
    'Nur Lesezugriff von diesem Browser-Origin.',
    'Keine Datei erkannt. Falls die Datei in iCloud liegt, bitte zuerst lokal laden oder über „.glb hochladen“ auswählen.',
  ]
  const untranslated = dynamicMessages.filter(msg => translate(msg, 'en') === msg)
  assert.deepEqual(untranslated, [], `Untranslated dynamic error messages:\n${untranslated.join('\n')}`)
})

test('display-mode touch targets for SpoolmanPicker meet 44px minimum', async () => {
  const css = await readFile(fileURLToPath(new URL('../src/style.css', import.meta.url)), 'utf8')
  assert.match(css, /\.app-shell\.display-mode\s+\.spoolman-pill\{[^}]*min-height:44px/)
  assert.match(css, /\.app-shell\.display-mode\s+\.spoolman-clear-btn\{[^}]*min-height:44px/)
})
