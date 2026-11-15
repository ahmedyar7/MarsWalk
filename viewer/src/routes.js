import * as THREE from 'three';

const LIFT = 2; // world units above the surface, so lines don't z-fight the terrain

/**
 * Planned route (orange tube) and direct line (dashed white).
 *
 * The rover drives along `path`, a flat (y = 0) Catmull-Rom curve through the
 * route cells. Keeping it flat means its arc length is map distance, so the
 * rover's progress doesn't change when vertical exaggeration does. The visible
 * tube is rebuilt from that curve with heights sampled from the terrain.
 */
export function createRoutes(T, terrain) {
  const group = new THREE.Group();

  const flat = (cells) =>
    cells.map(([r, c]) => {
      const [x, z] = terrain.cellToXZ(r, c);
      return new THREE.Vector3(x, 0, z);
    });

  // 'centripetal' avoids the overshoot loops uniform Catmull-Rom makes on the
  // stair-stepped cell path.
  const path = new THREE.CatmullRomCurve3(flat(T.route), false, 'centripetal');
  const directPts = flat(T.direct);

  const tubeMat = new THREE.MeshStandardMaterial({
    color: 0xff7a2f,
    emissive: 0xff7a2f,
    emissiveIntensity: 0.35, // keeps the route readable in shadow
    roughness: 0.6,
  });
  const tube = new THREE.Mesh(new THREE.BufferGeometry(), tubeMat);

  const lineMat = new THREE.LineDashedMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.4,
    dashSize: 6,
    gapSize: 5,
  });
  const direct = new THREE.Line(new THREE.BufferGeometry(), lineMat);

  group.add(tube, direct);

  /** Re-drape both lines over the terrain. Call after exaggeration changes. */
  function rebuild() {
    const N = 600;
    const draped = [];
    for (let i = 0; i <= N; i++) {
      const p = path.getPointAt(i / N);
      p.y = terrain.heightAt(p.x, p.z) + LIFT;
      draped.push(p);
    }
    tube.geometry.dispose();
    tube.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(draped), N, 1.2, 8, false);

    const pts = directPts.map((p) => new THREE.Vector3(p.x, terrain.heightAt(p.x, p.z) + LIFT, p.z));
    direct.geometry.dispose();
    direct.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    direct.computeLineDistances(); // required for dashes
  }
  rebuild();

  return {
    group,
    path,
    rebuild,
    setRouteVisible: (v) => (tube.visible = v),
    setDirectVisible: (v) => (direct.visible = v),
  };
}
