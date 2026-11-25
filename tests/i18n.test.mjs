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
