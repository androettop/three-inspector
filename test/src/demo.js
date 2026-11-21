// Material showcase used for the store screenshots (procedural, no assets).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.name = "Showroom";
scene.background = new THREE.Color(0x1b1e24);
scene.fog = new THREE.Fog(0x1b1e24, 9, 22);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.name = "Main Camera";
camera.position.set(0, 2.4, 7.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.8, 0);
controls.update();

const sun = new THREE.DirectionalLight(0xfff1e0, 2.2);
sun.name = "Sun";
sun.position.set(4, 7, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -6;
sun.shadow.camera.right = sun.shadow.camera.top = 6;
scene.add(sun);
const rim = new THREE.PointLight(0x5b8cff, 30, 12);
rim.name = "Rim Light";
rim.position.set(-3.5, 2.5, -2.5);
scene.add(rim);

const floor = new THREE.Mesh(new THREE.CircleGeometry(8, 96), new THREE.MeshStandardMaterial({ name: "Floor", color: 0x2a2f38, roughness: 0.85 }));
floor.name = "Floor";
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const props = new THREE.Group();
props.name = "Props";
scene.add(props);

function add(mesh, name, x, y, z) {
  mesh.name = name;
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  props.add(mesh);
  return mesh;
}

const pedestalMat = new THREE.MeshStandardMaterial({ name: "Concrete", color: 0x8d939c, roughness: 0.9 });
for (const [i, x] of [-2.6, 0, 2.6].entries()) add(new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, 0.5, 48), pedestalMat), `Pedestal ${i + 1}`, x, 0.25, 0);

const knot = add(new THREE.Mesh(
  new THREE.TorusKnotGeometry(0.55, 0.19, 220, 32),
  new THREE.MeshPhysicalMaterial({ name: "Coral Lacquer", color: 0xff5a36, roughness: 0.25, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.1 })
), "Torus Knot", 0, 1.45, 0);

add(new THREE.Mesh(
  new THREE.SphereGeometry(0.62, 64, 32),
  new THREE.MeshStandardMaterial({ name: "Polished Chrome", color: 0xe8ecf2, roughness: 0.08, metalness: 1 })
), "Chrome Sphere", -2.6, 1.12, 0);

// Checker texture drawn on a canvas, so its thumbnail shows in the panel.
const c = document.createElement("canvas");
c.width = c.height = 256;
const g = c.getContext("2d");
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
  g.fillStyle = (x + y) % 2 ? "#f2c14e" : "#2f3e57";
  g.fillRect(x * 32, y * 32, 32, 32);
}
const checker = new THREE.CanvasTexture(c);
checker.name = "checker.png";
checker.colorSpace = THREE.SRGBColorSpace;

// Blob with morph targets: "Spikes" and "Twist".
const blobGeo = new THREE.IcosahedronGeometry(0.62, 24);
const base = blobGeo.attributes.position;
const spikes = [], twist = [], v = new THREE.Vector3();
for (let i = 0; i < base.count; i++) {
  v.fromBufferAttribute(base, i);
  const n = v.clone().normalize();
  const s = 1 + 0.35 * Math.max(0, Math.sin(n.x * 9) * Math.sin(n.y * 9) * Math.sin(n.z * 9));
  spikes.push(v.x * s, v.y * s, v.z * s);
  const a = v.y * 2.2;
  twist.push(v.x * Math.cos(a) - v.z * Math.sin(a), v.y, v.x * Math.sin(a) + v.z * Math.cos(a));
}
blobGeo.morphAttributes.position = [new THREE.Float32BufferAttribute(spikes, 3), new THREE.Float32BufferAttribute(twist, 3)];
const blob = add(new THREE.Mesh(blobGeo, new THREE.MeshStandardMaterial({ name: "Checker", map: checker, roughness: 0.55 })), "Morph Blob", 2.6, 1.15, 0);
blob.morphTargetDictionary = { Spikes: 0, Twist: 1 };
blob.morphTargetInfluences = [0.45, 0];

for (let i = 0; i < 7; i++) {
  const a = (i / 7) * Math.PI * 2;
  add(new THREE.Mesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshStandardMaterial({ name: "Glow", color: 0x6ee7b7, emissive: 0x1f8f6a, emissiveIntensity: 1.2, roughness: 0.4 })),
    `Gem ${i + 1}`, Math.cos(a) * 4.2, 0.35, Math.sin(a) * 4.2 - 1.2);
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  knot.rotation.y = t * 0.4;
  renderer.render(scene, camera);
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
document.title = "loaded";
