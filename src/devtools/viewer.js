// Preview of the selected object's geometry, drawn with the extension's own
// copy of three.js.
import * as THREE from "../../vendor/three/three.module.js";
import { OrbitControls } from "../../vendor/three/OrbitControls.js";

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(1, 2, 3);
    this.camera.add(key);
    this.scene.add(this.camera);
    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.wireframe = false;
    new ResizeObserver(() => this.resize()).observe(container);
  }

  setTheme(dark) {
    this.scene.background = new THREE.Color(dark ? 0x202124 : 0xf1f3f4);
    this.render();
  }

  clearModel() {
    for (const m of this.model.children) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.model.clear();
  }

  clear() {
    this.clearModel();
    if (this.grid) this.scene.remove(this.grid);
    this.grid = null;
    this.framed = false;
    this.render();
  }

  // parts: [{ name, color, tris: Float32Array (world space) }]
  // keepCamera: refresh the meshes without moving the camera (after edits).
  show(parts, keepCamera) {
    const keep = keepCamera && this.framed;
    if (keep) this.clearModel();
    else this.clear();
    const box = new THREE.Box3();
    for (const p of parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p.tris, 3));
      g.computeVertexNormals();
      g.computeBoundingBox();
      box.union(g.boundingBox);
      const mat = new THREE.MeshStandardMaterial({
        color: p.color || 0xb0b4ba,
        roughness: 0.7,
        metalness: 0.05,
        side: THREE.DoubleSide,
        flatShading: true,
        wireframe: this.wireframe,
      });
      this.model.add(new THREE.Mesh(g, mat));
    }
    if (box.isEmpty() || keep) return this.render();
    this.framed = true;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2 || 1;
    this.grid = new THREE.GridHelper(radius * 4, 20, 0x888888, 0x555555);
    this.grid.position.set(center.x, box.min.y, center.z);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.35;
    this.scene.add(this.grid);
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1.4).normalize().multiplyScalar(radius * 2.6));
    this.controls.target.copy(center);
    this.controls.update();
    this.render();
  }

  setWireframe(on) {
    this.wireframe = on;
    for (const m of this.model.children) m.material.wireframe = on;
    this.render();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
