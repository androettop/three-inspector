const http = require("http"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "site");
const types = { ".html": "text/html", ".js": "text/javascript", ".glb": "model/gltf-binary" };
for (const port of [8701, 8702])
  http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split("?")[0]));
    if (!f.startsWith(root) || !fs.existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  }).listen(port, "127.0.0.1");
console.log("serving");
