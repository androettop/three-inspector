import sys, glob, zipfile, trimesh, numpy as np
for f in sorted(glob.glob("out/*.stl")) + sorted(glob.glob("out/*.3mf")):
    if f.endswith(".3mf"):
        z = zipfile.ZipFile(f); assert z.testzip() is None, "bad zip"
        names = z.namelist()
    s = trimesh.load(f, force="scene")
    geoms = list(s.geometry.values())
    tris = sum(len(g.faces) for g in geoms)
    b = s.bounds
    wt = [g.is_watertight for g in geoms]
    print(f"{f:24s} objs={len(geoms):2d} tris={tris:6d} size={np.round(b[1]-b[0],1)} watertight={sum(wt)}/{len(wt)}" + (f" files={names}" if f.endswith('.3mf') else ""))
