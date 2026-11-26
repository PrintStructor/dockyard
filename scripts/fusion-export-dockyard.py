"""
Generic Fusion 360 Desktop (macOS / Windows) GLB v2 exporter for DOCKYARD.

Works with any open Fusion 360 design (VORON 2.4, Trident, V0.1, Crucible, etc.).
- Native Fusion dialog to pick Printer vs. Toolhead/Selection, quality preset,
  fastener filter, and output folder (default: ~/Desktop/dockyard-exports).
- Converts Fusion Z-up (cm) -> right-handed glTF Y-up (m), centers X/Z on 0,
  grounds minY to 0, and merges bodies by (dockyardRole, material).
- Recognizes optional live tags in body/component/appearance names:
    VORON_ACCENT, LED_LOGO, LED_NOZZLE_L, LED_NOZZLE_R
- Produces a valid self-contained GLB v2 file ready to upload in DOCKYARD Settings
  (or compress further with scripts/optimize-dockyard-glb.sh).
"""

import json
import math
import os
import re
import struct
import traceback

try:
    import adsk.core
    import adsk.fusion
except ImportError:
    adsk = None

_HANDLERS = []
_CMD_ID = "DockyardExportGlbCmd"

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


def slugify_filename(name, fallback="dockyard-model"):
    clean = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(name or "").strip().lower()).strip("-_")
    return clean[:64] or fallback


def should_skip_fastener(name):
    return bool(FASTENER_PATTERN.search(str(name or "")))


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


def fusion_cm_to_gltf_m(x, y, z):
    """Right-handed Z-up (cm) -> Y-up (m): (x, y, z) -> (x*0.01, z*0.01, -y*0.01)."""
    return (round(x * 0.01, 7), round(z * 0.01, 7), round(-y * 0.01, 7))


def _pad4(data, pad_byte=b"\x00"):
    rem = len(data) % 4
    return data if rem == 0 else data + pad_byte * (4 - rem)


def build_glb_bytes(mesh_groups, source_name=""):
    """
    Pack a list of mesh groups into a valid glTF 2.0 Binary (.glb) byte string.
    Each group dict has:
      name: str
      role: str | None ('accent' | 'led-logo' | 'led-nozzle-l' | 'led-nozzle-r' | None)
      color: [r, g, b, a] in 0..1 linear/sRGB-safe float
      roughness: float (optional, default 0.52)
      metallic: float (optional, default 0.12)
      positions: list[float] (len % 3 == 0)
      normals: list[float] (len == len(positions))
      indices: list[int] (len % 3 == 0)
    """
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

        col = group.get("color") or [0.22, 0.25, 0.28, 1.0]
        mat_name = "VORON_ACCENT" if role == "accent" else f"mat_{node_name}"
        mat_idx = len(materials)
        materials.append(
            {
                "name": mat_name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": [float(c) for c in col[:4]],
                    "metallicFactor": float(group.get("metallic", 0.12)),
                    "roughnessFactor": float(group.get("roughness", 0.52)),
                },
            }
        )

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
            "generator": "DOCKYARD Fusion 360 Exporter",
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


# --- Fusion 360 Runtime Export Logic (only executes inside Fusion 360 Desktop) ---


def _extract_appearance_rgba(body):
    default = (0.18, 0.21, 0.24, 1.0)
    app_name = ""
    try:
        appearance = body.appearance
        if not appearance:
            return default, ""
        app_name = appearance.name or ""
        for prop_id in ("opaque_albedo", "metal_f0", "surface_albedo", "generic_diffuse"):
            prop = appearance.appearanceProperties.itemById(prop_id)
            if prop and hasattr(prop, "value") and prop.value:
                c = prop.value
                # Convert sRGB 0..255 -> linear 0..1 for glTF PBR baseColorFactor
                def to_lin(v):
                    s = max(0.0, min(1.0, v / 255.0))
                    return round(s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4, 4)

                return (to_lin(c.red), to_lin(c.green), to_lin(c.blue), 1.0), app_name
    except Exception:
        pass
    return default, app_name


def iter_visible_occurrences(occ):
    """Yield an occurrence and all visible descendant occurrences recursively."""
    if not occ or not getattr(occ, "isVisible", False):
        return
    yield occ
    for child in getattr(occ, "childOccurrences", None) or ():
        yield from iter_visible_occurrences(child)


def _safe_body_key(body, fallback=""):
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


def _collect_target_bodies(design, slot, ui):
    targets = []  # list of (body, transform_array, label_name)
    if slot == "toolhead" and ui.activeSelections.count > 0:
        seen = set()
        for i in range(ui.activeSelections.count):
            ent = ui.activeSelections.item(i).entity
            if isinstance(ent, adsk.fusion.Occurrence):
                for sub in iter_visible_occurrences(ent):
                    mat = sub.transform2.asArray()
                    for b in sub.bRepBodies:
                        bkey = _safe_body_key(b)
                        if b.isVisible and bkey not in seen:
                            seen.add(bkey)
                            targets.append((b, mat, f"{sub.name} {b.name}"))
            elif isinstance(ent, adsk.fusion.BRepBody):
                bkey = _safe_body_key(ent)
                if ent.isVisible and bkey not in seen:
                    seen.add(bkey)
                    mat = ent.assemblyContext.transform2.asArray() if ent.assemblyContext else None
                    targets.append((ent, mat, ent.name))
        if targets:
            return targets

    root = design.rootComponent
    for b in root.bRepBodies:
        if b.isVisible:
            targets.append((b, None, b.name))
    for occ in root.allOccurrences:
        if not occ.isVisible:
            continue
        mat = occ.transform2.asArray()
        for b in occ.bRepBodies:
            if b.isVisible:
                targets.append((b, mat, f"{occ.name} {b.name}"))
    return targets


def _transform_point(m, x, y, z):
    if not m:
        return x, y, z
    return (
        m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11],
    )


def _transform_normal(m, nx, ny, nz):
    if m:
        rx = m[0] * nx + m[1] * ny + m[2] * nz
        ry = m[4] * nx + m[5] * ny + m[6] * nz
        rz = m[8] * nx + m[9] * ny + m[10] * nz
    else:
        rx, ry, rz = nx, ny, nz
    gx, gy, gz = rx, rz, -ry
    length = math.sqrt(gx * gx + gy * gy + gz * gz) or 1.0
    return gx / length, gy / length, gz / length


def _execute_export(app, ui, slot, quality_mode, skip_fasteners, out_dir):
    doc = app.activeDocument
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        ui.messageBox("Kein aktives Fusion-360-Design geöffnet.", "DOCKYARD Export")
        return

    targets = _collect_target_bodies(design, slot, ui)
    if not targets:
        ui.messageBox("Keine sichtbaren Körper zum Exportieren gefunden.", "DOCKYARD Export")
        return

    quality_opt = (
        adsk.fusion.TriangleMeshQualityOptions.NormalQualityTriangleMesh
        if quality_mode == "detail"
        else adsk.fusion.TriangleMeshQualityOptions.LowQualityTriangleMesh
    )
    surface_tol = 0.02 if quality_mode == "detail" else 0.04

    grouped = {}
    mesh_cache = {}
    skipped = 0
    total_tris = 0
    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")

    for body, mat, label in targets:
        if skip_fasteners and should_skip_fastener(label):
            skipped += 1
            continue
        rgba, app_name = _extract_appearance_rgba(body)
        role = detect_dockyard_role(label, app_name)
        color_key = tuple(round(c, 2) for c in rgba)
        group_key = (role, color_key)

        native = (getattr(body, "nativeObject", None) or body) if mat is not None else body
        cache_key = _safe_body_key(native, label)
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
            wx, wy, wz = _transform_point(mat, coords[i], coords[i + 1], coords[i + 2])
            gx, gy, gz = fusion_cm_to_gltf_m(wx, wy, wz)
            min_x = min(min_x, gx)
            max_x = max(max_x, gx)
            min_y = min(min_y, gy)
            max_y = max(max_y, gy)
            min_z = min(min_z, gz)
            max_z = max(max_z, gz)
            grp["positions"].extend((gx, gy, gz))
            nx, ny, nz = _transform_normal(mat, normals[i], normals[i + 1], normals[i + 2])
            grp["normals"].extend((nx, ny, nz))

        for idx in indices:
            grp["indices"].append(base_vert + idx)
        total_tris += len(indices) // 3

    if not grouped:
        ui.messageBox("Alle Körper wurden gefiltert oder konnten nicht vernetzt werden.", "DOCKYARD Export")
        return

    # Center X/Z around 0 and ground minY to 0
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
            f"./scripts/optimize-dockyard-glb.sh \"{out_path}\" --preset {slot}"
        )
    ui.messageBox(msg, "DOCKYARD GLB Export")


def run(_context):
    if adsk is None:
        raise RuntimeError("Dieses Skript muss in Fusion 360 Desktop ausgeführt werden.")
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        existing = ui.commandDefinitions.itemById(_CMD_ID)
        if existing:
            existing.deleteMe()
        cmd_def = ui.commandDefinitions.addButtonDefinition(
            _CMD_ID, "DOCKYARD GLB Export", "Exportiert das aktive Modell als glTF 2.0 (.glb) für DOCKYARD."
        )

        class _ExecuteHandler(adsk.core.CommandEventHandler):
            def notify(self, args):
                try:
                    inputs = args.command.commandInputs
                    slot_drop = adsk.core.DropDownCommandInput.cast(inputs.itemById("slot"))
                    qual_drop = adsk.core.DropDownCommandInput.cast(inputs.itemById("quality"))
                    fast_chk = adsk.core.BoolValueCommandInput.cast(inputs.itemById("fasteners"))
                    dir_inp = adsk.core.StringValueCommandInput.cast(inputs.itemById("outdir"))

                    slot = "toolhead" if slot_drop.selectedItem.index == 1 else "printer"
                    quality = "detail" if qual_drop.selectedItem.index == 1 else "compact"
                    out_dir = os.path.expanduser(dir_inp.value.strip() or "~/Desktop/dockyard-exports")
                    _execute_export(app, ui, slot, quality, fast_chk.value, out_dir)
                except Exception:
                    ui.messageBox(f"Export fehlgeschlagen:\n{traceback.format_exc()}", "DOCKYARD Export")

        class _DestroyHandler(adsk.core.CommandEventHandler):
            def notify(self, _args):
                adsk.terminate()

        class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
            def notify(self, args):
                cmd = args.command
                inputs = cmd.commandInputs

                slot_drop = inputs.addDropDownCommandInput(
                    "slot", "Export-Ziel", adsk.core.DropDownStyles.TextListDropDownStyle
                )
                slot_drop.listItems.add("Gesamter Drucker (printer)", True)
                slot_drop.listItems.add("Toolhead / Aktive Auswahl (toolhead)", False)

                qual_drop = inputs.addDropDownCommandInput(
                    "quality", "Detailstufe", adsk.core.DropDownStyles.TextListDropDownStyle
                )
                qual_drop.listItems.add("Kompakt — Empfohlen (0.04 cm)", True)
                qual_drop.listItems.add("Detailreich (0.02 cm)", False)

                inputs.addBoolValueInput("fasteners", "Kleinteile ausblenden (Schrauben, Muttern, Lager)", True, "", True)

                default_dir = os.environ.get("DOCKYARD_EXPORT_DIR") or os.path.expanduser("~/Desktop/dockyard-exports")
                inputs.addStringValueInput("outdir", "Ausgabeordner", default_dir)

                on_exec = _ExecuteHandler()
                cmd.execute.add(on_exec)
                _HANDLERS.append(on_exec)

                on_destroy = _DestroyHandler()
                cmd.destroy.add(on_destroy)
                _HANDLERS.append(on_destroy)

        on_created = _CreatedHandler()
        cmd_def.commandCreated.add(on_created)
        _HANDLERS.append(on_created)
        cmd_def.execute()
        adsk.autoTerminate(False)
    except Exception:
        ui.messageBox(f"Fehler beim Starten des DOCKYARD-Exporters:\n{traceback.format_exc()}", "DOCKYARD Export")


def stop(_context):
    _HANDLERS.clear()
