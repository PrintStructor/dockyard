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
import struct
import subprocess
import sys
import traceback

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
    if "LED_NOZZLE_L" in combined:
        return "led-nozzle-l"
    if "LED_NOZZLE_R" in combined:
        return "led-nozzle-r"
    if "LED_LOGO" in combined:
        return "led-logo"
    if "VORON_ACCENT" in combined:
        return "accent"
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


def build_glb_bytes(mesh_groups, source_name=""):
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
    gltf = {
        "asset": {
            "version": "2.0",
            "generator": "DOCKYARD Fusion 360 Add-In",
            "extras": {"sourceDocument": source_name},
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


def _extract_appearance_rgba(body, appearance_cache):
    default = (0.18, 0.21, 0.24, 1.0)
    try:
        appearance = getattr(body, "appearance", None)
        if not appearance:
            native = _safe_native(body)
            if native is not body:
                appearance = getattr(native, "appearance", None)
        if not appearance:
            return default, ""
        try:
            app_id = appearance.id
        except Exception:
            app_id = getattr(appearance, "name", "") or str(id(appearance))
        if app_id in appearance_cache:
            return appearance_cache[app_id]

        app_name = getattr(appearance, "name", "") or ""
        rgba = None
        for prop_id in (
            "opaque_albedo",
            "metal_f0",
            "surface_albedo",
            "generic_diffuse",
            "transparent_color",
            "glazing_transmittance",
        ):
            prop = appearance.appearanceProperties.itemById(prop_id)
            if prop and isinstance(prop, adsk.core.ColorProperty) and prop.value:
                c = prop.value
                rgba = (_srgb_byte_to_linear(c.red), _srgb_byte_to_linear(c.green), _srgb_byte_to_linear(c.blue), 1.0)
                break
        if rgba is None:
            for prop in appearance.appearanceProperties:
                if isinstance(prop, adsk.core.ColorProperty) and prop.value:
                    c = prop.value
                    rgba = (
                        _srgb_byte_to_linear(c.red),
                        _srgb_byte_to_linear(c.green),
                        _srgb_byte_to_linear(c.blue),
                        1.0,
                    )
                    break
        if rgba is None:
            rgba = default
        if is_transparent_appearance(app_name):
            rgba = (0.18, 0.28, 0.32, 0.14)

        result = (rgba, app_name)
        appearance_cache[app_id] = result
        return result
    except Exception:
        return default, ""


def _collect_target_bodies(design, slot, ui):
    targets = []  # list of (body, transform_array, leaf_label, full_label)
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
                            targets.append((b, mat, f"{sub.name} {b.name}", f"{full_path} {b.name}"))
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
                    targets.append((ent, mat, ent.name, f"{full_path} {ent.name}".strip()))
                except Exception:
                    continue
        if targets:
            return targets

    root = design.rootComponent
    for b in root.bRepBodies:
        try:
            if b.isVisible:
                targets.append((b, None, b.name, b.name))
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
                        targets.append((b, mat, f"{occ.name} {b.name}", f"{full_path} {b.name}"))
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


def _reveal_in_finder(path):
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
        elif sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    except Exception:
        pass


def _execute_export(app, ui, slot, up_axis, quality_mode, skip_fasteners, out_dir, reveal_file):
    doc = app.activeDocument
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        ui.messageBox("Kein aktives Fusion-360-Design geöffnet.", _CMD_NAME)
        return

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
    appearance_cache = {}
    skipped = 0
    total_tris = 0
    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")
    cancelled = False

    progress = ui.createProgressDialog()
    progress.isCancelButtonShown = True
    progress.show(_CMD_NAME, "Verarbeite Körper %v von %m …", 0, len(targets), 0)

    try:
        for idx_body, (body, mat, leaf_label, full_label) in enumerate(targets):
            if idx_body % 10 == 0:
                progress.progressValue = idx_body
                adsk.doEvents()
                if progress.wasCancelled:
                    cancelled = True
                    break

            if skip_fasteners and should_skip_fastener(leaf_label):
                skipped += 1
                continue

            rgba, app_name = _extract_appearance_rgba(body, appearance_cache)
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
                gx, gy, gz = fusion_cm_to_gltf_m(wx, wy, wz, up_axis=up_axis)
                min_x = min(min_x, gx)
                max_x = max(max_x, gx)
                min_y = min(min_y, gy)
                max_y = max(max_y, gy)
                min_z = min(min_z, gz)
                max_z = max(max_z, gz)
                grp["positions"].extend((gx, gy, gz))
                nx, ny, nz = _transform_normal(use_mat, normals[i], normals[i + 1], normals[i + 2], up_axis=up_axis)
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

    cx = (min_x + max_x) * 0.5
    cz = (min_z + max_z) * 0.5
    mesh_groups = []
    for idx, grp in enumerate(grouped.values()):
        pos = grp["positions"]
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
            else f"mesh_{idx}"
        )
        mesh_groups.append(grp)

    os.makedirs(out_dir, exist_ok=True)
    slug = slugify_filename(doc.name, "printer")
    out_path = os.path.join(out_dir, f"{slug}-{slot}.glb")
    glb_bytes = build_glb_bytes(mesh_groups, source_name=doc.name)
    with open(out_path, "wb") as fh:
        fh.write(glb_bytes)

    if reveal_file:
        _reveal_in_finder(out_path)

    size_mb = len(glb_bytes) / (1024 * 1024)
    msg = (
        f"Export abgeschlossen!\n\n"
        f"Datei: {out_path}\n"
        f"Größe: {size_mb:.2f} MB · {total_tris:,} Dreiecke · {len(mesh_groups)} Meshes\n"
        f"Übersprungene Kleinteile: {skipped}"
    )
    if size_mb > 5.0:
        msg += (
            f"\n\nTipp für noch schnelleres Laden auf dem Raspberry Pi:\n"
            f'./scripts/optimize-dockyard-glb.sh "{out_path}" --preset {slot}'
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
                    up_axis = "y" if axis_drop.selectedItem.index == 1 else "z"
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

                    default_axis = _detect_default_up_axis(app)
                    axis_drop = inputs.addDropDownCommandInput(
                        "up_axis", "Hochachse", adsk.core.DropDownStyles.TextListDropDownStyle
                    )
                    axis_drop.listItems.add("Z-oben (VORON / STEP-Standard)", default_axis != "y")
                    axis_drop.listItems.add("Y-oben (Fusion-Standard)", default_axis == "y")

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
