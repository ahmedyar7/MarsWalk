import * as THREE from 'three';

const MARKER_LIFT = 20; // world units above the surface
const MARKER_SIZE = 24;

/** One threshold set for marker colour and verdict, so they can never disagree. */
export function hazardLevel(h) {
  if (h < 0.1) return { key: 'ok', color: '#52e08a', verdict: 'CLEAR' };
  if (h <= 0.3) return { key: 'warn', color: '#ffb020', verdict: 'CAUTION' };
  return { key: 'bad', color: '#ff5252', verdict: 'REROUTE' };
}

/** Round marker texture: coloured disc, dark ring, station number. */
function markerTexture(id, color) {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(7,6,5,0.85)';
  ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = '500 50px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(id).padStart(2, '0'), s / 2, s / 2 + 3);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createStations(T, terrain) {
  const group = new THREE.Group();
  const sprites = [];
  const items = [];

  for (const st of T.stations) {
    const level = hazardLevel(st.hazard);
    const [x, z] = terrain.cellToXZ(st.rc[0], st.rc[1]);

    // Sprites always face the camera, which is what makes them billboards.
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: markerTexture(st.id, level.color), transparent: true })
    );
    sprite.scale.setScalar(MARKER_SIZE);
    sprite.userData.station = st;

    // thin stem down to the ground so it's clear which spot the marker belongs to
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
      new THREE.LineBasicMaterial({ color: level.color, transparent: true, opacity: 0.6 })
    );
    stem.scale.y = MARKER_LIFT - MARKER_SIZE / 2;

    group.add(sprite, stem);
    sprites.push(sprite);
    items.push({ x, z, sprite, stem });
  }

  /** Put markers back on the surface. Call after exaggeration changes. */
  function reposition() {
    for (const it of items) {
      const y = terrain.heightAt(it.x, it.z);
      it.stem.position.set(it.x, y, it.z);
      it.sprite.position.set(it.x, y + MARKER_LIFT, it.z);
    }
  }
  reposition();

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /** Station under a pointer position (client coords), or null. */
  function pick(clientX, clientY, camera, canvas) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(sprites, false)[0];
    return hit ? hit.object.userData.station : null;
  }

  /** Enlarge the selected marker a little. */
  function setSelected(id) {
    for (const s of sprites) {
      s.scale.setScalar(s.userData.station.id === id ? MARKER_SIZE * 1.35 : MARKER_SIZE);
    }
  }

  return { group, reposition, pick, setSelected };
}
