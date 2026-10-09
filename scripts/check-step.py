"""Read STEP using Open Cascade (cadquery-ocp); verify BREP validity, volume, assembly names and a CAD round trip.

python scripts/check-step.py /tmp/step-check
Generate inputs with export-step-fixtures.ts. Dependencies: cadquery-ocp, Python 3.
"""
import json
import math
import sys
import subprocess
from pathlib import Path

from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.STEPControl import STEPControl_Reader, STEPControl_Writer, STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
try:
    from OCP.TDF import TDF_LabelSequence
except ImportError:  # OCCT 8 uses the generated collection name.
    from OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.XCAFDoc import XCAFDoc_DocumentTool


def metrics(shape):
    count, volume = 0, 0
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solid = explorer.Current()
        assert BRepCheck_Analyzer(solid).IsValid(), f"Invalid solid {count + 1}"
        mass = GProp_GProps()
        BRepGProp.VolumeProperties_s(solid, mass)
        assert math.isfinite(mass.Mass()) and mass.Mass() > 0, f"Non-positive solid {count + 1}"
        volume += mass.Mass()
        count += 1
        explorer.Next()
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    low, high = box.CornerMin(), box.CornerMax()
    return count, volume, [low.X(), low.Y(), low.Z(), high.X(), high.Y(), high.Z()]


if len(sys.argv) not in (2, 3):
    sys.exit('Usage: check-step.py OUTPUT_DIRECTORY [FIXTURE.step]')
directory = Path(sys.argv[1])
cases = json.loads((directory / 'manifest.json').read_text())
if not cases or (len(sys.argv) == 3 and not any(case['file'] == sys.argv[2] for case in cases)):
    sys.exit('No matching STEP fixtures')
# Release all native CAD allocations between fixtures, including failed imports.
if len(sys.argv) == 2:
    failures = []
    for case in cases:
        result = subprocess.run([sys.executable, __file__, str(directory), case['file']])
        if result.returncode:
            failures.append(case['file'])
    sys.exit('Failed: ' + ', '.join(failures) if failures else 0)

failures = []
for case in cases:
    if case['file'] != sys.argv[2]:
        continue
    try:
        print(f"READ {case['file']}", flush=True)
        reader = STEPCAFControl_Reader()
        reader.SetNameMode(True)
        assert reader.ReadFile(str(directory / case['file'])) == IFSelect_RetDone, 'Cannot read STEP'
        doc = TDocStd_Document(TCollection_ExtendedString('MDTV-XCAF'))
        assert reader.Transfer(doc), 'Assembly transfer failed'
        shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
        roots = TDF_LabelSequence()
        shapes.GetFreeShapes(roots)
        assert roots.Length() == 1, f"Expected one assembly, got {roots.Length()}"
        root = roots.Value(1)
        label = TDataStd_Name()
        assert root.FindAttribute(TDataStd_Name.GetID_s(), label), 'Missing assembly name'
        assert label.Get().ToExtString() == case['name'], f"Changed assembly name: {label.Get().ToExtString()!r}"
        components = TDF_LabelSequence()
        shapes.GetComponents_s(root, components)
        assert components.Length() == case['products'], f"Changed part count: {components.Length()}"
        shape = shapes.GetShape_s(root)
        del reader
        print(f"VALIDATE {case['file']}", flush=True)
        count, volume, bounds = metrics(shape)
        assert count == case['solids'], f"Changed solid count: {count}"
        if 'volume' in case:
            assert math.isclose(volume, case['volume'], rel_tol=1e-6), f"Changed volume: {volume}"
        if 'bounds' in case:
            assert max(abs(a - b) for a, b in zip(bounds, case['bounds'])) < 1e-4, f"Changed mm dimensions: {bounds}"
        print(f"WRITE {case['file']}", flush=True)
        writer = STEPControl_Writer()
        assert writer.Transfer(shape, STEPControl_AsIs) == IFSelect_RetDone
        target = directory / ('roundtrip-' + case['file'])
        assert writer.Write(str(target)) == IFSelect_RetDone
        del writer
        print(f"REREAD {case['file']}", flush=True)
        reread = STEPControl_Reader()
        assert reread.ReadFile(str(target)) == IFSelect_RetDone and reread.TransferRoots() > 0
        again = metrics(reread.OneShape())
        assert again[0] == count and math.isclose(again[1], volume, rel_tol=1e-6), 'Round trip changed solids or volume'
        assert max(abs(a - b) for a, b in zip(bounds, again[2])) < 1e-4, 'Round trip changed bounds'
        print(f"PASS {case['file']}: {components.Length()} parts, {count} valid solids", flush=True)
    except Exception as error:
        failures.append(f"{case['file']}: {error}")
        print(f"FAIL {failures[-1]}", flush=True)
if failures:
    sys.exit('\n'.join(failures))
