import * as THREE from 'three';

export const SCALE = 0.02; // world units per metre

/**
 * Decode a 16-bit greyscale PNG without going through a canvas.
 *
 * A 2D canvas only hands back 8 bits per channel. The elevation range here is
 * about 4,700 m, so 8 bits would quantise the terrain into ~18 m steps, which
 * show up as terraces once vertical exaggeration is applied. Reading the PNG
 * chunks directly keeps all 65,536 levels.
 *
 * Supports exactly what heightmap.png is: colour type 0 (grey), bit depth 16,
 * non-interlaced. Anything else throws, and the caller falls back to a canvas.
 */
async function decodePng16(buffer) {
  const dv = new DataView(buffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => dv.getUint8(i) === b)) throw new Error('not a PNG');

  let w = 0, h = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idat = [];
  for (let off = 8; off < buffer.byteLength; ) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...new Uint8Array(buffer, off + 4, 4));
    if (type === 'IHDR') {
      w = dv.getUint32(off + 8);
      h = dv.getUint32(off + 12);
      bitDepth = dv.getUint8(off + 16);
      colorType = dv.getUint8(off + 17);
      interlace = dv.getUint8(off + 20);
    } else if (type === 'IDAT') {
      idat.push(new Uint8Array(buffer, off + 8, len));
    } else if (type === 'IEND') break;
    off += 12 + len; // length + type + data + crc
  }
  if (bitDepth !== 16 || colorType !== 0 || interlace !== 0) {
    throw new Error('heightmap is not 16-bit greyscale');
  }

  // IDAT is a zlib stream; the browser's DecompressionStream('deflate') inflates it.
  const inflated = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(inflated).arrayBuffer());

  // Undo PNG row filters. Each row is 1 filter byte + w * 2 data bytes.
  const bpp = 2;
  const stride = w * bpp;
  const out = new Uint16Array(w * h);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p++];
      const a = i >= bpp ? cur[i - bpp] : 0; // left
      const b = prev[i]; // up
      const c = i >= bpp ? prev[i - bpp] : 0; // up-left
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); // Paeth
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = (cur[2 * x] << 8) | cur[2 * x + 1]; // big-endian
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out, max: 65535 };
}

/** 8-bit fallback: draw the image to a canvas and read the red channel. */
async function decodeViaCanvas(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const data = new Uint16Array(cv.width * cv.height);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4];
  return { w: cv.width, h: cv.height, data, max: 255 };
}

async function loadHeights(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await decodePng16(await res.arrayBuffer());
  } catch (err) {
    console.warn('16-bit heightmap decode failed, using 8-bit canvas read:', err);
    return decodeViaCanvas(url);
  }
}

/**
 * Build the terrain mesh.
 * @param {object} T          parsed terrain.json
 * @param {string} base       asset base URL
 * @param {number} exag       initial vertical exaggeration
 */
export async function createTerrain(T, base, exag) {
  const [H, W] = T.grid;
  const [hm, costTex] = await Promise.all([
    loadHeights(base + 'heightmap.png').catch(() => {
      throw new Error('heightmap.png');
    }),
    new THREE.TextureLoader().loadAsync(base + 'costmap.png').catch(() => {
      throw new Error('costmap.png');
    }),
  ]);
  if (hm.w !== W || hm.h !== H) {
    throw new Error(`heightmap.png is ${hm.w}x${hm.h}, terrain.json says ${W}x${H}`);
  }

  // Normalised elevation 0..1, row-major, row 0 = north edge of the grid.
  const norm = new Float32Array(W * H);
  for (let i = 0; i < norm.length; i++) norm[i] = hm.data[i] / hm.max;

  const width = W * T.px_m * SCALE;
  const depth = H * T.px_m * SCALE;
  const relief = (T.elev_max - T.elev_min) * SCALE; // world units at exaggeration 1

  // One vertex per grid cell. After rotateX(-90°) the plane lies in XZ with
  // vertex index = row * W + col, row 0 at -Z (north) and col 0 at -X (west),
  // which is the same order as the heightmap pixels.
  const geo = new THREE.PlaneGeometry(width, depth, W - 1, H - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;

  let currentExag = exag;
  function displace(e) {
    currentExag = e;
    for (let i = 0; i < norm.length; i++) pos.setY(i, norm[i] * relief * e);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
  }
  displace(exag);

  // The costmap is data, not colour: keep its raw values and don't mipmap it.
  costTex.colorSpace = THREE.NoColorSpace;
  costTex.generateMipmaps = false;
  costTex.minFilter = THREE.LinearFilter;
  costTex.magFilter = THREE.LinearFilter;

  // Colours are given as display (sRGB) values; convert once to linear for the shader.
  const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  const uniforms = {
    uCostMap: { value: costTex },
    uCostMix: { value: 0.6 },
    uBase: { value: srgb(0.42, 0.26, 0.17) },
    uLow: { value: srgb(0.1, 0.17, 0.29) },
    uHigh: { value: srgb(1.0, 0.48, 0.18) },
    uBlocked: { value: srgb(0.95, 0.95, 0.95) },
  };

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });

  // Patch the standard shader instead of replacing it, so lighting and shadows
  // keep working. We only swap the albedo (diffuseColor) before lighting runs.
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // MeshStandardMaterial only declares vUv when it has a texture map, so pass
    // our own varying.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCostUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCostUv = uv;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uCostMap;
        uniform float uCostMix;
        uniform vec3 uBase, uLow, uHigh, uBlocked;
        varying vec2 vCostUv;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // costmap: R = normalised traversal cost, G = hazard, B = impassable flag
        vec4 cm = texture2D(uCostMap, vCostUv);
        vec3 costCol = mix(uLow, uHigh, cm.r);          // cool = cheap, orange = costly
        vec3 albedo = mix(uBase, costCol, uCostMix);    // 0 = bare surface, 1 = cost view
        albedo = mix(albedo, uBlocked, step(0.5, cm.b)); // impassable is near-white at any mix
        diffuseColor.rgb = albedo;`
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  // ── helpers shared with routes / rover / stations ──

  /** Grid cell (row, col, may be fractional) → world x, z. */
  function cellToXZ(r, c) {
    return [(c / (W - 1) - 0.5) * width, (r / (H - 1) - 0.5) * depth];
  }

  /** Bilinear surface height (world units, at the current exaggeration). */
  function heightAt(x, z) {
    const c = THREE.MathUtils.clamp((x / width + 0.5) * (W - 1), 0, W - 1.001);
    const r = THREE.MathUtils.clamp((z / depth + 0.5) * (H - 1), 0, H - 1.001);
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const fc = c - c0, fr = r - r0;
    const i = r0 * W + c0;
    const top = norm[i] * (1 - fc) + norm[i + 1] * fc;
    const bot = norm[i + W] * (1 - fc) + norm[i + W + 1] * fc;
    return (top * (1 - fr) + bot * fr) * relief * currentExag;
  }

  /** Surface normal from central differences over a footprint of `d` units. */
  function normalAt(x, z, d = 6, target = new THREE.Vector3()) {
    const dx = heightAt(x + d, z) - heightAt(x - d, z);
    const dz = heightAt(x, z + d) - heightAt(x, z - d);
    return target.set(-dx, 2 * d, -dz).normalize();
  }

  return {
    mesh,
    width,
    depth,
    cellToXZ,
    heightAt,
    normalAt,
    setExag: displace,
    setCostMix: (v) => (uniforms.uCostMix.value = v),
    get maxHeight() {
      return relief * currentExag;
    },
  };
}
