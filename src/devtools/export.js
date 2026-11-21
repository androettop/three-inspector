// STL and 3MF writers. Each part is { name, color, tris } where tris is a
// Float32Array world-space triangle soup (9 floats per triangle).

// Optional Y-up → Z-up conversion: rotate +90° about X → (x, -z, y).
export function transform(tris, scale, zUp) {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i] * scale, y = tris[i + 1] * scale, z = tris[i + 2] * scale;
    out[i] = x;
    out[i + 1] = zUp ? -z : y;
    out[i + 2] = zUp ? y : z;
  }
  return out;
}

export function writeSTL(parts) {
  const total = parts.reduce((s, p) => s + p.tris.length / 9, 0);
  const buf = new ArrayBuffer(84 + total * 50);
  const dv = new DataView(buf);
  const header = "Three Inspector STL export";
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, total, true);
  let o = 84;
  for (const { tris: t } of parts)
    for (let i = 0; i < t.length; i += 9) {
      const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
      const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true);
      dv.setFloat32(o + 4, ny / l, true);
      dv.setFloat32(o + 8, nz / l, true);
      o += 12;
      for (let k = 0; k < 9; k++, o += 4) dv.setFloat32(o, t[i + k], true);
      o += 2;
    }
  return buf;
}

const xmlEsc = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const num = (v) => {
  const r = Math.round(v * 1e5) / 1e5;
  return Object.is(r, -0) ? "0" : String(r);
};

export async function write3MF(parts, separate) {
  const enc = new TextEncoder();
  const chunks = [];
  let buf = "";
  const push = (s) => {
    buf += s;
    if (buf.length > 1 << 20) {
      chunks.push(enc.encode(buf));
      buf = "";
    }
  };
  const groups = separate ? parts : [{ name: parts.length === 1 ? parts[0].name : "Model", color: parts[0].color, tris: null, all: parts }];

  push('<?xml version="1.0" encoding="UTF-8"?>\n');
  push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  push(' <metadata name="Application">Three Inspector</metadata>\n <resources>\n  <basematerials id="1">\n');
  groups.forEach((g, i) => push(`   <base name="${xmlEsc(g.name || "mat" + i)}" displaycolor="${(g.color || "#c8c8c8").toUpperCase()}FF"/>\n`));
  push("  </basematerials>\n");
  const ids = [];
  groups.forEach((g, gi) => {
    const id = gi + 2;
    ids.push(id);
    push(`  <object id="${id}" type="model" name="${xmlEsc(g.name || "Object " + gi)}" pid="1" pindex="${gi}">\n   <mesh>\n    <vertices>\n`);
    const map = new Map();
    const tri = [];
    let next = 0;
    for (const p of g.all || [g]) {
      const t = p.tris;
      for (let i = 0; i < t.length; i += 3) {
        const key = num(t[i]) + " " + num(t[i + 1]) + " " + num(t[i + 2]);
        let v = map.get(key);
        if (v === undefined) {
          v = next++;
          map.set(key, v);
          const [x, y, z] = key.split(" ");
          push(`     <vertex x="${x}" y="${y}" z="${z}"/>\n`);
        }
        tri.push(v);
      }
    }
    push("    </vertices>\n    <triangles>\n");
    for (let i = 0; i < tri.length; i += 3) {
      const a = tri[i], b = tri[i + 1], c = tri[i + 2];
      if (a === b || b === c || a === c) continue; // degenerate: invalid in 3MF
      push(`     <triangle v1="${a}" v2="${b}" v3="${c}"/>\n`);
    }
    push("    </triangles>\n   </mesh>\n  </object>\n");
  });
  push(" </resources>\n <build>\n");
  ids.forEach((id) => push(`  <item objectid="${id}"/>\n`));
  push(" </build>\n</model>\n");
  chunks.push(enc.encode(buf));

  const files = [
    {
      name: "[Content_Types].xml",
      data: [
        enc.encode(
          '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
        ),
      ],
    },
    {
      name: "_rels/.rels",
      data: [
        enc.encode(
          '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
        ),
      ],
    },
    { name: "3D/3dmodel.model", data: chunks },
  ];
  return zip(files);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(chunks) {
  let c = 0xffffffff;
  for (const d of chunks) for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(chunks) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob(chunks).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zip(files) {
  const enc = new TextEncoder();
  const out = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const size = f.data.reduce((s, d) => s + d.length, 0);
    const crc = crc32(f.data);
    const packed = await deflate(f.data);
    const method = packed ? 8 : 0;
    const body = packed ? [packed] : f.data;
    const csize = packed ? packed.length : size;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, csize, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    out.push(new Uint8Array(local.buffer), name, ...body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, method, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, csize, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + csize;
  }
  const cdSize = central.reduce((s, d) => s + d.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...out, ...central, new Uint8Array(end.buffer)]).arrayBuffer();
}
