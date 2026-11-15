import { hazardLevel } from './stations.js';

const $ = (id) => document.getElementById(id);

const CLASS_COLORS = {
  soil: 'var(--soil)',
  bedrock: 'var(--bedrock)',
  sand: 'var(--sand)',
  'big rock': 'var(--rock)',
};

// ── loading / error overlay ──

export function hideLoading() {
  $('overlay').classList.add('done');
}

export function showError(title, detail) {
  const o = $('overlay');
  o.classList.remove('done');
  o.classList.add('error');
  $('overlayLabel').textContent = title;
  $('overlayMsg').textContent = detail;
}

// ── static HUD text from terrain.json ──

export function fillHud(T) {
  $('siteName').textContent = T.site.name;
  $('siteObjective').textContent = T.site.objective;
  $('note').textContent = T.note;

  const r = T.stats.route;
  const d = T.stats.direct;
  const pct = (a, b) => (a / b - 1) * 100;
  const signed = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0) + '%';

  $('statDist').textContent = (r.distance_m / 1000).toFixed(1) + ' km';
  $('statDistDelta').innerHTML =
    `<b>${signed(pct(r.distance_m, d.distance_m))}</b> vs direct ${(d.distance_m / 1000).toFixed(1)} km`;

  $('statHaz').textContent = r.mean_hazard.toFixed(3);
  $('statHazDelta').innerHTML =
    `<b>${signed(pct(r.mean_hazard, d.mean_hazard))}</b> vs direct ${d.mean_hazard.toFixed(3)}`;
}

// ── station side panel ──

let openId = null;

export function openStation(st, base) {
  openId = st.id;
  const level = hazardLevel(st.hazard);

  $('stId').textContent = 'ST-' + String(st.id).padStart(2, '0');
  $('stMeta').textContent =
    `Elev ${Math.round(st.elev_m)} m · Slope ${st.slope_deg.toFixed(1)}° · Hazard ${(st.hazard * 100).toFixed(0)}%`;
  $('stRaw').src = `${base}stations/st${st.id}_raw.jpg`;
  $('stSeg').src = `${base}stations/st${st.id}_seg.jpg`;

  $('stCov').innerHTML = Object.entries(st.coverage)
    .map(([name, v]) => {
      const p = (v * 100).toFixed(1);
      const color = CLASS_COLORS[name] || 'var(--dim)';
      return `<div class="cov-row">
        <span class="lab">${name}</span>
        <span class="track"><i style="width:${p}%;background:${color}"></i></span>
        <span class="pct">${p}%</span>
      </div>`;
    })
    .join('');

  const v = $('stVerdict');
  v.style.borderColor = level.color;
  v.innerHTML = `<span class="dot" style="background:${level.color}"></span>
    <span class="t" style="color:${level.color}">${level.verdict}</span>
    <span class="d">${(st.hazard * 100).toFixed(0)}% sand + big rock</span>`;

  $('station').hidden = false;
}

export function closeStation() {
  openId = null;
  $('station').hidden = true;
}

export const openStationId = () => openId;

// ── controls ──

/**
 * Wire the control panel. `on` holds one callback per control; each is also
 * called once with the control's initial value so the scene and the UI start
 * in the same state.
 */
export function bindControls(on) {
  const slider = (id, labelId, fmt, cb) => {
    const el = $(id);
    const apply = () => {
      const v = parseFloat(el.value);
      $(labelId).textContent = fmt(v);
      cb(v);
    };
    el.addEventListener('input', apply);
    apply();
  };

  const exagText = (v) => '×' + (Number.isInteger(v) ? v : v.toFixed(1));
  slider('exag', 'exagVal', exagText, (v) => {
    $('exagBadge').textContent = exagText(v); // the always-visible label
    on.exag(v);
  });
  slider('mix', 'mixVal', (v) => v.toFixed(2), on.costMix);
  slider('sun', 'sunVal', (v) => v.toFixed(0) + '°', on.sunAzimuth);
  slider('speed', 'speedVal', (v) => v.toFixed(2).replace(/0$/, '') + '×', on.speed);

  const check = (id, cb) => {
    const el = $(id);
    el.addEventListener('change', () => cb(el.checked));
    cb(el.checked);
  };
  check('showRoute', on.showRoute);
  check('showDirect', on.showDirect);

  $('play').addEventListener('click', on.togglePlay);
  $('ride').addEventListener('click', on.toggleRide);
  $('stClose').addEventListener('click', on.closeStation);

  $('ctlToggle').addEventListener('click', () => {
    const collapsed = $('controls').classList.toggle('collapsed');
    $('ctlToggle').setAttribute('aria-expanded', String(!collapsed));
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if (e.key === 'c' || e.key === 'C') on.toggleRide();
    else if (e.key === 'Escape') on.closeStation();
    else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
      // (a focused button already handles Space itself)
      e.preventDefault();
      on.togglePlay();
    }
  });
}

export function setPlaying(playing) {
  $('play').textContent = playing ? 'Pause' : 'Play';
}

export function setRide(active) {
  $('ride').classList.toggle('on', active);
}

export function setProgress(doneKm, totalKm) {
  $('progress').textContent = `${doneKm.toFixed(1)} / ${totalKm.toFixed(1)} km`;
}
