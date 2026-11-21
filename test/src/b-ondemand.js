// r187, renders ONLY on OrbitControls change (no loop). Duck + sphere.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 1, 4);
const controls = new OrbitControls(camera, renderer.domElement);
const render = () => renderer.render(scene, camera);
controls.addEventListener("change", render);
scene.add(new THREE.AmbientLight(0xffffff, 2));
const s = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16), new THREE.MeshNormalMaterial());
s.name = "Sphere"; s.position.x = 1.5; scene.add(s);
new GLTFLoader().load("models/Duck.glb", (g) => { scene.add(g.scene); render(); document.title = "loaded"; });
