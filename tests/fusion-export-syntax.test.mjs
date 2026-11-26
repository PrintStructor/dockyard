import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateGlbBuffer } from '../server/models.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const FUSION_SCRIPT = path.join(ROOT, 'scripts/fusion-export-dockyard.py')
const FUSION_ADDIN_DIR = path.join(ROOT, 'fusion-addin/DockyardExport')
const FUSION_ADDIN_PY = path.join(FUSION_ADDIN_DIR, 'DockyardExport.py')
const FUSION_ADDIN_MANIFEST = path.join(FUSION_ADDIN_DIR, 'DockyardExport.manifest')
const INSTALL_ADDIN_SCRIPT = path.join(ROOT, 'scripts/install-fusion-addin.sh')
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

# Verify recursive visible occurrence traversal for nested Toolhead subassemblies (depth >= 2)
class _MockOcc:
    def __init__(self, name, visible=True, children=None):
        self.name = name
        self.isVisible = visible
        self.childOccurrences = children or []

nested = _MockOcc('Toolhead', True, [
    _MockOcc('CW2', True, [_MockOcc('Stepper', True, [_MockOcc('Rotor', True)])]),
    _MockOcc('HiddenSub', False, [_MockOcc('HiddenChild', True)]),
])
visited = [o.name for o in mod.iter_visible_occurrences(nested)]
assert visited == ['Toolhead', 'CW2', 'Stepper', 'Rotor'], visited

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

test('Fusion 360 DockyardExport Add-In has valid manifest, icons, Add-In lifecycle and installer', async () => {
  const manifest = JSON.parse(await readFile(FUSION_ADDIN_MANIFEST, 'utf8'))
  assert.equal(manifest.autodeskProduct, 'Fusion')
  assert.equal(manifest.type, 'addin')
  assert.equal(manifest.runOnStartup, true)
  assert.match(manifest.supportedOS, /mac/i)

  const addinSrc = await readFile(FUSION_ADDIN_PY, 'utf8')
  assert.doesNotMatch(addinSrc, /adsk\.terminate\s*\(/, 'Add-Ins must not call adsk.terminate()')
  assert.match(addinSrc, /def run\(/)
  assert.match(addinSrc, /def stop\(/)

  const pyEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  const pyCode = `
import importlib.util, sys, base64
spec = importlib.util.spec_from_file_location('dockyard_addin', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.fusion_cm_to_gltf_m(10.0, 20.0, 30.0, up_axis='z') == (0.1, 0.3, -0.2)
assert mod.fusion_cm_to_gltf_m(10.0, 20.0, 30.0, up_axis='y') == (0.1, 0.2, 0.3)
assert mod.is_transparent_appearance('Polycarbonate Clear') is True
assert mod.is_transparent_appearance('Black Anodized Aluminum') is False
assert mod.detect_dockyard_role('LED_LOGO_Assembly v2:1+Diffuser:1 Body1', '') == 'led-logo'
assert mod.detect_dockyard_role('NOZZLE_MOUNT:1+LED_NOZZLE_L:1 Body1', '') == 'led-nozzle-l'

class _MockComp:
    id = 'comp-xref-42'

class _MockXrefBody:
    name = 'Body1'
    volume = 1.25
    area = 6.5
    parentComponent = _MockComp()
    @property
    def entityToken(self):
        raise RuntimeError('2 : InternalValidationError : Xl::Util::referenceKey(this, referenceKey)')

key = mod._safe_body_key(_MockXrefBody(), 'fallback')
assert key == ('xref', 'comp-xref-42', 'Body1', 1.25, 6.5), key

glb = mod.build_glb_bytes([
  {
    'name': 'AcrylPanel',
    'role': None,
    'color': [0.18, 0.28, 0.32, 0.14],
    'positions': [0.0, 0.0, 0.0, 0.1, 0.0, 0.0, 0.05, 0.1, 0.0],
    'normals': [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
    'indices': [0, 1, 2],
  },
], source_name='VORON 2.4')
sys.stdout.write(base64.b64encode(glb).decode('ascii'))
`
  const b64 = execFileSync('python3', ['-c', pyCode, FUSION_ADDIN_PY], { encoding: 'utf8', env: pyEnv })
  const buf = Buffer.from(b64, 'base64')
  const info = validateGlbBuffer(buf)
  const gltf = JSON.parse(buf.subarray(20, 20 + info.jsonChunkLength).toString('utf8'))
  assert.equal(gltf.materials[0].alphaMode, 'BLEND')
  assert.equal(gltf.materials[0].doubleSided, true)

  // Verify all 6 PNG icons exist with exact PNG header and dimensions
  for (const [file, expected] of [
    ['16x16.png', 16],
    ['32x32.png', 32],
    ['64x64.png', 64],
    ['16x16-dark.png', 16],
    ['32x32-dark.png', 32],
    ['64x64-dark.png', 64],
  ]) {
    const png = await readFile(path.join(FUSION_ADDIN_DIR, 'resources', file))
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} must be valid PNG`)
    assert.equal(png.readUInt32BE(16), expected, `${file} width must be ${expected}`)
    assert.equal(png.readUInt32BE(20), expected, `${file} height must be ${expected}`)
  }

  // Verify installer script syntax and installation into an isolated temp directory
  execFileSync('bash', ['-n', INSTALL_ADDIN_SCRIPT], { stdio: 'pipe' })
  const tmpAddIns = await mkdtemp(path.join(os.tmpdir(), 'dockyard-fusion-addins-'))
  try {
    execFileSync('bash', [INSTALL_ADDIN_SCRIPT], {
      env: { ...process.env, FUSION_ADDINS_DIR: tmpAddIns },
      stdio: 'pipe',
    })
    await access(path.join(tmpAddIns, 'DockyardExport/DockyardExport.py'))
    await access(path.join(tmpAddIns, 'DockyardExport/DockyardExport.manifest'))
    await access(path.join(tmpAddIns, 'DockyardExport/resources/32x32-dark.png'))
  } finally {
    await rm(tmpAddIns, { recursive: true, force: true })
  }
})
