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

# Verify occurrence appearance override & non-white shader property precedence
class _Color:
    def __init__(self, r, g, b):
        self.red, self.green, self.blue = r, g, b

class _Prop:
    def __init__(self, pid, name, rgb, tex=False):
        self.id = pid
        self.name = name
        self.value = _Color(*rgb)
        self.hasConnectedTexture = tex

class _Props:
    def __init__(self, items):
        self._items = items
    def itemByName(self, n):
        return next((p for p in self._items if p.name == n), None)
    def itemById(self, pid):
        return next((p for p in self._items if p.id == pid), None)
    def __iter__(self):
        return iter(self._items)

class _App:
    def __init__(self, aid, name, props):
        self.id = aid
        self.name = name
        self.appearanceProperties = _Props(props)

class _OccWithApp:
    def __init__(self, appearance=None, parent=None):
        self.appearance = appearance
        self.assemblyContext = parent

class _BodyWithApp:
    def __init__(self, appearance=None):
        self.appearance = appearance

white_body = _BodyWithApp(_App('a-white', 'ABS (White)', [_Prop('opaque_albedo', 'Color', (255, 255, 255))]))
none_body = _BodyWithApp(None)
black_occ = _OccWithApp(
    appearance=_App(
        'a-black',
        'Aluminum - Anodized Glossy (Black)',
        [_Prop('opaque_albedo', 'Color', (255, 255, 255), tex=True), _Prop('metal_f0', 'Reflectance', (22, 24, 26))],
    )
)
rgba_black, name_black = mod._extract_appearance_rgba(none_body, black_occ, {})
assert name_black == 'Aluminum - Anodized Glossy (Black)'
assert rgba_black[0] < 0.05 and rgba_black[1] < 0.05 and rgba_black[2] < 0.05, rgba_black

# Verify name fallback when textured library material only reports white
tex_only_occ = _OccWithApp(
    appearance=_App('a-tex-black', 'Carbon Fiber - Plain', [_Prop('opaque_albedo', 'Color', (255, 255, 255), tex=True)])
)
rgba_cf, _ = mod._extract_appearance_rgba(none_body, tex_only_occ, {})
assert rgba_cf[0] < 0.06 and rgba_cf[1] < 0.06 and rgba_cf[2] < 0.06, rgba_cf

# Verify explicit non-textured solid white does NOT fall through to secondary yellow shader properties
solid_white_with_emissive = _OccWithApp(
    appearance=_App(
        'a-white-emissive',
        'ABS (White)',
        [_Prop('opaque_albedo', 'Color', (255, 255, 255), tex=False), _Prop('emissive_color', 'Emissive', (255, 255, 0), tex=False)],
    )
)
rgba_white, _ = mod._extract_appearance_rgba(none_body, solid_white_with_emissive)
assert rgba_white == (1.0, 1.0, 1.0, 1.0), rgba_white

# Verify Fusion 2706 direct Appearance.color: body appearance wins over stale parent STEP occurrence,
# empty appearance.id never collides, and opacity=0 on metals stays opaque (alpha=1.0).
class _DirectColor:
    def __init__(self, r, g, b, opacity=0):
        self.red, self.green, self.blue, self.opacity = r, g, b, opacity

class _DirectApp:
    def __init__(self, name, rgba):
        self.id = ''
        self.name = name
        self.color = _DirectColor(*rgba)
        self.hasTexture = False

stale_yellow_parent = _OccWithApp(appearance=_DirectApp('Opaque(255,255,0)', (255, 255, 0, 255)))
metal_body = _BodyWithApp(_DirectApp('Stainless Steel - Cast', (198, 198, 198, 0)))
black_body = _BodyWithApp(_DirectApp('Anodized Black', (18, 20, 22, 0)))
rgba_metal, name_metal = mod._extract_appearance_rgba(metal_body, stale_yellow_parent)
rgba_ex, _ = mod._extract_appearance_rgba(black_body, stale_yellow_parent)
assert name_metal == 'Stainless Steel - Cast'
assert rgba_metal[3] == 1.0, rgba_metal
assert rgba_ex[0] < 0.02 and rgba_ex[1] < 0.02 and rgba_ex[2] < 0.02 and rgba_ex[3] == 1.0, rgba_ex

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

  // Verify optimizer keeps --palette false and --prune false so colors and live tags survive
  const optSrc = await readFile(path.join(ROOT, 'scripts/optimize-dockyard-glb.sh'), 'utf8')
  assert.match(optSrc, /--palette false/)
  assert.match(optSrc, /--prune false/)

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

test('DockyardExport native USDZ/USDA and 3MF parsers preserve PBR colors, GeomSubsets, live tags and micro-filtering', () => {
  const pyEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  const pyCode = `
import importlib.util, os, sys, tempfile, zipfile, base64, json
spec = importlib.util.spec_from_file_location('dockyard_addin', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

with tempfile.TemporaryDirectory() as tmp:
    # 1. Synthetic Fusion-format .usda with PBR metals, glass, multi-color GeomSubset,
    #    mirrored instance, live DOCKYARD role tag, and sub-millimeter PCB micro-part.
    usda_path = os.path.join(tmp, 'sample.usda')
    open(usda_path, 'w', encoding='utf-8').write("""#usda 1.0
(
    defaultPrim = "sample"
    metersPerUnit = 0.001
    upAxis = "Y"
)
def Xform "sample"
{
    def Material "XID_PlasticMatteBlack_AAA"
    {
        def Shader "shader"
        {
            color3f inputs:diffuseColor = (0.0998528, 0.0998528, 0.0998528)
            float inputs:metallic = 0
            float inputs:opacity = 1
            float inputs:roughness = 0.7
        }
    }
    def Material "XID_SteelSatin_BBB"
    {
        def Shader "shader"
        {
            color3f inputs:diffuseColor = (0.62621, 0.62621, 0.62621)
            float inputs:metallic = 1
            float inputs:opacity = 1
            float inputs:roughness = 0.26
        }
    }
    def Material "XID_GlassClear_CCC"
    {
        def Shader "shader"
        {
            color3f inputs:diffuseColor = (0.8, 0.9, 0.95)
            float inputs:metallic = 0
            float inputs:opacity = 0.2
            float inputs:roughness = 0.05
        }
    }
    def Material "XID_VORONACCENT_DDD"
    {
        def Shader "shader"
        {
            color3f inputs:diffuseColor = (0.380392, 1, 0)
            float inputs:metallic = 0
            float inputs:opacity = 1
            float inputs:roughness = 0.3
        }
    }
    def Xform "MeshInstance_0" (
        prepend references = </MeshPrimDef_0>
    )
    {
        matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )
        over "Body1"
        {
            rel material:binding = </sample/XID_PlasticMatteBlack_AAA>
            over "subset_steel"
            {
                rel material:binding = </sample/XID_SteelSatin_BBB>
            }
        }
    }
    def Xform "MeshInstance_1" (
        prepend references = </MeshPrimDef_1>
    )
    {
        matrix4d xformOp:transform = ( (-1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (50, 10, 0, 1) )
        over "BodyGlass"
        {
            rel material:binding = </sample/XID_GlassClear_CCC>
        }
    }
    def Xform "MeshInstance_2" (
        prepend references = </MeshPrimDef_Micro>
    )
    {
        matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )
        over "Tiny"
        {
            rel material:binding = </sample/XID_PlasticMatteBlack_AAA>
        }
    }
    def Xform "MeshInstance_3" (
        prepend references = </MeshPrimDef_Micro>
    )
    {
        matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (10, 0, 0, 1) )
        over "Tiny"
        {
            rel material:binding = </sample/XID_VORONACCENT_DDD>
        }
    }
}
over Xform "MeshPrimDef_0"
{
    def Mesh "Body1"
    {
        float3[] extent = [(0, 0, 0), (2, 2, 2)]
        int[] faceVertexCounts = [3, 3]
        int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)]
        point3f[] points = [(0, 0, 0), (2, 0, 0), (2, 2, 0), (0, 2, 0)]
        matrix4d xformOp:transform = ( (10, 0, 0, 0), (0, 10, 0, 0), (0, 0, 10, 0), (0, 0, 0, 1) )
        def GeomSubset "subset_steel"
        {
            int[] indices = [1]
        }
    }
}
over Xform "MeshPrimDef_1"
{
    def Mesh "BodyGlass"
    {
        float3[] extent = [(0, 0, 0), (2, 2, 0)]
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1)]
        point3f[] points = [(0, 0, 0), (2, 0, 0), (0, 2, 0)]
        matrix4d xformOp:transform = ( (10, 0, 0, 0), (0, 10, 0, 0), (0, 0, 10, 0), (0, 0, 0, 1) )
    }
}
over Xform "MeshPrimDef_Micro"
{
    def Mesh "Tiny"
    {
        float3[] extent = [(0, 0, 0), (0.01, 0.01, 0.01)]
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        normal3f[] normals = [(0, 1, 0), (0, 1, 0), (0, 1, 0)]
        point3f[] points = [(0, 0, 0), (0.01, 0, 0), (0, 0.01, 0)]
        matrix4d xformOp:transform = ( (10, 0, 0, 0), (0, 10, 0, 0), (0, 0, 10, 0), (0, 0, 0, 1) )
    }
}
""")

    groups, tris, seen_mats, skipped = mod.parse_usda_to_mesh_groups(usda_path, min_diag_m=0.0025)
    assert skipped == 1, f'expected 1 micro body skipped, got {skipped}'
    assert tris == 4, f'expected 4 tris (black + steel + glass + tiny accent), got {tris}'
    assert len(groups) == 4, [(g['name'], g['color'], g['metallic']) for g in groups]

    # Verify live VORON_ACCENT survived micro-filter, metallic steel is metallic, glass is translucent, black is dark
    by_role = {g['role']: g for g in groups}
    assert 'accent' in by_role, by_role.keys()
    assert any(g['metallic'] >= 0.8 for g in groups), groups
    assert any(g['color'][3] < 0.3 for g in groups), groups
    assert any(g['color'][0] < 0.02 and g['color'][1] < 0.02 and g['color'][2] < 0.02 for g in groups), groups

    glb_usd = mod.build_glb_bytes(groups, source_name='USD Sample')

    # 2. Synthetic Fusion-format .3mf with per-object & per-triangle colors
    tmf_path = os.path.join(tmp, 'sample.3mf')
    model_xml = """<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="2"><m:color color="#222222FF"/><m:color color="#D0D0D0FF"/></m:colorgroup>
    <object id="1" name="Stepper" type="model" pid="2" pindex="0">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="20" y="0" z="0"/>
          <vertex x="20" y="20" z="0"/>
          <vertex x="0" y="20" z="10"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
          <triangle v1="0" v2="2" v3="3" pid="2" p1="1"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>"""
    with zipfile.ZipFile(tmf_path, 'w') as zf:
        zf.writestr('3D/3dmodel.model', model_xml)

    g3, t3 = mod.parse_3mf_to_mesh_groups(tmf_path)
    assert t3 == 2 and len(g3) == 2, (t3, len(g3))
    glb_3mf = mod.build_glb_bytes(g3, source_name='3MF Sample')

    sys.stdout.write(json.dumps({
        'usd': base64.b64encode(glb_usd).decode('ascii'),
        'tmf': base64.b64encode(glb_3mf).decode('ascii'),
    }))
`
  const out = JSON.parse(execFileSync('python3', ['-c', pyCode, FUSION_ADDIN_PY], { encoding: 'utf8', env: pyEnv }))
  const usdBuf = Buffer.from(out.usd, 'base64')
  const tmfBuf = Buffer.from(out.tmf, 'base64')
  const usdInfo = validateGlbBuffer(usdBuf)
  const tmfInfo = validateGlbBuffer(tmfBuf)
  assert.equal(usdInfo.assetVersion, '2.0')
  assert.equal(tmfInfo.assetVersion, '2.0')

  const gltf = JSON.parse(usdBuf.subarray(20, 20 + usdInfo.jsonChunkLength).toString('utf8'))
  assert.ok(gltf.nodes.some(n => n.name === 'VORON_ACCENT'))
  assert.ok(gltf.materials.some(m => m.alphaMode === 'BLEND'))
  assert.ok(gltf.materials.some(m => m.pbrMetallicRoughness.metallicFactor >= 0.8))
})
