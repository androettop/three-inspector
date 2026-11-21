// r130 inside a cross-origin iframe, on-demand (pointermove), one mesh with
// its CPU array freed after upload (onUpload dispose pattern).
import * as THREE from "three130";
const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 5);
const ico = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: 0xffcc00, wireframe: false }));
ico.name = "Ico"; scene.add(ico);
const freed = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: 0x00ccff }));
freed.name = "FreedBox"; freed.position.x = 2;
for (const a of Object.values(freed.geometry.attributes)) a.onUpload(function () { this.array = null; });
scene.add(freed);
const render = () => renderer.render(scene, camera);
render();
addEventListener("pointermove", (e) => { ico.rotation.y = e.clientX / 100; render(); });
document.title = "loaded";
