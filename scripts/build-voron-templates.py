"""
Build lightweight, normalized VoronDesign StealthBurner and Mini-StealthBurner
GLB templates for DOCKYARD using Blender CLI (background mode).

Source assemblies (GPL-3.0 upstream VoronDesign CAD converted in Psych0h3ad/3d-print-rig):
  - StealthBurner + Clockwork 2 + Revo Voron: sb_revo_voron.glb + head_sb_cw2.glb
  - Mini-StealthBurner (Voron V0.2r1): head_tap_minisb_rods.glb (excluding TapChanger carriage/rods)

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --python scripts/build-voron-templates.py -- \
    --sources /tmp/voron-template-sources \
    --out-dir /tmp/voron-template-raw \
    --preview-dir /tmp/voron-template-previews
"""

import argparse
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--preview-dir", default="")
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, rgba, roughness=0.55, metallic=0.08):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    return mat


def assign_material(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def import_glb(filepath):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=filepath)
    return [o for o in bpy.data.objects if o not in before]


def world_bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in objs:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            pt = obj.matrix_world @ Vector(corner)
            lo.x = min(lo.x, pt.x)
            lo.y = min(lo.y, pt.y)
            lo.z = min(lo.z, pt.z)
            hi.x = max(hi.x, pt.x)
            hi.y = max(hi.y, pt.y)
            hi.z = max(hi.z, pt.z)
    return lo, hi


def bake_transforms(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        if obj.type == "MESH":
            obj.select_set(True)
    if objs:
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def join_objects(objs, name, mat, decimate_ratio=None):
    meshes = [o for o in objs if o.type == "MESH"]
    if not meshes:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    joined.data.name = name

    # Merge split-edge CAD vertices so decimation and meshopt simplify cleanly
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.00012)
    bpy.ops.object.mode_set(mode="OBJECT")

    if decimate_ratio is not None and 0.0 < decimate_ratio < 1.0:
        mod = joined.modifiers.new(name="Decimate", type="DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = decimate_ratio
        bpy.ops.object.modifier_apply(modifier=mod.name)

    assign_material(joined, mat)
    return joined


def add_empty(name, location):
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_size = 0.005
    empty.location = Vector(location)
    bpy.context.scene.collection.objects.link(empty)
    return empty


def add_led_lens(name, location, size, mat):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.scale = Vector(size)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.name = name
    obj.data.name = name
    assign_material(obj, mat)
    return obj


def shift_and_ground(objs, pivot_x, pivot_y, min_z):
    # Blender is Z-up; glTF exporter maps Blender (X, Y, Z) -> glTF (X, Z, -Y)
    # So centering X=0, Y=0 and grounding Z=0 yields glTF X=0, Z=0, Y_min=0!
    delta = Vector((-pivot_x, -pivot_y, -min_z))
    for obj in objs:
        obj.location += delta
    bpy.context.view_layer.update()
    bake_transforms([o for o in objs if o.type == "MESH"])


def render_preview(preview_path, objs):
    if not preview_path:
        return
    os.makedirs(os.path.dirname(preview_path), exist_ok=True)
    lo, hi = world_bounds(objs)
    center = (lo + hi) * 0.5
    size = hi - lo
    dist = max(size.x, size.y, size.z) * 2.1

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.filepath = preview_path
    scene.world = bpy.data.worlds.new("Studio")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.04, 0.06, 0.075, 1.0)
        bg.inputs[1].default_value = 1.0

    # Blender front after glTF import is -Y (glTF +Z = Blender -Y)
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = center + Vector((dist * 0.55, -dist * 0.95, dist * 0.28))
    direction = center - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    for lname, loc, energy in [
        ("Key", (0.4, -0.6, 0.6), 45),
        ("Fill", (-0.5, -0.3, 0.2), 20),
        ("Rim", (0.0, 0.6, 0.4), 25),
    ]:
        ldata = bpy.data.lights.new(lname, type="POINT")
        ldata.energy = energy
        lobj = bpy.data.objects.new(lname, ldata)
        lobj.location = center + Vector(loc)
        scene.collection.objects.link(lobj)

    bpy.ops.render.render(write_still=True)


def export_glb(filepath, keep_objects):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in keep_objects:
        if obj is not None:
            obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_extras=True,
    )


def build_stealthburner(sources_dir, out_path, preview_path):
    clear_scene()
    sb_objs = import_glb(os.path.join(sources_dir, "sb_revo_voron.glb"))
    cw_objs = import_glb(os.path.join(sources_dir, "head_sb_cw2.glb"))

    all_meshes = [o for o in sb_objs + cw_objs if o.type == "MESH"]
    bake_transforms(all_meshes)

    # Remove non-mesh empties imported from source GLBs
    for o in list(bpy.data.objects):
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)

    by_name = {o.name: o for o in bpy.data.objects if o.type == "MESH"}

    # Exact node classification from VoronDesign StealthBurner + CW2 + Revo assembly
    keep_accent_names = {
        "sb_revo_voron_6",  # StealthBurner front faceplate / main accent shroud
        "head_sb_cw2_18",   # CW2 cable door / upper accent
        "head_sb_cw2_20",   # CW2 accent piece
        "head_sb_cw2_21",   # CW2 latch / guidler accent
        "head_sb_cw2_23",   # CW2 upper accent
    }
    keep_body_names = {
        "sb_revo_voron_10",  # LED logo diffuser mask
        "sb_revo_voron_13",  # 5015 blower wheel / hub
        "sb_revo_voron_14",  # 5015 blower housing
        "sb_revo_voron_15",  # 4010 hotend fan
        "sb_revo_voron_82",  # Rear body
        "sb_revo_voron_83",  # Lower main body
        "head_sb_cw2_16",    # NEMA14 pancake stepper
        "head_sb_cw2_17",    # CW2 motor plate
        "head_sb_cw2_19",    # CW2 main body
        "head_sb_cw2_25",    # CW2 rear body
        "head_sb_cw2_26",    # CW2 carriage mount
    }
    keep_metal_names = {
        "sb_revo_voron_84",  # Revo Voron heatsink (anodized/metallic)
        "sb_revo_voron_85",  # Revo hotend mount / core
        "sb_revo_voron_86",  # Revo heater/nozzle lower assembly
        "head_sb_cw2_62",    # Visible thumbscrew / latch tensioner
    }
    led_logo_name = "sb_revo_voron_9"
    led_nozzle_l_name = "sb_revo_voron_8"
    led_nozzle_r_name = "sb_revo_voron_7"

    keep_all = keep_accent_names | keep_body_names | keep_metal_names | {
        led_logo_name,
        led_nozzle_l_name,
        led_nozzle_r_name,
    }

    for name, obj in list(by_name.items()):
        if name not in keep_all:
            bpy.data.objects.remove(obj, do_unlink=True)

    mat_body = make_material("VORON_BODY", (0.045, 0.055, 0.062, 1.0), roughness=0.58, metallic=0.08)
    mat_accent = make_material("VORON_ACCENT", (0.72, 0.07, 0.07, 1.0), roughness=0.46, metallic=0.06)
    mat_metal = make_material("VORON_METAL", (0.45, 0.49, 0.53, 1.0), roughness=0.35, metallic=0.45)
    mat_led_logo = make_material("LED_LOGO_MAT", (0.12, 0.14, 0.16, 1.0), roughness=0.35, metallic=0.0)
    mat_led_l = make_material("LED_NOZZLE_L_MAT", (0.125, 0.14, 0.16, 1.0), roughness=0.35, metallic=0.0)
    mat_led_r = make_material("LED_NOZZLE_R_MAT", (0.13, 0.14, 0.16, 1.0), roughness=0.35, metallic=0.0)

    body_obj = join_objects([bpy.data.objects[n] for n in keep_body_names if n in bpy.data.objects], "SB_BODY", mat_body, decimate_ratio=0.18)
    accent_obj = join_objects([bpy.data.objects[n] for n in keep_accent_names if n in bpy.data.objects], "VORON_ACCENT", mat_accent, decimate_ratio=0.22)
    metal_obj = join_objects([bpy.data.objects[n] for n in keep_metal_names if n in bpy.data.objects], "SB_HOTEND", mat_metal, decimate_ratio=0.15)

    led_logo = bpy.data.objects[led_logo_name]
    led_logo.name = "LED_LOGO"
    led_logo.data.name = "LED_LOGO"
    assign_material(led_logo, mat_led_logo)

    led_l = bpy.data.objects[led_nozzle_l_name]
    led_l.name = "LED_NOZZLE_L"
    led_l.data.name = "LED_NOZZLE_L"
    assign_material(led_l, mat_led_l)

    led_r = bpy.data.objects[led_nozzle_r_name]
    led_r.name = "LED_NOZZLE_R"
    led_r.data.name = "LED_NOZZLE_R"
    assign_material(led_r, mat_led_r)

    # Set glTF extras roles
    accent_obj["dockyardRole"] = "accent"
    led_logo["dockyardRole"] = "led-logo"
    led_l["dockyardRole"] = "led-nozzle-l"
    led_r["dockyardRole"] = "led-nozzle-r"

    meshes = [body_obj, accent_obj, metal_obj, led_logo, led_l, led_r]
    lo, hi = world_bounds(meshes)
    nozzle_lo, nozzle_hi = world_bounds([metal_obj])

    # Ground lowest Z to 0 and center X/Y around overall visual center
    center_x = (lo.x + hi.x) * 0.5
    center_y = (lo.y + hi.y) * 0.5
    shift_and_ground(meshes, center_x, center_y, lo.z)

    # Recompute exact shifted bounds for NOZZLE_TIP and FILAMENT_INLET markers
    lo2, hi2 = world_bounds(meshes)
    # Filament axis in raw glTF coords was x=0.0, z=0.0286 -> in Blender (X=0.0, Y=-0.0286)
    nozzle_x = 0.0 - center_x
    nozzle_y = -0.0286 - center_y
    nozzle_tip = add_empty("NOZZLE_TIP", (nozzle_x, nozzle_y, 0.0))
    nozzle_tip["dockyardRole"] = "nozzle-tip"
    filament_inlet = add_empty("FILAMENT_INLET", (nozzle_x, nozzle_y, hi2.z))
    filament_inlet["dockyardRole"] = "filament-inlet"

    all_export = meshes + [nozzle_tip, filament_inlet]
    export_glb(out_path, all_export)
    if preview_path:
        render_preview(preview_path, meshes)
    print(f"[StealthBurner] exported {out_path} bounds={(hi2 - lo2)}")


def build_mini_stealthburner(sources_dir, out_path, preview_path):
    clear_scene()
    raw_objs = import_glb(os.path.join(sources_dir, "minisb_rods.glb"))
    all_meshes = [o for o in raw_objs if o.type == "MESH"]
    bake_transforms(all_meshes)

    for o in list(bpy.data.objects):
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)

    # Keep only the official VoronDesign V0.2r1 Mini-StealthBurner parts (exclude TapChanger nodes 137..140 and tiny hidden fasteners)
    keep_accent_names = {
        "head_tap_minisb_rods_83",  # MiniSB Cowling (front accent shroud)
        "head_tap_minisb_rods_75",  # Guidler
        "head_tap_minisb_rods_76",  # Latch
    }
    keep_body_names = {
        "head_tap_minisb_rods_78",   # MiniSB MidBody
        "head_tap_minisb_rods_81",   # Hotend mount
        "head_tap_minisb_rods_82",   # Motor plate
        "head_tap_minisb_rods_85",   # NEMA14 pancake motor
        "head_tap_minisb_rods_86",   # Extruder lever/tension detail
        "head_tap_minisb_rods_128",  # 3010 hotend fan
        "head_tap_minisb_rods_129",  # Right 3010 part cooling fan
        "head_tap_minisb_rods_130",  # Left 3010 part cooling fan
    }
    keep_metal_names = {
        "head_tap_minisb_rods_77",   # Extruder metal gear / shaft housing
        "head_tap_minisb_rods_135",  # Hotend heatsink + heater block + nozzle
    }
    led_logo_name = "head_tap_minisb_rods_84"

    keep_all = keep_accent_names | keep_body_names | keep_metal_names | {led_logo_name}
    for obj in list(bpy.data.objects):
        if obj.name not in keep_all:
            bpy.data.objects.remove(obj, do_unlink=True)

    mat_body = make_material("VORON_BODY", (0.045, 0.055, 0.062, 1.0), roughness=0.58, metallic=0.08)
    mat_accent = make_material("VORON_ACCENT", (0.72, 0.07, 0.07, 1.0), roughness=0.46, metallic=0.06)
    mat_metal = make_material("VORON_METAL", (0.45, 0.49, 0.53, 1.0), roughness=0.35, metallic=0.45)
    mat_led_logo = make_material("LED_LOGO_MAT", (0.12, 0.14, 0.16, 1.0), roughness=0.35, metallic=0.0)
    mat_led_l = make_material("LED_NOZZLE_L_MAT", (0.125, 0.14, 0.16, 1.0), roughness=0.35, metallic=0.0)
    mat_led_r = make_material("LED_NOZZLE_R_MAT", (0.13, 0.14, 0.16, 1.0), roughness=0.35, metallic=0.0)

    body_obj = join_objects([bpy.data.objects[n] for n in keep_body_names if n in bpy.data.objects], "MINISB_BODY", mat_body, decimate_ratio=0.35)
    accent_obj = join_objects([bpy.data.objects[n] for n in keep_accent_names if n in bpy.data.objects], "VORON_ACCENT", mat_accent, decimate_ratio=0.45)
    metal_obj = join_objects([bpy.data.objects[n] for n in keep_metal_names if n in bpy.data.objects], "MINISB_HOTEND", mat_metal, decimate_ratio=0.25)

    led_logo = bpy.data.objects[led_logo_name]
    led_logo.name = "LED_LOGO"
    led_logo.data.name = "LED_LOGO"
    assign_material(led_logo, mat_led_logo)

    # Determine cowling underside for twin Mini-StealthBurner nozzle LED diffusers
    cowl_lo, cowl_hi = world_bounds([accent_obj])
    cowl_cx = (cowl_lo.x + cowl_hi.x) * 0.5
    # In Blender coords (after glTF Y-up -> Blender Z-up): front is cowl_lo.y, bottom is cowl_lo.z
    nozzle_led_y = cowl_lo.y + 0.012
    nozzle_led_z = cowl_lo.z + 0.0045
    led_l = add_led_lens("LED_NOZZLE_L", (cowl_cx - 0.0095, nozzle_led_y, nozzle_led_z), (0.0042, 0.0042, 0.0022), mat_led_l)
    led_r = add_led_lens("LED_NOZZLE_R", (cowl_cx + 0.0095, nozzle_led_y, nozzle_led_z), (0.0042, 0.0042, 0.0022), mat_led_r)

    accent_obj["dockyardRole"] = "accent"
    led_logo["dockyardRole"] = "led-logo"
    led_l["dockyardRole"] = "led-nozzle-l"
    led_r["dockyardRole"] = "led-nozzle-r"

    meshes = [body_obj, accent_obj, metal_obj, led_logo, led_l, led_r]
    lo, hi = world_bounds(meshes)

    center_x = (lo.x + hi.x) * 0.5
    center_y = (lo.y + hi.y) * 0.5
    shift_and_ground(meshes, center_x, center_y, lo.z)

    lo2, hi2 = world_bounds(meshes)
    # Filament PTFE axis in raw glTF coords was x=0.085, z=-0.004 -> Blender (X=0.085, Y=0.004)
    nozzle_x = 0.085 - center_x
    nozzle_y = 0.004 - center_y
    nozzle_tip = add_empty("NOZZLE_TIP", (nozzle_x, nozzle_y, 0.0))
    nozzle_tip["dockyardRole"] = "nozzle-tip"
    filament_inlet = add_empty("FILAMENT_INLET", (nozzle_x, nozzle_y, hi2.z))
    filament_inlet["dockyardRole"] = "filament-inlet"

    all_export = meshes + [nozzle_tip, filament_inlet]
    export_glb(out_path, all_export)
    if preview_path:
        render_preview(preview_path, meshes)
    print(f"[Mini-StealthBurner] exported {out_path} bounds={(hi2 - lo2)}")


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    sb_raw = os.path.join(args.out_dir, "stealthburner.raw.glb")
    mini_raw = os.path.join(args.out_dir, "mini-stealthburner.raw.glb")
    sb_prev = os.path.join(args.preview_dir, "stealthburner.png") if args.preview_dir else ""
    mini_prev = os.path.join(args.preview_dir, "mini-stealthburner.png") if args.preview_dir else ""

    build_stealthburner(args.sources, sb_raw, sb_prev)
    build_mini_stealthburner(args.sources, mini_raw, mini_prev)


if __name__ == "__main__":
    main()
