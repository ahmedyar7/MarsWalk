import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createTerrain } from './terrain.js';
import { createRoutes } from './routes.js';
import { createRover } from './rover.js';
import { createStations } from './stations.js';
import * as ui from './ui.js';

const BASE = import.meta.env.BASE_URL; // '/MarsWalk/viewer/' in production
const SUN_ELEVATION = THREE.MathUtils.degToRad(24); // low sun, long shadows

async function loadTerrainJson() {
  let res;
  try {
    res = await fetch(BASE + 'terrain.json');
  } catch {
    throw new Error('terrain.json');
  }
  if (!res.ok) throw new Error('terrain.json');
  const T = await res.json();
  // Fail early with a readable message if the file isn't the shape we build against.
  for (const k of ['grid', 'px_m', 'elev_min', 'elev_max', 'route', 'direct', 'stations', 'stats', 'site']) {
    if (!(k in T)) throw new Error(`terrain.json is missing "${k}"`);
  }
  return T;
}

async function init() {
  const canvas = document.getElementById('scene');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    ui.showError('WebGL unavailable', 'This viewer needs WebGL. Try a current desktop browser with hardware acceleration on.');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070605);

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 8000);

  // ── data + scene objects ──
  const T = await loadTerrainJson();
  ui.fillHud(T);

  const terrain = await createTerrain(T, BASE, 3);
  const routes = createRoutes(T, terrain);
  const rover = createRover(terrain, routes.path);
  const stations = createStations(T, terrain);
  scene.add(terrain.mesh, routes.group, rover.group, stations.group);

  // ── lighting ──
  // Cool, low ambient so shadowed slopes stay readable; warm low sun for relief.
  scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x3a2a20, 1.5));
  const sun = new THREE.DirectionalLight(0xffe2c0, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const span = Math.max(terrain.width, terrain.depth) * 0.75;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 50, far: 4000 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 1.2;
  scene.add(sun, sun.target);

  function setSunAzimuth(deg) {
    // Azimuth is measured clockwise from north (-Z), like a compass bearing.
    const a = THREE.MathUtils.degToRad(deg);
    const dist = 1500;
    sun.target.position.set(0, terrain.maxHeight * 0.3, 0);
    sun.position.set(
      Math.sin(a) * Math.cos(SUN_ELEVATION) * dist,
      Math.sin(SUN_ELEVATION) * dist + sun.target.position.y,
      -Math.cos(a) * Math.cos(SUN_ELEVATION) * dist
    );
  }

  // ── camera: orbit by default, ride-along on demand ──
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49; // don't go under the ground
  controls.minDistance = 60;
  controls.maxDistance = 2600;
  controls.target.set(0, terrain.maxHeight * 0.3, 0);
  // Three-quarter view from the north-west: the route crosses the crater floor
  // in front, with the central mound rising behind it.
  camera.position.set(-terrain.width * 0.78, terrain.maxHeight * 0.3 + terrain.width * 0.5, -terrain.depth * 0.8);
  controls.update();

  // 'orbit' → user control. 'ride' → follow the rover. 'return' → easing back
  // to where the orbit camera was before the ride started.
  let camMode = 'orbit';
  const saved = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  const look = new THREE.Vector3(); // point the camera is looking at during ride/return
  const want = new THREE.Vector3();
  const wantLook = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function toggleRide() {
    if (camMode === 'ride') {
      camMode = 'return';
    } else {
      if (camMode === 'orbit') {
        saved.pos.copy(camera.position);
        saved.target.copy(controls.target);
        look.copy(controls.target);
      }
      camMode = 'ride';
      controls.enabled = false;
    }
    ui.setRide(camMode === 'ride');
  }

  function updateCamera(dt) {
    if (camMode === 'orbit') {
      controls.update();
      return;
    }
    if (camMode === 'ride') {
      // behind and slightly above the rover, looking ahead along its heading
      rover.forward(fwd);
      const p = rover.group.position;
      want.copy(p).addScaledVector(fwd, -62);
      want.y = p.y + 24;
      // never let the chase camera dip into a hillside
      want.y = Math.max(want.y, terrain.heightAt(want.x, want.z) + 8);
      wantLook.copy(p).addScaledVector(fwd, 45);
      wantLook.y += 5;
    } else {
      want.copy(saved.pos);
      wantLook.copy(saved.target);
    }
    // Exponential easing: frame-rate independent, and the same code gives a
    // smooth move both into and out of ride-along.
    const k = 1 - Math.exp(-dt * 2.6);
    camera.position.lerp(want, k);
    look.lerp(wantLook, k);
    camera.lookAt(look);

    if (camMode === 'return' && camera.position.distanceTo(saved.pos) < 1) {
      camera.position.copy(saved.pos);
      controls.target.copy(saved.target);
      controls.enabled = true;
      controls.update();
      camMode = 'orbit';
    }
  }

  // ── station picking ──
  function closeStation() {
    ui.closeStation();
    stations.setSelected(null);
  }
  function selectStation(st) {
    if (!st) return;
    if (ui.openStationId() === st.id) return closeStation(); // second click closes
    ui.openStation(st, BASE);
    stations.setSelected(st.id);
  }
  // Treat it as a click only if the pointer barely moved, so orbit drags that
  // end on a marker don't open the panel.
  let down = null;
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
      selectStation(stations.pick(e.clientX, e.clientY, camera, canvas));
    }
    down = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    canvas.style.cursor = stations.pick(e.clientX, e.clientY, camera, canvas) ? 'pointer' : '';
  });

  // ── controls ──
  function togglePlay() {
    rover.state.playing = !rover.state.playing;
    ui.setPlaying(rover.state.playing);
  }

  ui.bindControls({
    exag(v) {
      terrain.setExag(v);
      routes.rebuild();
      stations.reposition();
      setSunAzimuth(parseFloat(document.getElementById('sun').value));
    },
    costMix: terrain.setCostMix,
    sunAzimuth: setSunAzimuth,
    speed: (v) => (rover.state.speed = v),
    showRoute: routes.setRouteVisible,
    showDirect: routes.setDirectVisible,
    togglePlay,
    toggleRide,
    closeStation,
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── render loop ──
  const totalKm = T.stats.route.distance_m / 1000;
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    // Clamp so a backgrounded tab doesn't make the rover leap when it returns.
    const dt = Math.min(clock.getDelta(), 0.1);
    rover.update(dt);
    updateCamera(dt);
    ui.setProgress(rover.progress * totalKm, totalKm);
    renderer.render(scene, camera);
  });

  // Optional deep links: ?station=11 opens that station, ?ride=1 starts in ride-along.
  const q = new URLSearchParams(location.search);
  if (q.has('station')) selectStation(T.stations.find((s) => String(s.id) === q.get('station')));
  if (q.get('ride') === '1') toggleRide();

  ui.hideLoading();
}

init().catch((err) => {
  console.error(err);
  const name = err?.message || 'unknown error';
  const isAsset = /\.(png|json|jpg)$/.test(name);
  ui.showError(
    isAsset ? 'Asset failed to load' : 'Viewer failed to start',
    isAsset
      ? `Could not load ${name}.\nCheck that it exists in viewer/public/ and that the page is served from ${BASE}`
      : name
  );
});
