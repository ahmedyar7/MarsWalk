import * as THREE from 'three';

// The rover is drawn far larger than life: at 0.02 units per metre a real one
// would be a few hundredths of a unit long and invisible. The HUD says so.
const ROVER_SIZE = 6;
const LAP_SECONDS = 70; // time for the whole route at 1x speed

/** Thin box between two points, used for the rocker-bogie struts. */
function strut(a, b, thickness, material) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, len), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b);
  return m;
}

/** A generic six-wheeled rover from primitives. Forward is +Z, up is +Y, wheels rest on y = 0. */
function buildModel() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x9a9388, metalness: 0.55, roughness: 0.5 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xa8854a, metalness: 0.7, roughness: 0.42 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2824, metalness: 0.3, roughness: 0.8 });

  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.45, 2.9), body);
  deck.position.y = 1.15;
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 2.6), gold);
  top.position.y = 1.41;
  g.add(deck, top);

  // power unit at the back, angled up
  const power = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.9, 12), dark);
  power.position.set(0, 1.45, -1.55);
  power.rotation.x = -Math.PI / 3;
  g.add(power);

  // camera mast with a small head and two lenses
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.3, 10), body);
  mast.position.set(0.55, 2.08, 1.05);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.24, 0.26), gold);
  head.position.set(0.55, 2.8, 1.05);
  g.add(mast, head);
  for (const dx of [-0.13, 0.13]) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10), dark);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0.55 + dx, 2.8, 1.2);
    g.add(lens);
  }

  // small dish antenna
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.26, 0.06, 16), body);
  dish.position.set(-0.55, 1.75, -0.7);
  dish.rotation.x = 0.5;
  const dishPost = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 8), dark);
  dishPost.position.set(-0.55, 1.58, -0.7);
  g.add(dish, dishPost);

  // wheels + rocker-bogie: front wheel on the rocker arm, middle and rear on the bogie
  const wheels = [];
  const R = 0.42;
  const wheelGeo = new THREE.CylinderGeometry(R, R, 0.34, 18);
  wheelGeo.rotateZ(Math.PI / 2); // axle along X
  const hubGeo = new THREE.CylinderGeometry(R * 0.45, R * 0.45, 0.36, 10);
  hubGeo.rotateZ(Math.PI / 2);
  for (const side of [-1, 1]) {
    const x = side * 1.32;
    const hubs = [1.3, 0, -1.25].map((z) => new THREE.Vector3(x, R, z));
    for (const h of hubs) {
      const w = new THREE.Group();
      w.add(new THREE.Mesh(wheelGeo, dark), new THREE.Mesh(hubGeo, gold));
      // a tread bar so the rotation is visible
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, R * 1.9), body);
      w.add(bar);
      w.position.copy(h);
      wheels.push(w);
      g.add(w);
    }
    const pivot = new THREE.Vector3(side * 1.02, 1.1, 0.35); // on the deck side
    const bogie = new THREE.Vector3(x, 0.85, -0.62); // bogie joint above mid/rear wheels
    g.add(
      strut(pivot, hubs[0], 0.09, body), // rocker → front wheel
      strut(pivot, bogie, 0.09, body), // rocker → bogie joint
      strut(bogie, hubs[1], 0.08, body), // bogie → middle wheel
      strut(bogie, hubs[2], 0.08, body), // bogie → rear wheel
      strut(pivot, new THREE.Vector3(side * 0.95, 1.1, 0.35), 0.12, dark)
    );
  }

  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  g.scale.setScalar(ROVER_SIZE);
  return { group: g, wheels, wheelRadius: R * ROVER_SIZE };
}

export function createRover(terrain, path) {
  const { group, wheels, wheelRadius } = buildModel();
  const pathLength = path.getLength();

  let t = 0; // 0..1 along the route
  const state = { playing: true, speed: 1 };

  // scratch objects, reused every frame
  const pos = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const targetQ = new THREE.Quaternion();
  let first = true;

  function update(dt) {
    let moved = 0;
    if (state.playing) {
      const dT = (dt * state.speed) / LAP_SECONDS;
      t += dT;
      moved = dT * pathLength;
      if (t >= 1) t = 0; // loop back to the habitat
    }

    path.getPointAt(t, pos);
    path.getTangentAt(t, tangent);
    pos.y = terrain.heightAt(pos.x, pos.z);

    // Sit on the terrain: 'up' is the local surface normal (sampled over the
    // rover's footprint), and 'forward' is the route tangent projected onto
    // the surface so the rover pitches with the slope it is climbing.
    terrain.normalAt(pos.x, pos.z, wheelRadius * 3, up);
    fwd.copy(tangent).addScaledVector(up, -tangent.dot(up)).normalize();
    right.crossVectors(up, fwd).normalize();
    basis.makeBasis(right, up, fwd);
    targetQ.setFromRotationMatrix(basis);

    group.position.copy(pos);
    if (first) {
      group.quaternion.copy(targetQ);
      first = false;
    } else {
      // ease toward the target so cell-to-cell kinks don't snap the body
      group.quaternion.slerp(targetQ, 1 - Math.exp(-dt * 6));
    }

    for (const w of wheels) w.rotation.x += moved / wheelRadius;
  }

  return {
    group,
    state,
    update,
    get progress() {
      return t;
    },
    /** World-space forward direction of the rover (unit vector). */
    forward: (target) => target.copy(fwd),
  };
}
