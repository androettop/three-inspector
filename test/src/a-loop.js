// r187, continuous render loop, GLTF skinned (Fox) + instanced + procedural.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x30343c);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(3, 3, 5);
new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 3));
const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 128, 16), new THREE.MeshStandardMaterial({ color: 0xff6633 }));
knot.name = "Knot"; knot.position.set(-1.5, 1, 0); scene.add(knot);
const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0x33aaff }), 5);
inst.name = "Boxes";
const m = new THREE.Matrix4();
for (let i = 0; i < 5; i++) inst.setMatrixAt(i, m.makeTranslation(i * 0.5 - 1, 0.15, 1.5));
scene.add(inst);
new GLTFLoader().load("models/Fox.glb", (g) => {
  g.scene.scale.setScalar(0.02); scene.add(g.scene);
  const mixer = new THREE.AnimationMixer(g.scene); mixer.clipAction(g.animations[0]).play();
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => { mixer.update(clock.getDelta()); knot.rotation.y += 0.01; renderer.render(scene, camera); });
  document.title = "loaded";
});
