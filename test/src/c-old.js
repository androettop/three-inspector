// r110 legacy: Geometry (non-buffer) + BufferGeometry, on-demand render on wheel only.
import * as THREE from "three110";
const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 6);
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshBasicMaterial({ color: 0x22cc88 }));
box.name = "LegacyBox"; box.position.x = -1.5; scene.add(box);
const cyl = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.5, 0.5, 2, 24), new THREE.MeshBasicMaterial({ color: 0xcc2288 }));
cyl.name = "BufCylinder"; cyl.position.x = 1.5; cyl.scale.set(-1, 1, 1); scene.add(cyl);
const render = () => renderer.render(scene, camera);
renderer.domElement.addEventListener("wheel", (e) => { camera.position.z += e.deltaY * 0.002; render(); });
render();
document.title = "loaded";
