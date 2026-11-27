"""
DOCKYARD Export — Autodesk Fusion 360 Add-In (macOS & Windows).

Adds a permanent "DOCKYARD Export" toolbar button under
Utilities -> Add-Ins (SolidScriptsAddinsPanel) in Fusion's Design workspace.

Features:
- Exports either the full visible printer assembly (`printer`) or the selected
  toolhead subassembly (`toolhead`, recursive traversal of nested occurrences).
- Uses native component mesh caching (`body.nativeObject`) + `occ.transform2`
  so repeated parts (extrusions, rails, idlers) export 5-10x faster without
  double transformations.
- Supports both Z-up (VORON / STEP) and Y-up (Fusion legacy) modeling axes,
  converting cleanly to right-handed glTF 2.0 Y-up meters, centered on X/Z = 0
  and grounded at minY = 0.
- Optional fastener/bearing filter, glass/acrylic transparency (`BLEND`),
  double-sided thin panels, native Fusion progress dialog with Cancel,
  and live DOCKYARD tags:
    VORON_ACCENT, LED_LOGO, LED_NOZZLE_L, LED_NOZZLE_R
- Optional macOS Finder reveal (`open -R`) right after export.
"""

import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import traceback
import xml.etree.ElementTree as ET
import zipfile

try:
    import adsk.core
    import adsk.fusion
except ImportError:
    adsk = None

_ADDIN_DIR = os.path.dirname(os.path.abspath(__file__))
_RESOURCES_DIR = os.path.join(_ADDIN_DIR, "resources")

_CMD_ID = "DockyardExportGlbAddInCmd"
_CMD_NAME = "DOCKYARD Export"
_CMD_TOOLTIP = "Exportiert den aktiven Drucker oder Toolhead als glTF 2.0 (.glb) für das DOCKYARD-Cockpit."
_PANEL_IDS = ("SolidScriptsAddinsPanel", "SolidMakePanel")

_HANDLERS = []
_CMD_HANDLERS = []

FASTENER_PATTERN = re.compile(
    r"(?:^|[\s_\-\(])("
    r"m[2-8](?:\.\d+)?\s*[x×]\s*\d+|"
    r"shcs|bhcs|fhcs|din\s*\d+|iso\s*\d+|"
    r"screw|bolt|washer|nut|hex\s*nut|locknut|t[\-_ ]?nut|"
    r"heat[\-_ ]?set|insert|shim|dowel|circlip|set[\-_ ]?screw|"
    r"schraube|mutter|unterlegscheibe|gewindeeinsatz|kugellager|bearing|"
    r"f695|608|625|mr85|mr105|mf105"
    r")(?:$|[\s_\-\)])",
    re.IGNORECASE,
)

GLASS_KEYWORDS = ("glass", "clear", "transparent", "acryl", "polycarbon", "glazing", "plexiglas", "scheibe")


def slugify_filename(name, fallback="dockyard-model"):
    clean = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(name or "").strip().lower()).strip("-_")
    return clean[:64] or fallback


def should_skip_fastener(name):
    return bool(FASTENER_PATTERN.search(str(name or "")))


def is_transparent_appearance(appearance_name):
    lower = str(appearance_name or "").lower()
    return any(k in lower for k in GLASS_KEYWORDS)


def detect_dockyard_role(name, appearance_name=""):
    combined = f"{name or ''} {appearance_name or ''}".upper()
    compact = combined.replace("_", "").replace("-", "").replace(" ", "")
    if "LED_NOZZLE_L" in combined or "LEDNOZZLEL" in compact:
        return "led-nozzle-l"
    if "LED_NOZZLE_R" in combined or "LEDNOZZLER" in compact:
        return "led-nozzle-r"
    if "LED_LOGO" in combined or "LEDLOGO" in compact:
        return "led-logo"
    if "VORON_ACCENT" in combined or "VORONACCENT" in compact:
        return "accent"
    if "FILAMENT_INLET" in combined or "FILAMENTINLET" in compact:
        return "filament-inlet"
    if "NOZZLE_TIP" in combined or "NOZZLETIP" in compact:
        return "nozzle-tip"
    if str(appearance_name or "").strip().upper().startswith("LED -"):
        return "led-logo"
    return None


def fusion_cm_to_gltf_m(x, y, z, up_axis="z"):
    """Convert Fusion cm to glTF right-handed Y-up meters."""
    if str(up_axis or "z").lower() == "y":
        return (round(x * 0.01, 7), round(y * 0.01, 7), round(z * 0.01, 7))
    return (round(x * 0.01, 7), round(z * 0.01, 7), round(-y * 0.01, 7))


def iter_visible_occurrences(occ):
    """Yield an occurrence and all visible descendant occurrences recursively."""
    if not occ or not getattr(occ, "isVisible", False):
        return
    yield occ
    for child in getattr(occ, "childOccurrences", None) or ():
        yield from iter_visible_occurrences(child)


def _pad4(data, pad_byte=b"\x00"):
    rem = len(data) % 4
    return data if rem == 0 else data + pad_byte * (4 - rem)


def build_glb_bytes(mesh_groups, source_name="", extra_meta=None):
    """Pack mesh groups into a self-contained glTF 2.0 Binary (.glb) payload."""
    valid_groups = [g for g in mesh_groups if g.get("positions") and g.get("indices")]
    if not valid_groups:
        raise ValueError("Keine sichtbaren Geometrien zum Exportieren gefunden.")

    bin_parts = []
    byte_offset = 0
    buffer_views = []
    accessors = []
    materials = []
    meshes = []
    nodes = []

    def append_view(raw_bytes, target):
        nonlocal byte_offset
        padded = _pad4(raw_bytes, b"\x00")
        idx = len(buffer_views)
        buffer_views.append(
            {
                "buffer": 0,
                "byteOffset": byte_offset,
                "byteLength": len(raw_bytes),
                "target": target,
            }
        )
        bin_parts.append(padded)
        byte_offset += len(padded)
        return idx

    for idx, group in enumerate(valid_groups):
        pos = group["positions"]
        norm = group.get("normals") or [0.0, 1.0, 0.0] * (len(pos) // 3)
        indices = group["indices"]
        vert_count = len(pos) // 3

        xs = pos[0::3]
        ys = pos[1::3]
        zs = pos[2::3]
        p_min = [min(xs), min(ys), min(zs)]
        p_max = [max(xs), max(ys), max(zs)]

        pos_bytes = struct.pack(f"<{len(pos)}f", *pos)
        norm_bytes = struct.pack(f"<{len(norm)}f", *norm)
        use_u32 = vert_count > 65535
        idx_fmt = "I" if use_u32 else "H"
        idx_comp_type = 5125 if use_u32 else 5123
        idx_bytes = struct.pack(f"<{len(indices)}{idx_fmt}", *indices)

        pos_view = append_view(pos_bytes, 34962)
        norm_view = append_view(norm_bytes, 34962)
        idx_view = append_view(idx_bytes, 34963)

        pos_acc = len(accessors)
        accessors.append(
            {
                "bufferView": pos_view,
                "componentType": 5126,
                "count": vert_count,
                "type": "VEC3",
                "min": p_min,
                "max": p_max,
            }
        )
        norm_acc = len(accessors)
        accessors.append(
            {
                "bufferView": norm_view,
                "componentType": 5126,
                "count": vert_count,
                "type": "VEC3",
            }
        )
        idx_acc = len(accessors)
        accessors.append(
            {
                "bufferView": idx_view,
                "componentType": idx_comp_type,
                "count": len(indices),
                "type": "SCALAR",
                "min": [min(indices)],
                "max": [max(indices)],
            }
        )

        role = group.get("role")
        node_name = group.get("name") or (
            "VORON_ACCENT"
            if role == "accent"
            else "LED_LOGO"
            if role == "led-logo"
            else "LED_NOZZLE_L"
            if role == "led-nozzle-l"
            else "LED_NOZZLE_R"
            if role == "led-nozzle-r"
            else "FILAMENT_INLET"
            if role == "filament-inlet"
            else "NOZZLE_TIP"
            if role == "nozzle-tip"
            else f"part_{idx}"
        )

        col = [float(c) for c in (group.get("color") or [0.22, 0.25, 0.28, 1.0])[:4]]
        if len(col) < 4:
            col.append(1.0)
        mat_name = "VORON_ACCENT" if role == "accent" else f"mat_{node_name}"
        mat_def = {
            "name": mat_name,
            "pbrMetallicRoughness": {
                "baseColorFactor": col,
                "metallicFactor": float(group.get("metallic", 0.12)),
                "roughnessFactor": float(group.get("roughness", 0.54)),
            },
            "doubleSided": True,
        }
        if col[3] < 0.99:
            mat_def["alphaMode"] = "BLEND"

        mat_idx = len(materials)
        materials.append(mat_def)

        mesh_idx = len(meshes)
        meshes.append(
            {
                "name": node_name,
                "primitives": [
                    {
                        "attributes": {"POSITION": pos_acc, "NORMAL": norm_acc},
                        "indices": idx_acc,
                        "material": mat_idx,
                    }
                ],
            }
        )

        node = {"name": node_name, "mesh": mesh_idx}
        if role:
            node["extras"] = {"dockyardRole": role}
        nodes.append(node)

    bin_blob = b"".join(bin_parts)
    asset_extras = {"sourceDocument": source_name}
    if extra_meta and isinstance(extra_meta, dict):
        asset_extras.update(extra_meta)
    gltf = {
        "asset": {
            "version": "2.0",
            "generator": "DOCKYARD Fusion 360 Add-In",
            "extras": asset_extras,
        },
        "scene": 0,
        "scenes": [{"name": source_name or "DOCKYARD", "nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(bin_blob)}],
    }

    json_bytes = _pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_blob)
    header = struct.pack("<3I", 0x46546C67, 2, total_len)
    json_chunk = struct.pack("<2I", len(json_bytes), 0x4E4F534A) + json_bytes
    bin_chunk = struct.pack("<2I", len(bin_blob), 0x004E4942) + bin_blob
    return header + json_chunk + bin_chunk


# --- Fusion 360 Runtime Export & Add-In Lifecycle ---


def _srgb_byte_to_linear(value):
    s = max(0.0, min(1.0, value / 255.0))
    return round(s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4, 4)


def _srgb_float_to_linear(value):
    s = max(0.0, min(1.0, float(value)))
    return round(s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4, 4)


def _quantize_linear_channel(c):
    """Preserve fine dark shades (< 0.12 linear) while merging near-identical mid/high tones."""
    return round(c, 2) if c < 0.12 else round(c * 20.0) / 20.0


_IDENTITY_MAT4 = (
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
)

_NUM_RE = re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?")
_QUOTED_RE = re.compile(r'"([^"]+)"')
_REF_PATH_RE = re.compile(r"</([^>]+)>")


def _mat4_mul_row(a, b):
    """Multiply two row-major 4x4 matrices under USD row-vector convention (p * a * b)."""
    out = [0.0] * 16
    for r in range(4):
        r4 = r * 4
        a0, a1, a2, a3 = a[r4], a[r4 + 1], a[r4 + 2], a[r4 + 3]
        out[r4] = a0 * b[0] + a1 * b[4] + a2 * b[8] + a3 * b[12]
        out[r4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9] + a3 * b[13]
        out[r4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10] + a3 * b[14]
        out[r4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3 * b[15]
    return tuple(out)


def _mat3_cofactor_and_det(m):
    """Return (cofactor_9tuple, det) for the upper-left 3x3 of a row-major 4x4 matrix."""
    a00, a01, a02 = m[0], m[1], m[2]
    a10, a11, a12 = m[4], m[5], m[6]
    a20, a21, a22 = m[8], m[9], m[10]
    c00 = a11 * a22 - a12 * a21
    c01 = -(a10 * a22 - a12 * a20)
    c02 = a10 * a21 - a11 * a20
    c10 = -(a01 * a22 - a02 * a21)
    c11 = a00 * a22 - a02 * a20
    c12 = -(a00 * a21 - a01 * a20)
    c20 = a01 * a12 - a02 * a11
    c21 = -(a00 * a12 - a02 * a10)
    c22 = a00 * a11 - a01 * a10
    det = a00 * c00 + a01 * c01 + a02 * c02
    return (c00, c01, c02, c10, c11, c12, c20, c21, c22), det


def _parse_usda_matrix(line):
    nums = _NUM_RE.findall(line)
    if len(nums) >= 16:
        return tuple(float(v) for v in nums[-16:])
    return _IDENTITY_MAT4


def _parse_bracket_floats(line):
    eq = line.find("=")
    start = line.find("[", eq + 1 if eq != -1 else 0)
    end = line.rfind("]")
    if start == -1 or end == -1 or end <= start + 1:
        return []
    inner = line[start + 1 : end].replace("(", "").replace(")", "")
    return [float(tok) for tok in inner.split(",") if tok.strip()]


def _parse_bracket_ints(line):
    eq = line.find("=")
    start = line.find("[", eq + 1 if eq != -1 else 0)
    end = line.rfind("]")
    if start == -1 or end == -1 or end <= start + 1:
        return []
    return [int(tok) for tok in line[start + 1 : end].split(",") if tok.strip()]


def _find_usdcat():
    for candidate in ("/usr/bin/usdcat", shutil.which("usdcat")):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _finalize_grouped_meshes(grouped, min_x, max_x, min_y, max_y, min_z, max_z):
    cx = (min_x + max_x) * 0.5
    cz = (min_z + max_z) * 0.5
    mesh_groups = []
    for idx, grp in enumerate(grouped.values()):
        pos = grp["positions"]
        if not pos or not grp["indices"]:
            continue
        for i in range(0, len(pos), 3):
            pos[i] = round(pos[i] - cx, 6)
            pos[i + 1] = round(pos[i + 1] - min_y, 6)
            pos[i + 2] = round(pos[i + 2] - cz, 6)
        role = grp["role"]
        grp["name"] = (
            "VORON_ACCENT"
            if role == "accent"
            else "LED_LOGO"
            if role == "led-logo"
            else "LED_NOZZLE_L"
            if role == "led-nozzle-l"
            else "LED_NOZZLE_R"
            if role == "led-nozzle-r"
            else "FILAMENT_INLET"
            if role == "filament-inlet"
            else "NOZZLE_TIP"
            if role == "nozzle-tip"
            else f"mesh_{idx}"
        )
        mesh_groups.append(grp)
    return mesh_groups


def _mat3_mul(a, b):
    """Multiply two 3x3 column-vector matrices represented as 9-tuples."""
    return (
        a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
        a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
        a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
        a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
        a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
        a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
        a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
        a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
        a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
    )


def _build_usd_post_transform_row(occ_transform_col=None, doc_up="z", requested_up="auto"):
    """Build a USD row-vector 4x4 rotation/scale matrix that:
    1. Restores a selected Occurrence's assembly orientation (`occ.transform2`) when Fusion's
       USD exporter exports `occ.component` in local component space.
    2. Applies an optional orientation override ('auto', 'x+90', 'x-90', or legacy 'z'/'y').
    """
    # Basis change from Fusion space to USD Y-up space (column-vector 3x3)
    u_z = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0)       # -90 deg around X: (x,y,z) -> (x,z,-y)
    u_z_inv = (1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0)   # +90 deg around X: (x,y,z) -> (x,-z,y)
    ident3 = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)

    is_doc_y = str(doc_up or "z").lower() == "y"
    u_doc = ident3 if is_doc_y else u_z
    u_doc_inv = ident3 if is_doc_y else u_z_inv

    if occ_transform_col and len(occ_transform_col) >= 12:
        r_occ = (
            float(occ_transform_col[0]), float(occ_transform_col[1]), float(occ_transform_col[2]),
            float(occ_transform_col[4]), float(occ_transform_col[5]), float(occ_transform_col[6]),
            float(occ_transform_col[8]), float(occ_transform_col[9]), float(occ_transform_col[10]),
        )
    else:
        r_occ = ident3

    req = str(requested_up or "auto").lower()
    if req == "auto":
        m_col = _mat3_mul(_mat3_mul(u_doc, r_occ), u_doc_inv)
    elif req == "x+90":
        base = _mat3_mul(_mat3_mul(u_doc, r_occ), u_doc_inv)
        m_col = _mat3_mul(u_z_inv, base)
    elif req == "x-90":
        base = _mat3_mul(_mat3_mul(u_doc, r_occ), u_doc_inv)
        m_col = _mat3_mul(u_z, base)
    else:
        u_req = ident3 if req == "y" else u_z
        m_col = _mat3_mul(_mat3_mul(u_req, r_occ), u_doc_inv)

    # Transpose 3x3 column-vector matrix to USD row-vector 4x4 matrix
    return (
        m_col[0], m_col[3], m_col[6], 0.0,
        m_col[1], m_col[4], m_col[7], 0.0,
        m_col[2], m_col[5], m_col[8], 0.0,
        0.0, 0.0, 0.0, 1.0,
    )


def parse_usda_to_mesh_groups(usda_path, min_diag_m=0.0, post_transform_row=None, progress_cb=None):
    """Parse Fusion 360 native USD ASCII (.usda) into glTF-ready mesh groups.

    Bypasses Fusion 2706's Python Appearance ID collision ('PrismOpaque') by reading
    real UsdPreviewSurface PBR materials and per-face GeomSubset bindings directly.
    When min_diag_m > 0, skips sub-millimeter PCB silkscreen / SMD micro-bodies unless
    they carry a live DOCKYARD role tag.
    """
    meters_per_unit = 0.001
    up_axis = "Y"
    materials = {}
    prototypes = {}   # proto_name -> {body_name: mesh_dict}
    instances = []    # list of {name, proto, mat, bindings: {body_name: {default, subsets: {sub: mat}}}}
    inline_meshes = []
    skipped_micro = 0

    stack = []  # list of (kind, name, ctx_dict)
    pending_header = None  # (kind, name, ref_proto)

    with open(usda_path, "r", encoding="utf-8", errors="ignore") as fh:
        for raw_line in fh:
            s = raw_line.strip()
            if not s or s.startswith("#"):
                continue

            if not stack:
                if s.startswith("metersPerUnit"):
                    m = _NUM_RE.search(s)
                    if m:
                        meters_per_unit = float(m.group(0))
                    continue
                if s.startswith("upAxis"):
                    qm = _QUOTED_RE.search(s)
                    if qm:
                        up_axis = qm.group(1).upper()
                    continue

            # Track pending prim headers spanning multiple lines before '{'
            if pending_header is not None:
                if "references" in s:
                    rm = _REF_PATH_RE.search(s)
                    if rm:
                        pending_header[2] = rm.group(1).split("/")[-1]
                if "{" in s:
                    kind, name, ref_proto = pending_header
                    pending_header = None
                    ctx = {}
                    if kind == "material":
                        ctx = materials.setdefault(
                            name,
                            {
                                "name": name,
                                "diffuse": (0.18, 0.21, 0.24),
                                "metallic": 0.12,
                                "roughness": 0.54,
                                "opacity": 1.0,
                            },
                        )
                    elif kind == "instance":
                        ctx = {
                            "name": name,
                            "proto": ref_proto,
                            "transform": _IDENTITY_MAT4,
                            "default_mat": None,
                            "bindings": {},
                        }
                        if ref_proto:
                            instances.append(ctx)
                    elif kind == "proto":
                        ctx = prototypes.setdefault(name, {})
                    elif kind == "mesh":
                        ctx = {
                            "name": name,
                            "points": [],
                            "normals": [],
                            "faceVertexCounts": [],
                            "faceVertexIndices": [],
                            "extent_diag": None,
                            "transform": _IDENTITY_MAT4,
                            "subsets": {},
                            "default_mat": None,
                        }
                        parent_kind, parent_name, parent_ctx = stack[-1] if stack else (None, None, None)
                        if parent_kind == "proto":
                            parent_ctx[name] = ctx
                        else:
                            inst_mat = parent_ctx.get("transform", _IDENTITY_MAT4) if isinstance(parent_ctx, dict) else _IDENTITY_MAT4
                            inline_meshes.append((parent_name or name, inst_mat, ctx))
                    elif kind == "subset":
                        ctx = {"name": name, "indices": []}
                        if stack and stack[-1][0] == "mesh":
                            stack[-1][2]["subsets"][name] = ctx
                    elif kind == "over_body":
                        if stack and stack[-1][0] == "instance":
                            ctx = stack[-1][2]["bindings"].setdefault(name, {"default": None, "subsets": {}})
                    elif kind == "over_subset":
                        if stack and stack[-1][0] == "over_body":
                            ctx = {"body_binding": stack[-1][2], "subset_name": name}
                    stack.append((kind, name, ctx))
                    if "}" in s:
                        stack.pop()
                continue

            # Detect start of new prim blocks
            if s.startswith("def Material "):
                qm = _QUOTED_RE.search(s)
                mname = qm.group(1) if qm else "mat"
                pending_header = ["material", mname, None]
            elif s.startswith("over Xform "):
                qm = _QUOTED_RE.search(s)
                pname = qm.group(1) if qm else "proto"
                pending_header = ["proto", pname, None]
            elif s.startswith("def Xform "):
                qm = _QUOTED_RE.search(s)
                xname = qm.group(1) if qm else "xform"
                if not stack:
                    pending_header = ["root", xname, None]
                else:
                    rm = _REF_PATH_RE.search(s)
                    ref_p = rm.group(1).split("/")[-1] if rm else None
                    pending_header = ["instance", xname, ref_p]
            elif s.startswith("def Mesh "):
                qm = _QUOTED_RE.search(s)
                bname = qm.group(1) if qm else "Body"
                pending_header = ["mesh", bname, None]
            elif s.startswith("def GeomSubset "):
                qm = _QUOTED_RE.search(s)
                sname = qm.group(1) if qm else "subset"
                pending_header = ["subset", sname, None]
            elif s.startswith("def Shader "):
                qm = _QUOTED_RE.search(s)
                pending_header = ["shader", qm.group(1) if qm else "shader", None]
            elif s.startswith("over "):
                qm = _QUOTED_RE.search(s)
                oname = qm.group(1) if qm else "over"
                parent_kind = stack[-1][0] if stack else None
                if parent_kind == "instance":
                    pending_header = ["over_body", oname, None]
                elif parent_kind == "over_body":
                    pending_header = ["over_subset", oname, None]
                else:
                    pending_header = ["other", oname, None]
            elif s.startswith("def "):
                pending_header = ["other", "", None]

            if pending_header is not None:
                if "{" in s:
                    # Inline opening brace on same line
                    kind, name, ref_proto = pending_header
                    pending_header = None
                    ctx = {}
                    if kind == "material":
                        ctx = materials.setdefault(
                            name,
                            {
                                "name": name,
                                "diffuse": (0.18, 0.21, 0.24),
                                "metallic": 0.12,
                                "roughness": 0.54,
                                "opacity": 1.0,
                            },
                        )
                    elif kind == "instance":
                        ctx = {
                            "name": name,
                            "proto": ref_proto,
                            "transform": _IDENTITY_MAT4,
                            "default_mat": None,
                            "bindings": {},
                        }
                        if ref_proto:
                            instances.append(ctx)
                    elif kind == "proto":
                        ctx = prototypes.setdefault(name, {})
                    elif kind == "mesh":
                        ctx = {
                            "name": name,
                            "points": [],
                            "normals": [],
                            "faceVertexCounts": [],
                            "faceVertexIndices": [],
                            "extent_diag": None,
                            "transform": _IDENTITY_MAT4,
                            "subsets": {},
                            "default_mat": None,
                        }
                        parent_kind, parent_name, parent_ctx = stack[-1] if stack else (None, None, None)
                        if parent_kind == "proto":
                            parent_ctx[name] = ctx
                        else:
                            inst_mat = parent_ctx.get("transform", _IDENTITY_MAT4) if isinstance(parent_ctx, dict) else _IDENTITY_MAT4
                            inline_meshes.append((parent_name or name, inst_mat, ctx))
                    elif kind == "subset":
                        ctx = {"name": name, "indices": []}
                        if stack and stack[-1][0] == "mesh":
                            stack[-1][2]["subsets"][name] = ctx
                    elif kind == "over_body" and stack and stack[-1][0] == "instance":
                        ctx = stack[-1][2]["bindings"].setdefault(name, {"default": None, "subsets": {}})
                    elif kind == "over_subset" and stack and stack[-1][0] == "over_body":
                        ctx = {"body_binding": stack[-1][2], "subset_name": name}
                    stack.append((kind, name, ctx))
                    if "}" in s:
                        stack.pop()
                continue

            if s == "}" or s.endswith("}"):
                if stack:
                    stack.pop()
                continue

            if not stack:
                continue

            top_kind, top_name, top_ctx = stack[-1]

            # Parse Shader properties into enclosing Material
            if top_kind == "shader" and len(stack) >= 2 and stack[-2][0] == "material":
                mat_ctx = stack[-2][2]
                if s.startswith("color3f inputs:diffuseColor ="):
                    nums = _NUM_RE.findall(s.split("=", 1)[1])
                    if len(nums) >= 3:
                        mat_ctx["diffuse"] = (
                            _srgb_float_to_linear(nums[0]),
                            _srgb_float_to_linear(nums[1]),
                            _srgb_float_to_linear(nums[2]),
                        )
                elif s.startswith("float inputs:metallic ="):
                    m = _NUM_RE.search(s.split("=", 1)[1])
                    if m:
                        mat_ctx["metallic"] = max(0.0, min(0.85, float(m.group(0))))
                elif s.startswith("float inputs:roughness ="):
                    m = _NUM_RE.search(s.split("=", 1)[1])
                    if m:
                        mat_ctx["roughness"] = max(0.22, min(0.92, float(m.group(0))))
                elif s.startswith("float inputs:opacity ="):
                    m = _NUM_RE.search(s.split("=", 1)[1])
                    if m:
                        mat_ctx["opacity"] = max(0.0, min(1.0, float(m.group(0))))
            elif top_kind == "instance":
                if s.startswith("matrix4d xformOp:transform ="):
                    top_ctx["transform"] = _parse_usda_matrix(s.split("=", 1)[1])
                elif s.startswith("rel material:binding ="):
                    rm = _REF_PATH_RE.search(s)
                    if rm:
                        top_ctx["default_mat"] = rm.group(1).split("/")[-1]
            elif top_kind == "over_body":
                if s.startswith("rel material:binding ="):
                    rm = _REF_PATH_RE.search(s)
                    if rm:
                        top_ctx["default"] = rm.group(1).split("/")[-1]
            elif top_kind == "over_subset":
                if s.startswith("rel material:binding ="):
                    rm = _REF_PATH_RE.search(s)
                    if rm:
                        top_ctx["body_binding"]["subsets"][top_ctx["subset_name"]] = rm.group(1).split("/")[-1]
            elif top_kind == "mesh":
                if s.startswith("float3[] extent ="):
                    nums = _parse_bracket_floats(s)
                    if len(nums) >= 6:
                        dx, dy, dz = nums[3] - nums[0], nums[4] - nums[1], nums[5] - nums[2]
                        top_ctx["extent_diag"] = math.sqrt(dx * dx + dy * dy + dz * dz)
                elif s.startswith("point3f[] points ="):
                    top_ctx["points"] = _parse_bracket_floats(s)
                elif s.startswith("normal3f[] normals ="):
                    top_ctx["normals"] = _parse_bracket_floats(s)
                elif s.startswith("int[] faceVertexCounts ="):
                    top_ctx["faceVertexCounts"] = _parse_bracket_ints(s)
                elif s.startswith("int[] faceVertexIndices ="):
                    top_ctx["faceVertexIndices"] = _parse_bracket_ints(s)
                elif s.startswith("matrix4d xformOp:transform ="):
                    top_ctx["transform"] = _parse_usda_matrix(s.split("=", 1)[1])
                elif s.startswith("rel material:binding ="):
                    rm = _REF_PATH_RE.search(s)
                    if rm:
                        top_ctx["default_mat"] = rm.group(1).split("/")[-1]
            elif top_kind == "subset":
                if s.startswith("int[] indices ="):
                    top_ctx["indices"] = _parse_bracket_ints(s)

    # Assemble all instances + inline meshes into PBR-grouped glTF buffers
    grouped = {}
    seen_mats = {}
    total_tris = 0
    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")
    z_up = up_axis == "Z"

    def resolve_mat_props(mat_name):
        m = materials.get(mat_name) if mat_name else None
        if not m:
            return (0.18, 0.21, 0.24, 1.0), 0.12, 0.54
        r, g, b = m["diffuse"]
        op = m["opacity"]
        metallic = round(m["metallic"], 2)
        roughness = round(m["roughness"], 2)
        if is_transparent_appearance(mat_name):
            low_name = str(mat_name or "").lower()
            is_tinted = any(k in low_name for k in ("heavy", "smoke", "tint", "dark", "bronze", "grey", "gray"))
            alpha = 0.15 if is_tinted else 0.07
            r, g, b = (0.14, 0.20, 0.24) if is_tinted else (0.24, 0.36, 0.44)
            metallic = 0.05
            roughness = 0.08
        elif op < 0.99:
            alpha = max(0.08, min(0.85, op))
            roughness = min(roughness, 0.18)
        else:
            alpha = 1.0
        rgba = (round(r, 4), round(g, 4), round(b, 4), round(alpha, 3))
        if mat_name and len(seen_mats) < 60 and mat_name not in seen_mats:
            seen_mats[mat_name] = [round(c, 3) for c in rgba]
        return rgba, metallic, roughness

    def emit_mesh(inst_name, inst_transform, body_name, mesh_dict, body_binding, inst_default_mat=None):
        nonlocal total_tris, skipped_micro, min_x, max_x, min_y, max_y, min_z, max_z
        pts = mesh_dict["points"]
        fv_idx = mesh_dict["faceVertexIndices"]
        if not pts or not fv_idx:
            return

        # Compute composed transform + normal matrix
        m_total = _mat4_mul_row(mesh_dict["transform"], inst_transform)
        if post_transform_row is not None:
            m_total = _mat4_mul_row(m_total, post_transform_row)

        # Skip sub-millimeter PCB silkscreen / SMD micro-parts when micro-filtering is enabled
        if min_diag_m > 0.0 and mesh_dict["extent_diag"] is not None:
            sx = math.sqrt(m_total[0] ** 2 + m_total[1] ** 2 + m_total[2] ** 2)
            sy = math.sqrt(m_total[4] ** 2 + m_total[5] ** 2 + m_total[6] ** 2)
            sz = math.sqrt(m_total[8] ** 2 + m_total[9] ** 2 + m_total[10] ** 2)
            world_diag = mesh_dict["extent_diag"] * max(sx, sy, sz) * meters_per_unit
            if world_diag < min_diag_m:
                mat_candidates = [
                    (body_binding.get("default") if body_binding else None) or "",
                    inst_default_mat or "",
                    mesh_dict.get("default_mat") or "",
                ]
                if body_binding and body_binding.get("subsets"):
                    mat_candidates.extend(body_binding["subsets"].values())
                has_live_role = any(detect_dockyard_role(f"{inst_name} {body_name}", m or "") for m in mat_candidates)
                if not has_live_role:
                    skipped_micro += 1
                    return

        fv_counts = mesh_dict["faceVertexCounts"]
        norms = mesh_dict["normals"]
        has_vnorm = len(norms) == len(pts)

        # Build per-face triangle list [(i0, i1, i2), ...] grouped by face index
        all_tris = []
        face_tri_ranges = []
        if not fv_counts or (len(fv_counts) * 3 == len(fv_idx) and all(c == 3 for c in fv_counts)):
            n_faces = len(fv_idx) // 3
            for f_i in range(n_faces):
                k = f_i * 3
                all_tris.append((fv_idx[k], fv_idx[k + 1], fv_idx[k + 2]))
                face_tri_ranges.append((f_i, f_i + 1))
        else:
            cursor = 0
            for c in fv_counts:
                start_t = len(all_tris)
                if c >= 3 and cursor + c <= len(fv_idx):
                    v0 = fv_idx[cursor]
                    for j in range(1, c - 1):
                        all_tris.append((v0, fv_idx[cursor + j], fv_idx[cursor + j + 1]))
                cursor += c
                face_tri_ranges.append((start_t, len(all_tris)))

        if not all_tris:
            return

        cof, det = _mat3_cofactor_and_det(m_total)
        flip_winding = det < 0.0
        n_sign = -1.0 if flip_winding else 1.0
        scale = meters_per_unit

        # Transform all vertices ONCE for this instance
        m00, m01, m02 = m_total[0] * scale, m_total[1] * scale, m_total[2] * scale
        m10, m11, m12 = m_total[4] * scale, m_total[5] * scale, m_total[6] * scale
        m20, m21, m22 = m_total[8] * scale, m_total[9] * scale, m_total[10] * scale
        tx, ty, tz = m_total[12] * scale, m_total[13] * scale, m_total[14] * scale

        c00, c01, c02, c10, c11, c12, c20, c21, c22 = cof
        n_verts = len(pts) // 3
        wpos = [0.0] * len(pts)
        wnorm = [0.0] * len(pts)
        for vi in range(n_verts):
            k = vi * 3
            x, y, z = pts[k], pts[k + 1], pts[k + 2]
            wx = x * m00 + y * m10 + z * m20 + tx
            wy = x * m01 + y * m11 + z * m21 + ty
            wz = x * m02 + y * m12 + z * m22 + tz
            if z_up:
                gx, gy, gz = wx, wz, -wy
            else:
                gx, gy, gz = wx, wy, wz
            wpos[k] = gx
            wpos[k + 1] = gy
            wpos[k + 2] = gz
            if gx < min_x:
                min_x = gx
            if gx > max_x:
                max_x = gx
            if gy < min_y:
                min_y = gy
            if gy > max_y:
                max_y = gy
            if gz < min_z:
                min_z = gz
            if gz > max_z:
                max_z = gz

            if has_vnorm:
                nx, ny, nz = norms[k], norms[k + 1], norms[k + 2]
                rx = (nx * c00 + ny * c10 + nz * c20) * n_sign
                ry = (nx * c01 + ny * c11 + nz * c21) * n_sign
                rz = (nx * c02 + ny * c12 + nz * c22) * n_sign
                if z_up:
                    gnx, gny, gnz = rx, rz, -ry
                else:
                    gnx, gny, gnz = rx, ry, rz
                nlen = math.sqrt(gnx * gnx + gny * gny + gnz * gnz) or 1.0
                wnorm[k] = gnx / nlen
                wnorm[k + 1] = gny / nlen
                wnorm[k + 2] = gnz / nlen
            else:
                wnorm[k + 1] = 1.0

        # Resolve per-face material bindings (supports GeomSubset multi-color STEP parts
        # AND Fusion's instance-level rel material:binding on def Xform "MeshInstance_*")
        default_mat = (
            (body_binding.get("default") if body_binding else None)
            or inst_default_mat
            or mesh_dict.get("default_mat")
        )
        sub_bindings = body_binding.get("subsets", {}) if body_binding else {}
        subsets = mesh_dict.get("subsets") or {}

        # Map each triangle to its effective material name
        tri_mats = [default_mat] * len(all_tris)
        if subsets and sub_bindings:
            n_faces = len(face_tri_ranges)
            for sname, sdict in subsets.items():
                smat = sub_bindings.get(sname)
                if not smat:
                    continue
                for f_i in sdict.get("indices") or ():
                    if 0 <= f_i < n_faces:
                        t_start, t_end = face_tri_ranges[f_i]
                        for ti in range(t_start, t_end):
                            tri_mats[ti] = smat

        # Group triangles by effective material name
        by_mat = {}
        for ti, mat_name in enumerate(tri_mats):
            by_mat.setdefault(mat_name, []).append(all_tris[ti])

        single_mat = len(by_mat) == 1
        for mat_name, tris in by_mat.items():
            rgba, metallic, roughness = resolve_mat_props(mat_name)
            role = detect_dockyard_role(f"{inst_name} {body_name}", mat_name or "")
            color_key = (
                _quantize_linear_channel(rgba[0]),
                _quantize_linear_channel(rgba[1]),
                _quantize_linear_channel(rgba[2]),
                round(rgba[3], 2),
            )
            pbr_key = (round(metallic * 4.0) / 4.0, round(roughness * 4.0) / 4.0)
            group_key = (role, color_key, pbr_key)

            grp = grouped.setdefault(
                group_key,
                {
                    "role": role,
                    "color": list(rgba),
                    "metallic": metallic,
                    "roughness": roughness,
                    "positions": [],
                    "normals": [],
                    "indices": [],
                },
            )
            gpos = grp["positions"]
            gnorm = grp["normals"]
            gidx = grp["indices"]

            if single_mat:
                base = len(gpos) // 3
                gpos.extend(wpos)
                gnorm.extend(wnorm)
                if flip_winding:
                    for i0, i1, i2 in tris:
                        gidx.extend((base + i0, base + i2, base + i1))
                else:
                    for i0, i1, i2 in tris:
                        gidx.extend((base + i0, base + i1, base + i2))
            else:
                vmap = {}
                next_v = len(gpos) // 3
                for i0, i1, i2 in tris:
                    tri_vs = (i0, i2, i1) if flip_winding else (i0, i1, i2)
                    for vi in tri_vs:
                        mapped = vmap.get(vi)
                        if mapped is None:
                            mapped = next_v
                            next_v += 1
                            vmap[vi] = mapped
                            k = vi * 3
                            gpos.extend((wpos[k], wpos[k + 1], wpos[k + 2]))
                            gnorm.extend((wnorm[k], wnorm[k + 1], wnorm[k + 2]))
                        gidx.append(mapped)
            total_tris += len(tris)

    total_items = len(instances) + len(inline_meshes)
    for idx_i, inst in enumerate(instances):
        if progress_cb and idx_i % 50 == 0:
            progress_cb(idx_i, total_items)
        proto_bodies = prototypes.get(inst["proto"])
        if not proto_bodies:
            continue
        inst_bindings = inst["bindings"]
        inst_default = inst.get("default_mat")
        for bname, mesh_dict in proto_bodies.items():
            emit_mesh(inst["name"], inst["transform"], bname, mesh_dict, inst_bindings.get(bname), inst_default)

    for inst_name, inst_mat, mesh_dict in inline_meshes:
        emit_mesh(inst_name, inst_mat, mesh_dict["name"], mesh_dict, None)

    if not grouped:
        return [], 0, seen_mats, skipped_micro

    mesh_groups = _finalize_grouped_meshes(grouped, min_x, max_x, min_y, max_y, min_z, max_z)
    return mesh_groups, total_tris, seen_mats, skipped_micro


def convert_usdz_to_mesh_groups(usdz_path, min_diag_m=0.0, post_transform_row=None, progress_cb=None):
    """Extract a Fusion USDZ archive, decode .usdc via usdcat if needed, and return GLB mesh groups."""
    with tempfile.TemporaryDirectory(prefix="dockyard_usd_") as tmpdir:
        usda_file = None
        usdc_file = None
        with zipfile.ZipFile(usdz_path, "r") as zf:
            for member in zf.namelist():
                low = member.lower()
                if low.endswith(".usda"):
                    usda_file = zf.extract(member, tmpdir)
                    break
                if low.endswith(".usdc") or low.endswith(".usd"):
                    usdc_file = zf.extract(member, tmpdir)

        if not usda_file:
            if not usdc_file:
                raise ValueError("USDZ-Archiv enthält keine USD-Szene.")
            usdcat = _find_usdcat()
            if not usdcat:
                raise RuntimeError("usdcat ist auf diesem System nicht verfügbar.")
            usda_file = os.path.join(tmpdir, "scene.usda")
            subprocess.run([usdcat, usdc_file, "-o", usda_file], check=True)

        return parse_usda_to_mesh_groups(
            usda_file,
            min_diag_m=min_diag_m,
            post_transform_row=post_transform_row,
            progress_cb=progress_cb,
        )


def _parse_hex_rgba(hex_str):
    raw = str(hex_str or "").strip().lstrip("#")
    if len(raw) == 6:
        r, g, b, a = int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16), 255
    elif len(raw) == 8:
        r, g, b, a = int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16), int(raw[6:8], 16)
    else:
        return (0.18, 0.21, 0.24, 1.0)
    alpha = round(a / 255.0, 3) if a < 252 else 1.0
    return (_srgb_byte_to_linear(r), _srgb_byte_to_linear(g), _srgb_byte_to_linear(b), alpha)


def _parse_3mf_transform(attr):
    if not attr:
        return _IDENTITY_MAT4
    nums = [float(x) for x in str(attr).split()]
    if len(nums) != 12:
        return _IDENTITY_MAT4
    # 3MF transform is 4x3 row-major: m00 m01 m02  m10 m11 m12  m20 m21 m22  m30 m31 m32
    return (
        nums[0], nums[1], nums[2], 0.0,
        nums[3], nums[4], nums[5], 0.0,
        nums[6], nums[7], nums[8], 0.0,
        nums[9], nums[10], nums[11], 1.0,
    )


def parse_3mf_to_mesh_groups(tmf_path, up_axis="z"):
    """Parse Fusion 360 native 3MF (.3mf) with per-object/per-triangle colors into glTF mesh groups.

    Pure Python stdlib (zipfile + ElementTree) — works identically on macOS and Windows.
    """
    unit_scale = {"micron": 1e-6, "millimeter": 0.001, "centimeter": 0.01, "inch": 0.0254, "foot": 0.3048, "meter": 1.0}
    color_tables = {}  # resource_id -> list of linear rgba tuples
    objects = {}       # object_id -> {name, pid, pindex, verts, tris, components}
    build_items = []
    scale = 0.001

    with zipfile.ZipFile(tmf_path, "r") as zf:
        model_files = [n for n in zf.namelist() if n.lower().endswith(".model")]
        if not model_files:
            raise ValueError("3MF-Archiv enthält keine .model-Datei.")
        root = ET.fromstring(zf.read(model_files[0]))

    scale = unit_scale.get(str(root.attrib.get("unit", "millimeter")).lower(), 0.001)

    def local_tag(el):
        return el.tag.rsplit("}", 1)[-1].lower()

    for elem in root.iter():
        tag = local_tag(elem)
        if tag == "colorgroup":
            cid = elem.attrib.get("id")
            if cid:
                color_tables[cid] = [_parse_hex_rgba(c.attrib.get("color")) for c in elem if local_tag(c) == "color"]
        elif tag == "basematerials":
            cid = elem.attrib.get("id")
            if cid:
                color_tables[cid] = [_parse_hex_rgba(c.attrib.get("displaycolor")) for c in elem if local_tag(c) == "base"]
        elif tag == "object":
            oid = elem.attrib.get("id")
            if not oid:
                continue
            obj = {
                "name": elem.attrib.get("name", f"obj_{oid}"),
                "pid": elem.attrib.get("pid"),
                "pindex": int(elem.attrib["pindex"]) if "pindex" in elem.attrib else 0,
                "verts": [],
                "tris": [],
                "components": [],
            }
            for child in elem:
                ctag = local_tag(child)
                if ctag == "mesh":
                    for mchild in child:
                        mtag = local_tag(mchild)
                        if mtag == "vertices":
                            for v in mchild:
                                obj["verts"].extend((float(v.attrib["x"]), float(v.attrib["y"]), float(v.attrib["z"])))
                        elif mtag == "triangles":
                            for t in mchild:
                                obj["tris"].append(
                                    (
                                        int(t.attrib["v1"]),
                                        int(t.attrib["v2"]),
                                        int(t.attrib["v3"]),
                                        t.attrib.get("pid"),
                                        int(t.attrib["p1"]) if "p1" in t.attrib else None,
                                    )
                                )
                elif ctag == "components":
                    for comp in child:
                        if local_tag(comp) == "component":
                            obj["components"].append(
                                (comp.attrib.get("objectid"), _parse_3mf_transform(comp.attrib.get("transform")))
                            )
            objects[oid] = obj
        elif tag == "build":
            for item in elem:
                if local_tag(item) == "item":
                    build_items.append((item.attrib.get("objectid"), _parse_3mf_transform(item.attrib.get("transform"))))

    if not build_items:
        build_items = [(oid, _IDENTITY_MAT4) for oid, obj in objects.items() if obj["tris"]]

    grouped = {}
    total_tris = 0
    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")

    def resolve_3mf_rgba(pid, pindex):
        tbl = color_tables.get(pid)
        if tbl and pindex is not None and 0 <= pindex < len(tbl):
            return tbl[pindex]
        return (0.18, 0.21, 0.24, 1.0)

    def emit_obj(oid, mat, inherited_pid=None, inherited_pindex=0, depth=0):
        nonlocal total_tris, min_x, max_x, min_y, max_y, min_z, max_z
        if depth > 16:
            return
        obj = objects.get(oid)
        if not obj:
            return
        eff_pid = obj["pid"] or inherited_pid
        eff_pindex = obj["pindex"] if obj["pid"] else inherited_pindex

        for child_id, child_mat in obj["components"]:
            emit_obj(child_id, _mat4_mul_row(child_mat, mat), eff_pid, eff_pindex, depth + 1)

        verts = obj["verts"]
        tris = obj["tris"]
        if not verts or not tris:
            return

        _, det = _mat3_cofactor_and_det(mat)
        flip = det < 0.0
        m00, m01, m02 = mat[0] * scale, mat[1] * scale, mat[2] * scale
        m10, m11, m12 = mat[4] * scale, mat[5] * scale, mat[6] * scale
        m20, m21, m22 = mat[8] * scale, mat[9] * scale, mat[10] * scale
        tx, ty, tz = mat[12] * scale, mat[13] * scale, mat[14] * scale

        wpos = [0.0] * len(verts)
        for vi in range(len(verts) // 3):
            k = vi * 3
            x, y, z = verts[k], verts[k + 1], verts[k + 2]
            wx = x * m00 + y * m10 + z * m20 + tx
            wy = x * m01 + y * m11 + z * m21 + ty
            wz = x * m02 + y * m12 + z * m22 + tz
            # Convert 3MF coordinates to glTF Y-up according to requested up_axis
            if str(up_axis or "z").lower() == "y":
                gx, gy, gz = wx, wy, wz
            else:
                gx, gy, gz = wx, wz, -wy
            wpos[k], wpos[k + 1], wpos[k + 2] = gx, gy, gz
            if gx < min_x:
                min_x = gx
            if gx > max_x:
                max_x = gx
            if gy < min_y:
                min_y = gy
            if gy > max_y:
                max_y = gy
            if gz < min_z:
                min_z = gz
            if gz > max_z:
                max_z = gz

        role = detect_dockyard_role(obj["name"])
        for v1, v2, v3, t_pid, t_p1 in tris:
            rgba = resolve_3mf_rgba(t_pid or eff_pid, t_p1 if t_pid else eff_pindex)
            color_key = tuple(round(c, 2) for c in rgba)
            group_key = (role, color_key)
            grp = grouped.setdefault(
                group_key,
                {
                    "role": role,
                    "color": list(rgba),
                    "metallic": 0.14,
                    "roughness": 0.52,
                    "positions": [],
                    "normals": [],
                    "indices": [],
                },
            )
            a_i, b_i, c_i = (v1, v3, v2) if flip else (v1, v2, v3)
            ax, ay, az = wpos[a_i * 3], wpos[a_i * 3 + 1], wpos[a_i * 3 + 2]
            bx, by, bz = wpos[b_i * 3], wpos[b_i * 3 + 1], wpos[b_i * 3 + 2]
            cx_v, cy_v, cz_v = wpos[c_i * 3], wpos[c_i * 3 + 1], wpos[c_i * 3 + 2]
            ux, uy, uz = bx - ax, by - ay, bz - az
            vx, vy, vz = cx_v - ax, cy_v - ay, cz_v - az
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            nlen = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            nx, ny, nz = nx / nlen, ny / nlen, nz / nlen
            base = len(grp["positions"]) // 3
            grp["positions"].extend((ax, ay, az, bx, by, bz, cx_v, cy_v, cz_v))
            grp["normals"].extend((nx, ny, nz, nx, ny, nz, nx, ny, nz))
            grp["indices"].extend((base, base + 1, base + 2))
            total_tris += 1

    for oid, mat in build_items:
        emit_obj(oid, mat)

    if not grouped:
        return [], 0

    return _finalize_grouped_meshes(grouped, min_x, max_x, min_y, max_y, min_z, max_z), total_tris


def _safe_body_key(body, fallback=""):
    """Return a stable cache/dedup key even for externally linked XRef bodies."""
    try:
        token = body.entityToken
        if token:
            return ("tok", token)
    except Exception:
        pass
    try:
        parent = getattr(body, "parentComponent", None)
        comp_id = getattr(parent, "id", "") or ""
        vol = round(float(getattr(body, "volume", 0.0) or 0.0), 6)
        area = round(float(getattr(body, "area", 0.0) or 0.0), 6)
        name = getattr(body, "name", "") or ""
        if comp_id and vol > 0.0:
            return ("xref", comp_id, name, vol, area)
    except Exception:
        pass
    return ("obj", fallback, id(body))


def _safe_native(body):
    try:
        native = getattr(body, "nativeObject", None)
        if native is not None:
            return native
    except Exception:
        pass
    return body


def _safe_full_path(occ):
    try:
        full = getattr(occ, "fullPathName", None)
        if full:
            return full
    except Exception:
        pass
    return getattr(occ, "name", "") or ""


def _safe_transform_array(occ):
    if occ is None:
        return None
    for attr in ("transform2", "transform"):
        try:
            tr = getattr(occ, attr, None)
            if tr is not None:
                return tr.asArray()
        except Exception:
            pass
    return None


def infer_color_from_appearance_name(app_name):
    """Fallback linear RGBA for texture-driven Autodesk library appearances whose scalar RGB is white."""
    lower = str(app_name or "").lower()
    if not lower:
        return None
    if is_transparent_appearance(lower):
        return (0.18, 0.28, 0.32, 0.14)
    if any(k in lower for k in ("white", "weiß", "weiss", "ivory", "snow")):
        return None
    if any(k in lower for k in ("black", "schwarz", "carbon", "ebony", "obsidian", "graphite", "anthrazit")):
        return (0.032, 0.035, 0.040, 1.0)
    if any(k in lower for k in ("lime", "neon green", "acid")):
        return (0.12, 0.88, 0.05, 1.0)
    if any(k in lower for k in ("green", "grün", "gruen")):
        return (0.05, 0.48, 0.08, 1.0)
    if any(k in lower for k in ("red", "rot", "crimson")):
        return (0.62, 0.05, 0.05, 1.0)
    if any(k in lower for k in ("blue", "blau", "cobalt")):
        return (0.05, 0.20, 0.68, 1.0)
    if any(k in lower for k in ("gold", "brass", "messing", "bronze", "copper", "kupfer", "pei")):
        return (0.76, 0.48, 0.12, 1.0)
    if any(k in lower for k in ("orange", "amber")):
        return (0.82, 0.28, 0.03, 1.0)
    if any(k in lower for k in ("yellow", "gelb")):
        return (0.86, 0.72, 0.06, 1.0)
    if any(k in lower for k in ("grey", "gray", "grau", "titanium", "gunmetal")):
        return (0.18, 0.20, 0.22, 1.0)
    if any(k in lower for k in ("steel", "aluminum", "aluminium", "chrome", "chrom", "silver", "silber", "stainless", "nickel")):
        return (0.46, 0.49, 0.53, 1.0)
    return None


def _resolve_body_appearance(body, occ=None):
    """Resolve Fusion's effective appearance matching Fusion's viewport priority:
    explicit face override -> body.appearance (Fusion's C++ resolved appearance) -> occ -> native -> material."""
    # 1. Explicit face-level override (highest precedence in Fusion viewport)
    try:
        faces = getattr(body, "faces", None)
        if faces and faces.count > 0:
            face0 = faces.item(0)
            face_src = getattr(face0, "appearanceSourceType", None)
            if adsk is not None and face_src in (
                adsk.core.AppearanceSourceTypes.OverrideAppearanceSource,
                adsk.core.AppearanceSourceTypes.FaceAppearanceSource,
            ):
                face_app = getattr(face0, "appearance", None)
                if face_app is not None:
                    return face_app
    except Exception:
        pass

    # 2. Body proxy's own current appearance (Fusion resolves body/component/occurrence/material in C++)
    try:
        body_app = getattr(body, "appearance", None)
        if body_app is not None:
            return body_app
    except Exception:
        pass

    # 3. Direct occurrence override only if body.appearance was None
    if occ is not None:
        try:
            occ_app = getattr(occ, "appearance", None)
            if occ_app is not None:
                return occ_app
        except Exception:
            pass

    native = _safe_native(body)
    if native is not body:
        try:
            nat_app = getattr(native, "appearance", None)
            if nat_app is not None:
                return nat_app
        except Exception:
            pass

    if occ is not None:
        try:
            mat = getattr(getattr(occ, "component", None), "material", None)
            if mat is not None and getattr(mat, "appearance", None) is not None:
                return mat.appearance
        except Exception:
            pass
    return None


def _extract_appearance_rgba(body, occ=None, _unused_cache=None):
    default = (0.18, 0.21, 0.24, 1.0)
    try:
        appearance = _resolve_body_appearance(body, occ)
        if not appearance:
            return default, ""

        app_name = getattr(appearance, "name", "") or ""
        if is_transparent_appearance(app_name):
            return (0.18, 0.28, 0.32, 0.14), app_name

        # Prefer Fusion's native Appearance.color (handles opaque_albedo, metal_f0, and
        # transparent_color directly in C++). Note: in Fusion's adsk.core.Color, opacity == 0
        # on metals/opaque shaders means "default opaque", NEVER invisible!
        has_tex_app = bool(getattr(appearance, "hasTexture", False))
        try:
            direct_color = getattr(appearance, "color", None)
            if direct_color is not None and hasattr(direct_color, "red"):
                rgba = (
                    _srgb_byte_to_linear(direct_color.red),
                    _srgb_byte_to_linear(direct_color.green),
                    _srgb_byte_to_linear(direct_color.blue),
                    1.0,
                )
                is_pure_white = direct_color.red >= 252 and direct_color.green >= 252 and direct_color.blue >= 252
                if has_tex_app and is_pure_white:
                    inferred = infer_color_from_appearance_name(app_name)
                    if inferred is not None:
                        return inferred, app_name
                return rgba, app_name
        except Exception:
            pass

        props = getattr(appearance, "appearanceProperties", None)
        primary_props = []
        fallback_props = []
        seen_prop_ids = set()

        def push_prop(target_list, prop):
            if not prop:
                return
            cprop = adsk.core.ColorProperty.cast(prop) if adsk is not None else prop
            if not cprop or not getattr(cprop, "value", None):
                return
            pid = getattr(cprop, "id", None) or getattr(cprop, "name", None) or id(cprop)
            if pid in seen_prop_ids:
                return
            seen_prop_ids.add(pid)
            target_list.append(cprop)

        if props is not None:
            for prop_id in (
                "opaque_albedo",
                "metal_f0",
                "surface_albedo",
                "layered_diffuse",
                "prism_opaque",
                "generic_diffuse",
                "plastic_color",
                "paint_color",
                "transparent_color",
                "glazing_transmittance",
            ):
                try:
                    push_prop(primary_props, props.itemById(prop_id))
                except Exception:
                    pass
            if not primary_props:
                try:
                    for prop in props:
                        if adsk is None or isinstance(prop, adsk.core.ColorProperty):
                            push_prop(fallback_props, prop)
                except Exception:
                    pass

        candidates = primary_props or fallback_props
        rgba = None
        from_texture_only = False
        for cprop in candidates:
            c = cprop.value
            cand = (_srgb_byte_to_linear(c.red), _srgb_byte_to_linear(c.green), _srgb_byte_to_linear(c.blue), 1.0)
            has_tex = bool(getattr(cprop, "hasConnectedTexture", False))
            if not has_tex:
                rgba = cand
                from_texture_only = False
                break
            if rgba is None:
                rgba = cand
                from_texture_only = True

        if rgba is None or from_texture_only:
            inferred = infer_color_from_appearance_name(app_name)
            if inferred is not None:
                rgba = inferred
        if rgba is None:
            rgba = default

        return rgba, app_name
    except Exception:
        return default, ""


def _collect_target_bodies(design, slot, ui):
    targets = []  # list of (body, occ, transform_array, leaf_label, full_label)
    if slot == "toolhead" and ui.activeSelections.count > 0:
        seen = set()
        for i in range(ui.activeSelections.count):
            try:
                ent = ui.activeSelections.item(i).entity
            except Exception:
                continue
            if isinstance(ent, adsk.fusion.Occurrence):
                for sub in iter_visible_occurrences(ent):
                    mat = _safe_transform_array(sub)
                    full_path = _safe_full_path(sub)
                    try:
                        bodies = sub.bRepBodies
                    except Exception:
                        continue
                    for b in bodies:
                        try:
                            if not b.isVisible:
                                continue
                            bkey = (_safe_body_key(b), full_path)
                            if bkey in seen:
                                continue
                            seen.add(bkey)
                            targets.append((b, sub, mat, f"{sub.name} {b.name}", f"{full_path} {b.name}"))
                        except Exception:
                            continue
            elif isinstance(ent, adsk.fusion.BRepBody):
                try:
                    if not ent.isVisible:
                        continue
                    ctx = getattr(ent, "assemblyContext", None)
                    full_path = _safe_full_path(ctx) if ctx else ""
                    bkey = (_safe_body_key(ent), full_path)
                    if bkey in seen:
                        continue
                    seen.add(bkey)
                    mat = _safe_transform_array(ctx)
                    targets.append((ent, ctx, mat, ent.name, f"{full_path} {ent.name}".strip()))
                except Exception:
                    continue
        if targets:
            return targets

    root = design.rootComponent
    for b in root.bRepBodies:
        try:
            if b.isVisible:
                targets.append((b, None, None, b.name, b.name))
        except Exception:
            continue
    for occ in root.allOccurrences:
        try:
            if not occ.isVisible:
                continue
            if not occ.component.bRepBodies.count:
                continue
            mat = _safe_transform_array(occ)
            full_path = _safe_full_path(occ)
            for b in occ.bRepBodies:
                try:
                    if b.isVisible:
                        targets.append((b, occ, mat, f"{occ.name} {b.name}", f"{full_path} {b.name}"))
                except Exception:
                    continue
        except Exception:
            continue
    return targets


def _transform_point(m, x, y, z):
    if not m:
        return x, y, z
    return (
        m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11],
    )


def _transform_normal(m, nx, ny, nz, up_axis="z"):
    if m:
        rx = m[0] * nx + m[1] * ny + m[2] * nz
        ry = m[4] * nx + m[5] * ny + m[6] * nz
        rz = m[8] * nx + m[9] * ny + m[10] * nz
    else:
        rx, ry, rz = nx, ny, nz
    if str(up_axis or "z").lower() == "y":
        gx, gy, gz = rx, ry, rz
    else:
        gx, gy, gz = rx, rz, -ry
    length = math.sqrt(gx * gx + gy * gy + gz * gz) or 1.0
    return gx / length, gy / length, gz / length


def _detect_default_up_axis(app):
    try:
        orient = app.preferences.generalPreferences.defaultModelingOrientation
        if orient == adsk.core.DefaultModelingOrientations.YUpModelingOrientation:
            return "y"
    except Exception:
        pass
    return "z"


def _resolve_optimizer_cmd():
    hint = os.path.join(_ADDIN_DIR, ".dockyard-optimizer-path")
    try:
        if os.path.isfile(hint):
            p = open(hint, encoding="utf-8").read().strip()
            if p:
                return f'"{p}"'
    except Exception:
        pass
    return "./scripts/optimize-dockyard-glb.sh"


def _reveal_in_finder(path):
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
        elif sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    except Exception:
        pass


def _resolve_native_export_targets(design, slot, ui):
    """Select native ExportManager targets: (usd_component_or_None, usd_occ_transform_or_None, tmf_geometry_or_None)."""
    if slot == "printer":
        return design.rootComponent, None, design.rootComponent
    sel_count = ui.activeSelections.count
    if sel_count == 0:
        return design.rootComponent, None, design.rootComponent
    if sel_count == 1:
        try:
            ent = ui.activeSelections.item(0).entity
        except Exception:
            return None, None, None
        if isinstance(ent, adsk.fusion.Occurrence):
            return ent.component, _safe_transform_array(ent), ent
        if isinstance(ent, adsk.fusion.BRepBody):
            return None, None, ent
    return None, None, None


def _try_native_export(app, design, ui, slot, up_axis, quality_mode, skip_fasteners):
    """Try Fusion's native C++ USDZ / 3MF export engines before falling back to Python BRep traversal.

    Native C++ export reads materials directly from Fusion's Prism/MaterialX graphics engine,
    completely bypassing Fusion 2706's Python API Appearance ID collision ('PrismOpaque') and
    preserving per-face multi-color STEP parts (steppers, PCBs, fans) plus real PBR metallic/roughness.
    """
    usd_comp, usd_occ_transform, tmf_target = _resolve_native_export_targets(design, slot, ui)
    export_mgr = getattr(design, "exportManager", None)
    if export_mgr is None:
        return None

    min_diag_m = (0.0025 if slot == "printer" else 0.0008) if skip_fasteners else 0.0
    doc_up = _detect_default_up_axis(app)
    post_transform_row = _build_usd_post_transform_row(
        occ_transform_col=usd_occ_transform,
        doc_up=doc_up,
        requested_up=up_axis,
    )

    # 1. Preferred: Native USDZ -> GLB (full PBR metallic/roughness, glass opacity, per-face GeomSubsets)
    if usd_comp is not None and _find_usdcat():
        progress = ui.createProgressDialog()
        progress.isCancelButtonShown = False
        progress.show(_CMD_NAME, "Exportiere PBR-Szene nativ aus Fusion (USDZ) …", 0, 100, 0)
        adsk.doEvents()
        try:
            with tempfile.TemporaryDirectory(prefix="dockyard_usdz_") as tmpdir:
                tmp_usdz = os.path.join(tmpdir, "scene.usdz")
                usd_opts = export_mgr.createUSDExportOptions(tmp_usdz, usd_comp)
                if export_mgr.execute(usd_opts) and os.path.isfile(tmp_usdz):
                    progress.message = "Konvertiere PBR-Materialien & Geometrie nach GLB …"
                    progress.progressValue = 50
                    adsk.doEvents()

                    def on_progress(done, total):
                        if total > 0:
                            progress.progressValue = 50 + int(45 * done / total)
                            adsk.doEvents()

                    mesh_groups, total_tris, seen_mats, skipped_micro = convert_usdz_to_mesh_groups(
                        tmp_usdz,
                        min_diag_m=min_diag_m,
                        post_transform_row=post_transform_row,
                        progress_cb=on_progress,
                    )
                    if mesh_groups:
                        return mesh_groups, total_tris, skipped_micro, seen_mats, "Native USDZ PBR"
        except Exception:
            pass
        finally:
            progress.hide()

    # 2. Cross-platform fallback (Windows without usdcat, or single BRepBody): Native 3MF -> GLB
    if tmf_target is not None:
        progress = ui.createProgressDialog()
        progress.isCancelButtonShown = False
        progress.show(_CMD_NAME, "Exportiere Farben & Geometrie nativ aus Fusion (3MF) …", 0, 100, 0)
        adsk.doEvents()
        try:
            with tempfile.TemporaryDirectory(prefix="dockyard_3mf_") as tmpdir:
                tmp_3mf = os.path.join(tmpdir, "scene.3mf")
                tmf_opts = export_mgr.createC3MFExportOptions(tmf_target, tmp_3mf)
                tmf_opts.meshRefinement = (
                    adsk.fusion.MeshRefinementSettings.MeshRefinementMedium
                    if quality_mode == "detail"
                    else adsk.fusion.MeshRefinementSettings.MeshRefinementLow
                )
                if export_mgr.execute(tmf_opts) and os.path.isfile(tmp_3mf):
                    progress.message = "Konvertiere 3MF nach GLB …"
                    progress.progressValue = 65
                    adsk.doEvents()
                    mesh_groups, total_tris = parse_3mf_to_mesh_groups(
                        tmp_3mf,
                        up_axis=doc_up if str(up_axis or "auto").lower() == "auto" else ("y" if str(up_axis).lower() in ("y", "x+90") else "z"),
                    )
                    if mesh_groups:
                        return mesh_groups, total_tris, 0, {}, "Native 3MF"
        except Exception:
            pass
        finally:
            progress.hide()

    return None


def _execute_export(app, ui, slot, up_axis, quality_mode, skip_fasteners, out_dir, reveal_file):
    doc = app.activeDocument
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        ui.messageBox("Kein aktives Fusion-360-Design geöffnet.", _CMD_NAME)
        return

    mesh_groups = None
    total_tris = 0
    skipped = 0
    seen_appearances = {}
    engine_label = "BRep Mesh"

    native_result = _try_native_export(app, design, ui, slot, up_axis, quality_mode, skip_fasteners)
    if native_result is not None:
        mesh_groups, total_tris, skipped, seen_appearances, engine_label = native_result
    else:
        targets = _collect_target_bodies(design, slot, ui)
        if not targets:
            ui.messageBox("Keine sichtbaren Körper zum Exportieren gefunden.", _CMD_NAME)
            return

        quality_opt = (
            adsk.fusion.TriangleMeshQualityOptions.NormalQualityTriangleMesh
            if quality_mode == "detail"
            else adsk.fusion.TriangleMeshQualityOptions.LowQualityTriangleMesh
        )
        surface_tol = 0.02 if quality_mode == "detail" else 0.04

        grouped = {}
        mesh_cache = {}
        min_x = min_y = min_z = float("inf")
        max_x = max_y = max_z = float("-inf")
        cancelled = False

        progress = ui.createProgressDialog()
        progress.isCancelButtonShown = True
        progress.show(_CMD_NAME, "Verarbeite Körper %v von %m …", 0, len(targets), 0)

        brep_up = _detect_default_up_axis(app) if str(up_axis or "auto").lower() == "auto" else ("y" if str(up_axis).lower() in ("y", "x+90") else "z")
        try:
            for idx_body, (body, occ, mat, leaf_label, full_label) in enumerate(targets):
                if idx_body % 10 == 0:
                    progress.progressValue = idx_body
                    adsk.doEvents()
                    if progress.wasCancelled:
                        cancelled = True
                        break

                if skip_fasteners and should_skip_fastener(leaf_label):
                    skipped += 1
                    continue

                rgba, app_name = _extract_appearance_rgba(body, occ)
                if app_name and len(seen_appearances) < 50 and app_name not in seen_appearances:
                    seen_appearances[app_name] = [round(c, 3) for c in rgba]
                role = detect_dockyard_role(full_label, app_name)
                color_key = tuple(round(c, 2) for c in rgba)
                group_key = (role, color_key)

                # Use nativeObject + mesh_cache so component meshes stay in local space
                # and repeated parts (rails, extrusions, idlers) only tessellate once.
                # If an externally linked XRef body rejects native meshing, fall back
                # to meshing the proxy body directly in root world coordinates.
                native = _safe_native(body) if mat is not None else body
                use_mat = mat
                cache_key = _safe_body_key(native, full_label)
                cached = mesh_cache.get(cache_key)
                if cached is None:
                    try:
                        calc = native.meshManager.createMeshCalculator()
                        calc.setQuality(quality_opt)
                        calc.surfaceTolerance = surface_tol
                        tmesh = calc.calculate()
                        if not tmesh:
                            mesh_cache[cache_key] = False
                            skipped += 1
                            continue
                        cached = (
                            list(tmesh.nodeCoordinatesAsFloat),
                            list(tmesh.normalVectorsAsFloat),
                            list(tmesh.nodeIndices),
                        )
                        mesh_cache[cache_key] = cached
                    except Exception:
                        if native is not body:
                            try:
                                calc = body.meshManager.createMeshCalculator()
                                calc.setQuality(quality_opt)
                                calc.surfaceTolerance = surface_tol
                                tmesh = calc.calculate()
                                if not tmesh:
                                    skipped += 1
                                    continue
                                cached = (
                                    list(tmesh.nodeCoordinatesAsFloat),
                                    list(tmesh.normalVectorsAsFloat),
                                    list(tmesh.nodeIndices),
                                )
                                use_mat = None
                            except Exception:
                                skipped += 1
                                continue
                        else:
                            mesh_cache[cache_key] = False
                            skipped += 1
                            continue
                if cached is False:
                    skipped += 1
                    continue

                coords, normals, indices = cached
                if not coords or not indices:
                    continue

                grp = grouped.setdefault(
                    group_key,
                    {
                        "role": role,
                        "color": list(rgba),
                        "positions": [],
                        "normals": [],
                        "indices": [],
                    },
                )
                base_vert = len(grp["positions"]) // 3
                for i in range(0, len(coords), 3):
                    wx, wy, wz = _transform_point(use_mat, coords[i], coords[i + 1], coords[i + 2])
                    gx, gy, gz = fusion_cm_to_gltf_m(wx, wy, wz, up_axis=brep_up)
                    min_x = min(min_x, gx)
                    max_x = max(max_x, gx)
                    min_y = min(min_y, gy)
                    max_y = max(max_y, gy)
                    min_z = min(min_z, gz)
                    max_z = max(max_z, gz)
                    grp["positions"].extend((gx, gy, gz))
                    nx, ny, nz = _transform_normal(use_mat, normals[i], normals[i + 1], normals[i + 2], up_axis=brep_up)
                    grp["normals"].extend((nx, ny, nz))

                for v_idx in indices:
                    grp["indices"].append(base_vert + v_idx)
                total_tris += len(indices) // 3
        finally:
            progress.hide()

        if cancelled:
            ui.messageBox("Export wurde abgebrochen.", _CMD_NAME)
            return

        if not grouped:
            ui.messageBox("Alle Körper wurden gefiltert oder konnten nicht vernetzt werden.", _CMD_NAME)
            return

        mesh_groups = _finalize_grouped_meshes(grouped, min_x, max_x, min_y, max_y, min_z, max_z)

    os.makedirs(out_dir, exist_ok=True)
    slug = slugify_filename(doc.name, "printer")
    out_path = os.path.join(out_dir, f"{slug}-{slot}.glb")
    extra_meta = {"exportEngine": engine_label}
    if seen_appearances:
        extra_meta["appearances"] = seen_appearances
    glb_bytes = build_glb_bytes(
        mesh_groups,
        source_name=doc.name,
        extra_meta=extra_meta,
    )
    with open(out_path, "wb") as fh:
        fh.write(glb_bytes)

    if reveal_file:
        _reveal_in_finder(out_path)

    size_mb = len(glb_bytes) / (1024 * 1024)
    msg = (
        f"Export abgeschlossen ({engine_label})!\n\n"
        f"Datei: {out_path}\n"
        f"Größe: {size_mb:.2f} MB · {total_tris:,} Dreiecke · {len(mesh_groups)} Meshes\n"
        f"Übersprungene Kleinteile: {skipped}\n\n"
        f"Einfach direkt in DOCKYARD → Einstellungen hochladen "
        f"(große Dateien bis 150 MB werden im Browser automatisch per Meshopt komprimiert)."
    )
    ui.messageBox(msg, _CMD_NAME)


def _find_target_panel(ui):
    design_ws = ui.workspaces.itemById("FusionSolidEnvironment")
    if design_ws:
        for pid in _PANEL_IDS:
            panel = design_ws.toolbarPanels.itemById(pid)
            if panel:
                return panel
    for pid in _PANEL_IDS:
        panel = ui.allToolbarPanels.itemById(pid)
        if panel:
            return panel
    return None


def _cleanup_ui(ui):
    for pid in _PANEL_IDS:
        panel = ui.allToolbarPanels.itemById(pid)
        if panel:
            ctrl = panel.controls.itemById(_CMD_ID)
            if ctrl:
                ctrl.deleteMe()
    cmd_def = ui.commandDefinitions.itemById(_CMD_ID)
    if cmd_def:
        cmd_def.deleteMe()


def run(_context):
    if adsk is None:
        raise RuntimeError("Dieses Add-In muss in Autodesk Fusion 360 Desktop ausgeführt werden.")
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        _cleanup_ui(ui)
        _HANDLERS.clear()
        _CMD_HANDLERS.clear()

        res_folder = _RESOURCES_DIR if os.path.isdir(_RESOURCES_DIR) else ""
        cmd_def = ui.commandDefinitions.addButtonDefinition(_CMD_ID, _CMD_NAME, _CMD_TOOLTIP, res_folder)

        class _ExecuteHandler(adsk.core.CommandEventHandler):
            def notify(self, args):
                try:
                    inputs = args.command.commandInputs
                    slot_drop = adsk.core.DropDownCommandInput.cast(inputs.itemById("slot"))
                    axis_drop = adsk.core.DropDownCommandInput.cast(inputs.itemById("up_axis"))
                    qual_drop = adsk.core.DropDownCommandInput.cast(inputs.itemById("quality"))
                    fast_chk = adsk.core.BoolValueCommandInput.cast(inputs.itemById("fasteners"))
                    reveal_chk = adsk.core.BoolValueCommandInput.cast(inputs.itemById("reveal"))
                    dir_inp = adsk.core.StringValueCommandInput.cast(inputs.itemById("outdir"))

                    slot = "toolhead" if slot_drop.selectedItem.index == 1 else "printer"
                    axis_idx = axis_drop.selectedItem.index
                    up_axis = "x+90" if axis_idx == 1 else "x-90" if axis_idx == 2 else "auto"
                    quality = "detail" if qual_drop.selectedItem.index == 1 else "compact"
                    out_dir = os.path.expanduser(dir_inp.value.strip() or "~/Desktop/dockyard-exports")
                    _execute_export(app, ui, slot, up_axis, quality, fast_chk.value, out_dir, reveal_chk.value)
                except Exception:
                    ui.messageBox(f"Export fehlgeschlagen:\n{traceback.format_exc()}", _CMD_NAME)

        class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
            def notify(self, args):
                try:
                    _CMD_HANDLERS.clear()
                    cmd = args.command
                    cmd.okButtonText = "Exportieren"
                    inputs = cmd.commandInputs

                    slot_drop = inputs.addDropDownCommandInput(
                        "slot", "Export-Ziel", adsk.core.DropDownStyles.TextListDropDownStyle
                    )
                    slot_drop.listItems.add("Gesamter Drucker (printer)", True)
                    slot_drop.listItems.add("Toolhead / Aktive Auswahl (toolhead)", False)

                    axis_drop = inputs.addDropDownCommandInput(
                        "up_axis", "Ausrichtung", adsk.core.DropDownStyles.TextListDropDownStyle
                    )
                    axis_drop.listItems.add("Automatisch (wie im Fusion-Viewport)", True)
                    axis_drop.listItems.add("+90° aufrichten (falls auf Front liegend)", False)
                    axis_drop.listItems.add("-90° aufrichten (falls auf Rücken liegend)", False)

                    qual_drop = inputs.addDropDownCommandInput(
                        "quality", "Detailstufe", adsk.core.DropDownStyles.TextListDropDownStyle
                    )
                    qual_drop.listItems.add("Kompakt — Empfohlen (0.04 cm)", True)
                    qual_drop.listItems.add("Detailreich (0.02 cm)", False)

                    inputs.addBoolValueInput(
                        "fasteners", "Kleinteile ausblenden (Schrauben, Muttern, Lager)", True, "", True
                    )
                    inputs.addBoolValueInput(
                        "reveal",
                        "Nach Export im Finder anzeigen" if sys.platform == "darwin" else "Nach Export im Explorer anzeigen",
                        True,
                        "",
                        True,
                    )

                    default_dir = os.environ.get("DOCKYARD_EXPORT_DIR") or os.path.expanduser("~/Desktop/dockyard-exports")
                    inputs.addStringValueInput("outdir", "Ausgabeordner", default_dir)

                    on_exec = _ExecuteHandler()
                    cmd.execute.add(on_exec)
                    _CMD_HANDLERS.append(on_exec)
                except Exception:
                    ui.messageBox(f"Dialog konnte nicht geöffnet werden:\n{traceback.format_exc()}", _CMD_NAME)

        on_created = _CreatedHandler()
        cmd_def.commandCreated.add(on_created)
        _HANDLERS.append(on_created)

        panel = _find_target_panel(ui)
        if panel:
            ctrl = panel.controls.addCommand(cmd_def)
            ctrl.isPromoted = True
            ctrl.isPromotedByDefault = True
    except Exception:
        ui.messageBox(f"DOCKYARD Add-In konnte nicht geladen werden:\n{traceback.format_exc()}", _CMD_NAME)


def stop(_context):
    if adsk is None:
        return
    try:
        app = adsk.core.Application.get()
        if app and app.userInterface:
            _cleanup_ui(app.userInterface)
    except Exception:
        pass
    finally:
        _HANDLERS.clear()
        _CMD_HANDLERS.clear()
