// r187 WebGPURenderer (falls back to WebGL2 backend), continuous loop.
import * as THREE from "three/webgpu";
const renderer = new THREE.WebGPURenderer({ forceWebGL: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 5);
const t = new THREE.Mesh(new THREE.TorusGeometry(1, 0.3, 16, 64), new THREE.MeshBasicNodeMaterial({ color: 0x8844ff }));
t.name = "GpuTorus"; scene.add(t);
renderer.setAnimationLoop(() => { t.rotation.x += 0.01; renderer.render(scene, camera); });
document.title = "loaded";
