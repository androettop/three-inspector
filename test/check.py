# Validates every exported file under out/ (needs: pip install trimesh lxml networkx).
import glob, zipfile, trimesh, numpy as np
for f in sorted(glob.glob("out/*/*.stl") + glob.glob("out/*/*.3mf")):
    if f.endswith(".3mf"):
        assert zipfile.ZipFile(f).testzip() is None, "bad zip"
    s = trimesh.load(f, force="scene")
    geoms = list(s.geometry.values())
    tris = sum(len(g.faces) for g in geoms)
    size = np.round(s.bounds[1] - s.bounds[0], 1)
    wt = sum(g.is_watertight for g in geoms)
    print(f"{f:60s} objects={len(geoms):2d} triangles={tris:7d} size={size} watertight={wt}/{len(geoms)}")
