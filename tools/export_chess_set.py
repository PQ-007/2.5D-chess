"""Convert the Polyfjord Chess Set .blend into public/models/chess_set.glb for Three.js.

Usage (needs Blender 4.2+, or `pip install bpy==4.2.0` on Python 3.11):
    blender -b -P tools/export_chess_set.py -- path/to/Polyfjord_Chess_Set.blend
    python tools/export_chess_set.py path/to/Polyfjord_Chess_Set.blend

The GLB contains one node per piece type (wK wQ wR wB wN wP bK ... bP), each with its
base centred on the origin, plus a "Board" node (20 x 20 units, 2.5-unit squares).
"""
import os
import sys

import bpy

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
src = args[0]
out = args[1] if len(args) > 1 else os.path.join(os.path.dirname(__file__), '..', 'public', 'models', 'chess_set.glb')

bpy.ops.wm.open_mainfile(filepath=os.path.abspath(src))

# The set uses legacy Diffuse+Glossy shader mixes that glTF can't express.
# Rebuild each as a Principled BSDF with the same colour and roughness.
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    nodes = mat.node_tree.nodes
    diffuse = next((n for n in nodes if n.type == 'BSDF_DIFFUSE'), None)
    glossy = next((n for n in nodes if n.type == 'BSDF_GLOSSY'), None)
    if not diffuse:
        continue
    color = tuple(diffuse.inputs['Color'].default_value)
    roughness = glossy.inputs['Roughness'].default_value if glossy else 0.9
    nodes.clear()
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    output = nodes.new('ShaderNodeOutputMaterial')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = max(roughness, 0.25)
    mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

LETTER = {'King': 'K', 'Queen': 'Q', 'Rook': 'R', 'Bishop': 'B', 'Knight': 'N', 'Pawn': 'P'}
keep = []
for obj in list(bpy.data.objects):
    if obj.name == 'Chess Board':
        obj.name = 'Board'
        keep.append(obj)
        continue
    parts = obj.name.split('.')  # 3D.White.Pawn.001
    if len(parts) >= 3 and parts[2] in LETTER and (len(parts) == 3 or parts[3] == '001'):
        obj.name = ('w' if parts[1] == 'White' else 'b') + LETTER[parts[2]]
        # Centre the base of the piece on the origin.
        bpy.context.view_layer.update()
        xs = [(obj.matrix_world @ v.co).x for v in obj.data.vertices]
        ys = [(obj.matrix_world @ v.co).y for v in obj.data.vertices]
        obj.location.x -= (min(xs) + max(xs)) / 2
        obj.location.y -= (min(ys) + max(ys)) / 2
        keep.append(obj)
    else:
        bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.object.select_all(action='DESELECT')
for obj in keep:
    obj.select_set(True)

bpy.ops.export_scene.gltf(
    filepath=os.path.abspath(out),
    export_format='GLB',
    use_selection=True,
    export_apply=True,  # bake EdgeSplit / auto-smooth / bevel modifiers
    export_yup=True,
    export_cameras=False,
    export_lights=False,
)
print('exported', sorted(o.name for o in keep), '->', os.path.abspath(out))
