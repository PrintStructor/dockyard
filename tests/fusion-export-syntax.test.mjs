import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateGlbBuffer } from '../server/models.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const FUSION_SCRIPT = path.join(ROOT, 'scripts/fusion-export-dockyard.py')
const IMPORT_SCRIPT = path.join(ROOT, 'scripts/import-3d-print-rig.sh')

test('fusion-export-dockyard.py compiles cleanly and pure-Python helpers normalize coordinates, tag roles and pack valid GLB v2', () => {
  const pyEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  execFileSync('python3', ['-c', 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', FUSION_SCRIPT], {
    stdio: 'pipe',
    env: pyEnv,
  })

  const pyCode = `
import importlib.util, json, sys, base64
spec = importlib.util.spec_from_file_location('fusion_export', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.fusion_cm_to_gltf_m(10.0, 20.0, 30.0) == (0.1, 0.3, -0.2), mod.fusion_cm_to_gltf_m(10.0, 20.0, 30.0)
assert mod.should_skip_fastener('M3x8 SHCS') is True
assert mod.should_skip_fastener('Heatset Insert M3x5') is True
assert mod.should_skip_fastener('StealthBurner Main Body') is False
assert mod.detect_dockyard_role('LED_LOGO', '') == 'led-logo'
assert mod.detect_dockyard_role('Faceplate', 'VORON_ACCENT Red') == 'accent'
assert mod.detect_dockyard_role('LED_NOZZLE_L', '') == 'led-nozzle-l'
assert mod.detect_dockyard_role('LED_NOZZLE_R', '') == 'led-nozzle-r'
assert mod.detect_dockyard_role('Frame Extrusion', 'Black Anodized') is None

glb = mod.build_glb_bytes([
  {
    'name': 'VORON_ACCENT',
    'role': 'accent',
    'color': [0.84, 0.16, 0.16, 1.0],
    'positions': [0.0, 0.0, 0.0, 0.05, 0.0, 0.0, 0.025, 0.05, 0.0],
    'normals': [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
    'indices': [0, 1, 2],
  },
  {
    'name': 'LED_LOGO',
    'role': 'led-logo',
    'color': [0.4, 0.45, 0.48, 1.0],
    'positions': [0.01, 0.02, 0.01, 0.04, 0.02, 0.01, 0.025, 0.04, 0.01],
    'normals': [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
    'indices': [0, 1, 2],
  },
], source_name='Crucible Test')
sys.stdout.write(base64.b64encode(glb).decode('ascii'))
`
  const b64 = execFileSync('python3', ['-c', pyCode, FUSION_SCRIPT], { encoding: 'utf8', env: pyEnv })
  const buf = Buffer.from(b64, 'base64')
  const info = validateGlbBuffer(buf)
  assert.equal(info.assetVersion, '2.0')

  const gltf = JSON.parse(buf.subarray(20, 20 + info.jsonChunkLength).toString('utf8'))
  const names = gltf.nodes.map(n => n.name)
  assert.ok(names.includes('VORON_ACCENT'))
  assert.ok(names.includes('LED_LOGO'))
  const roles = gltf.nodes.map(n => n.extras?.dockyardRole)
  assert.ok(roles.includes('accent'))
  assert.ok(roles.includes('led-logo'))
})

test('import-3d-print-rig.sh passes bash syntax check, lists filtered catalog offline and rejects unknown IDs', async () => {
  execFileSync('bash', ['-n', IMPORT_SCRIPT], { stdio: 'pipe' })

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dockyard-rig-test-'))
  try {
    const manifestPath = path.join(tmp, 'manifest.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        machine_ids: ['voron_v24_350_printed', 'voron_trident_300', 'siboor_v24_350', 'ratrig_vcore_40_300_corexy'],
        files: [
          {
            path: 'machines/voron_v24_350_printed/model.glb.gz',
            bytes: 24_500_000,
            sha256: '0000',
            url: 'https://example.invalid/v24.glb.gz',
          },
          {
            path: 'machines/voron_trident_300/model.glb.gz',
            bytes: 11_100_000,
            sha256: '1111',
            url: 'https://example.invalid/trident.glb.gz',
          },
          {
            path: 'machines/siboor_v24_350/model.glb.gz',
            bytes: 23_200_000,
            sha256: '2222',
            url: 'https://example.invalid/siboor.glb.gz',
          },
        ],
      }),
    )

    const out = execFileSync('bash', [IMPORT_SCRIPT, '--manifest', manifestPath, '--list', 'voron'], {
      encoding: 'utf8',
    })
    assert.match(out, /voron_v24_350_printed/)
    assert.match(out, /voron_trident_300/)
    assert.doesNotMatch(out, /ratrig_vcore_40_300_corexy/)

    assert.throws(
      () => execFileSync('bash', [IMPORT_SCRIPT, '--manifest', manifestPath, 'does_not_exist'], { stdio: 'pipe' }),
      /status 1|Command failed/i,
    )
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
