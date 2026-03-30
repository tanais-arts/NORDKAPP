// NORDKAPP — interactive travel journal
'use strict';

const FRAME_BASE = '../media/frames/frame-';
const MONTHS_FR  = ['','janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
const ACCENT     = '#f0c060';
const DOT_COLOR  = '#f0c060';
const DOT_RADIUS = 4;
const DOT_ACTIVE = 8;

// ── Tiles ───────────────────────────────────────────────────────────
const TILE_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_LIGHT = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

function pad(n)        { return String(n).padStart(4, '0'); }
function frameSrc(n)   { return `${FRAME_BASE}${pad(n)}.jpg`; }
function currentRate() { return parseFloat(document.getElementById('rate-slider')?.value ?? 1); }
function fmtCaption(e) {
  return `${e.day} ${MONTHS_FR[e.month]} · ${e.hour}h${String(e.minute).padStart(2,'0')}`;
}

// ── State ────────────────────────────────────────────────────────────
const state = {
  entries:      [],
  photos:       [],
  cities:       [],
  activeIdx:    null,
  ringMarker:   null,
  markers:      [],
  lbPhotos:     [],
  lbIdx:        0,
  thumbEls:     [],
  activePhotoIdx: null,
  lightTile:    false,
  polylines:    [],
  lastT:        -1,
};

// If set, use this fixed terminator opacity for all timeline previews
let fixedTermOp = null;

// ── Map ──────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView([55, 10], 5);

// Use the light tile set by default for a brighter daytime map
let tileLayer = L.tileLayer(TILE_LIGHT, {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  maxZoom: 19, subdomains: 'abcd',
}).addTo(map);

// ── Inline terminator (day/night shadow) ───────────────────────────
function _termJulian(date) { return date.valueOf() / 86400000 + 2440587.5; }
function _termCompute(date) {
  const pts = [];
  // If SunCalc is available, use it to robustly find the terminator by locating
  // latitudes where the sun altitude crosses the horizon for each longitude.
  if (window.SunCalc) {
    // coarse longitude step for performance
    for (let lngDeg = -180; lngDeg <= 180; lngDeg += 2) {
      // First sweep with coarse lat steps to find a sign change
      let bracketFound = false;
      let prevLat = -80;
      let prevAlt = SunCalc.getPosition(date, prevLat, lngDeg).altitude;
      for (let lat = -72; lat <= 80; lat += 8) {
        const alt = SunCalc.getPosition(date, lat, lngDeg).altitude;
        if (prevAlt === 0) { pts.push([prevLat, lngDeg]); bracketFound = true; break; }
        if (prevAlt * alt <= 0) {
          // refine with smaller step inside bracket
          let found = false;
          for (let rlat = prevLat; rlat <= lat; rlat += 1) {
            const ralt = SunCalc.getPosition(date, rlat, lngDeg).altitude;
            if (ralt === 0) { pts.push([rlat, lngDeg]); found = true; break; }
            if (ralt * prevAlt <= 0) {
              // linear interp between prevLat and rlat
              const t = Math.abs(prevAlt) / (Math.abs(prevAlt) + Math.abs(ralt));
              const root = prevLat + t * (rlat - prevLat);
              pts.push([root, lngDeg]);
              found = true; break;
            }
            prevAlt = ralt; prevLat = rlat;
          }
          if (!found) pts.push([prevLat, lngDeg]);
          bracketFound = true; break;
        }
        prevAlt = alt; prevLat = lat;
      }
      if (!bracketFound) {
        // fallback: choose extreme depending on last sampled altitude
        pts.push([prevAlt > 0 ? 80 : -80, lngDeg]);
      }
    }
    // decide pole inclusion by checking north-pole sun altitude
    const northAlt = SunCalc.getPosition(date, 90, 0).altitude;
    const pole = northAlt > 0 ? -90 : 90;
    return [[pole, -180], ...pts, [pole, 180]];
  }

  // Fallback to original analytic computation if SunCalc is unavailable
  const jd = _termJulian(date), D = jd - 2451545.0;
  const g  = (357.529 + 0.98560028 * D) * Math.PI / 180;
  const q  = 280.459 + 0.98564736 * D;
  const Lr = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180;
  const e  = (23.439 - 0.0000004 * D) * Math.PI / 180;
  const dec = Math.asin(Math.sin(e) * Math.sin(Lr));
  const RA  = Math.atan2(Math.cos(e) * Math.sin(Lr), Math.cos(Lr));
  const GMST = ((6.697375 + 0.0657098242 * D + (D % 1) * 24) % 24 + 24) % 24;
  const lngSun = (-(GMST / 24 * 360) * Math.PI / 180 + RA);
  // reduce resolution to improve performance (step 2°)
  for (let lngDeg = -180; lngDeg <= 180; lngDeg += 2) {
    // use subtraction here so the terminator moves west→east correctly
    const lhr = lngDeg * Math.PI / 180 - lngSun;
    const lat = Math.atan(-Math.cos(lhr) / Math.tan(dec)) * 180 / Math.PI;
    pts.push([lat, lngDeg]);
  }
  const pole = dec > 0 ? -90 : 90;
  return [[pole, -180], ...pts, [pole, 180]];
}
let _termDate = null;
let terminator = null; // created after panes are set up

// Throttle updates to the terminator to avoid blocking the main thread
let _termPendingDate = null;
let _termRafId = null;
function scheduleTerminatorUpdate(date) {
  _termPendingDate = date;
  if (_termRafId) return;
  _termRafId = requestAnimationFrame(() => {
    if (_termPendingDate) {
      terminator.setTime(_termPendingDate);
    }
    _termPendingDate = null;
    _termRafId = null;
  });
}

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Create dedicated panes: labels above everything, shade above tiles
map.createPane('shadePane');
map.getPane('shadePane').style.zIndex = 250;
map.getPane('shadePane').style.pointerEvents = 'none';
map.getPane('shadePane').style.mixBlendMode = 'multiply';
map.createPane('labelsPane');
map.getPane('labelsPane').style.zIndex = 700;
map.getPane('labelsPane').style.pointerEvents = 'none';
// Terminator pane above tiles and hillshade, below labels
map.createPane('terminatorPane');
map.getPane('terminatorPane').style.zIndex = 680;
map.getPane('terminatorPane').style.pointerEvents = 'none';
map.getPane('terminatorPane').style.mixBlendMode = 'multiply';

// Inject an invisible SVG <defs> with a Gaussian blur filter for the terminator
function ensureTerminatorFilter() {
  if (document.getElementById('nk-blur-defs')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true'); svg.style.position = 'absolute';
  svg.style.left = '0'; svg.style.top = '0'; svg.id = 'nk-blur-defs';
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
  filter.setAttribute('id', 'nk-blur'); filter.setAttribute('x', '-50%'); filter.setAttribute('y', '-50%');
  filter.setAttribute('width', '200%'); filter.setAttribute('height', '200%');
  const fe = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
  fe.setAttribute('stdDeviation', '14'); fe.setAttribute('result', 'b');
  filter.appendChild(fe);
  defs.appendChild(filter);
  svg.appendChild(defs);
  document.body.appendChild(svg);
}


// Now that panes exist, create a neutral terminator polygon on its pane
// Do NOT compute with the current date at module load; it will be initialized
// properly once travel data is loaded (see `init`).
terminator = L.polygon([[0,0],[0,0.01],[0.01,0.01],[0.01,0]], {
  pane: 'terminatorPane',
  // visible baseline night opacity; detailed adjustments happen when selecting entries
  // use slightly lighter blue and a lower default opacity so the map remains visible
  fillColor: '#001026', fillOpacity: 0.7,
  stroke: true, color: 'rgba(40,110,200,0.6)', weight: 1,
  interactive: false,
}).addTo(map);
try { ensureTerminatorFilter(); const el = terminator.getElement && terminator.getElement(); if (el) el.classList.add('nk-terminator'); } catch (e) { /* ignore */ }
terminator.bringToFront();
terminator.setTime = function(date) {
  if (_termDate && Math.abs(date - _termDate) < 30000) return;
  _termDate = date;
  this.setLatLngs(_termCompute(date));
};

// Hillshade overlay to give altitude impression (subtle)
// Probe a sample tile first to avoid flooding the console with DNS errors.
const hillshadeUrl = 'https://tiles.wmflabs.org/hillshading/{z}/{x}/{y}.png';
const hillshade = L.tileLayer(hillshadeUrl, {
  pane: 'shadePane', opacity: 0.25,
  attribution: 'Hillshade \u00A9 OpenStreetMap contributors',
  errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
});

function addFallbackHillshade() {
  console.warn('Using fallback hillshade (Stamen terrain)');
  const fallback = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/terrain-background/{z}/{x}/{y}.jpg', {
    pane: 'shadePane', opacity: 0.14,
    attribution: 'Hillshade fallback \u00A9 Stamen Design'
  }).addTo(map);
  return fallback;
}

let _hillshadeFailCount = 0;
function onHillshadeTileError() {
  _hillshadeFailCount++;
  if (_hillshadeFailCount > 6) {
    try { map.removeLayer(hillshade); } catch (e) { /* ignore */ }
    hillshade.off('tileerror', onHillshadeTileError);
    addFallbackHillshade();
  }
}

// Probe a known tile (low zoom) and add the appropriate layer based on result.
const probeUrl = 'https://tiles.wmflabs.org/hillshading/4/9/3.png';
let _probeTimedOut = false;
const probeTimeout = setTimeout(() => { _probeTimedOut = true; console.warn('Hillshade probe timed out — using fallback'); addFallbackHillshade(); }, 2500);
const probeImg = new Image();
probeImg.crossOrigin = 'anonymous';
probeImg.onload = () => {
  if (_probeTimedOut) return;
  clearTimeout(probeTimeout);
  hillshade.addTo(map);
  hillshade.on('tileerror', onHillshadeTileError);
};
probeImg.onerror = () => {
  if (_probeTimedOut) return;
  clearTimeout(probeTimeout);
  console.warn('Hillshade probe failed — switching to fallback');
  addFallbackHillshade();
};
probeImg.src = probeUrl;

// ── DOM refs ─────────────────────────────────────────────────────────
const player       = document.getElementById('player');
const preloader    = document.getElementById('preloader');
const dateDay      = document.getElementById('date-day');
const dateMonth    = document.getElementById('date-month');
const dateTime     = document.getElementById('date-time');
const tlInput      = document.getElementById('timeline-input');
const tlThumbLabel = document.getElementById('timeline-thumb-label');
const tlCitiesRow  = document.getElementById('timeline-cities-row');
const lightbox     = document.getElementById('lightbox');
const lbImg        = document.getElementById('lightbox-img');

// ── Panel ─────────────────────────────────────────────────────────────
function openPanel()  { document.body.classList.add('panel-open'); }
function closePanel() { document.body.classList.remove('panel-open'); }

// ── Daylight theme ────────────────────────────────────────────────────
// Voyage en CEST (UTC+2) du début à la fin
function sunElevationDeg(lat, lon, day, month, hour, minute) {
  const utcMin = ((hour - 2 + 24) % 24) * 60 + minute;
  const days = [0,31,29,31,30,31,30,31,31,30,31,30,31]; // 2024 bissextile
  let doy = day;
  for (let m = 1; m < month; m++) doy += days[m];
  const decl = -23.45 * Math.cos(2 * Math.PI * (doy + 10) / 365) * Math.PI / 180;
  const solarNoon = 720 - 4 * lon; // minutes UTC
  const H = (utcMin - solarNoon) * (Math.PI / 720);
  const φ = lat * Math.PI / 180;
  return Math.asin(Math.sin(φ)*Math.sin(decl) + Math.cos(φ)*Math.cos(decl)*Math.cos(H)) * 180/Math.PI;
}

// Apply only to the terminator overlay: compute opacity from sun elevation
function applyDaylight(elev) {
  // elev in degrees. Use a tolerant smooth ramp: do not darken until a small
  // negative elevation (sun just below horizon). This avoids marking places
  // like Trondheim as fully night during civil/nautical twilight or midnight sun.
  // Parameters: no-darkening threshold and full-night threshold (degrees)
  const NO_DARK_thresh = -3;   // elevation >= -3° -> treated as day
  const FULL_NIGHT_thresh = -12; // elevation <= -12° -> full night

  // computeTermOpacity encapsulates the previous ramp -> opacity mapping
  const computeTermOpacity = (e) => {
    let tt;
    if (e >= NO_DARK_thresh) tt = 0;
    else if (e <= FULL_NIGHT_thresh) tt = 1;
    else {
      tt = (NO_DARK_thresh - e) / (NO_DARK_thresh - FULL_NIGHT_thresh);
    }
    tt = tt * tt * (3 - 2 * tt);
    const baseOp = 0.20;
    const extra = 0.60;
    return Math.max(0, Math.min(0.8, baseOp + tt * extra));
  };

  const termOp = (fixedTermOp !== null) ? fixedTermOp : computeTermOpacity(elev);

  if (terminator) {
    terminator.setStyle({ fillOpacity: termOp, fillColor: '#000412' });
    try { terminator.bringToFront(); } catch (e) { /* ignore */ }
  }
}

// Palettes [r, g, b, a]
const P_NIGHT = {
  bg:       [8,12,20,1],      chrome:   [4,6,14,0.92],    panel:    [6,9,18,0.97],
  border:   [255,255,255,0.07], borderF: [255,255,255,0.05],
  text1:    [240,240,240,1],  text2:    [255,255,255,0.70],
  text3:    [255,255,255,0.45], text4:  [255,255,255,0.35],
  text5:    [255,255,255,0.30], accentT:[240,192,96,1],
  tlTrack:  [255,255,255,0.12], tlEdge: [255,255,255,0.30],
  cityC:    [255,255,255,0.85], tickC:  [255,255,255,0.60],
  zoomBg:   [8,12,20,0.85],   zoomC:   [170,170,170,1],
  route:    [240,192,96,1],   routeOp: 0.65,
};
const P_DAY = {
  // Blue-forward daytime palette (pronounced blue tint)
  bg:       [230,245,255,1],  chrome:   [220,240,250,0.93], panel:  [255,255,255,0.98],
  border:   [6,30,40,0.08],   borderF:  [6,30,40,0.05],
  text1:    [8,18,28,1],      text2:    [8,18,28,0.75],
  text3:    [8,18,28,0.50],   text4:    [8,18,28,0.38],
  text5:    [8,18,28,0.30],   accentT:  [40,130,200,1],
  tlTrack:  [8,18,28,0.12],   tlEdge:   [8,18,28,0.30],
  cityC:    [8,18,28,0.88],   tickC:    [8,18,28,0.55],
  zoomBg:   [255,255,255,0.92], zoomC:  [30,90,140,1],
  route:    [10,110,200,1],   routeOp: 0.88,
};

// Apply fixed daytime palette to CSS root (no automatic UI shift with sun)
(function applyFixedDayPalette(){
  const root = document.documentElement;
  const toRgba = (a) => `rgba(${a[0]},${a[1]},${a[2]},${a[3]})`;

  root.style.setProperty('--bg',      toRgba(P_DAY.bg));
  root.style.setProperty('--chrome',  toRgba(P_DAY.chrome));
  root.style.setProperty('--panel',   toRgba(P_DAY.panel));
  root.style.setProperty('--border',  toRgba(P_DAY.border));
  root.style.setProperty('--borderf', toRgba(P_DAY.borderF || P_DAY.border));
  root.style.setProperty('--text1',   toRgba(P_DAY.text1));
  root.style.setProperty('--text2',   toRgba(P_DAY.text2));
  root.style.setProperty('--text3',   toRgba(P_DAY.text3));
  root.style.setProperty('--text4',   toRgba(P_DAY.text4));
  root.style.setProperty('--text5',   toRgba(P_DAY.text5));
  root.style.setProperty('--accT',    toRgba(P_DAY.accentT || P_DAY.accentT));
  root.style.setProperty('--tltrack', toRgba(P_DAY.tlTrack));
  root.style.setProperty('--tledge',  toRgba(P_DAY.tlEdge));
  root.style.setProperty('--cityc',   toRgba(P_DAY.cityC));
  root.style.setProperty('--tickc',   toRgba(P_DAY.tickC));
  root.style.setProperty('--zoombg',  toRgba(P_DAY.zoomBg));
  root.style.setProperty('--zoomc',   toRgba(P_DAY.zoomC));

  // Force light tiles for daytime appearance
  tileLayer.setUrl(TILE_LIGHT);

  // Keep a consistent, fairly dark night overlay (terminator)
  terminator.setStyle({ fillOpacity: 0.85, fillColor: '#001026' });
})();

// ── Ring marker ──────────────────────────────────────────────────────
function showRing(latlng) {
  if (state.ringMarker) map.removeLayer(state.ringMarker);
  state.ringMarker = L.marker(latlng, {
    icon: L.divIcon({ className: 'nk-active-ring', iconSize: [20,20], iconAnchor: [10,10] }),
    interactive: false, zIndexOffset: 1000,
  }).addTo(map);
}

// ── Lightbox ─────────────────────────────────────────────────────────
function openLightbox(photos, startIdx) {
  state.lbPhotos = photos;
  state.lbIdx    = startIdx;
  lbShowCurrent();
  lightbox.hidden = false;
}
function closeLightbox() { lightbox.hidden = true; }
function lbShowCurrent() {
  const item = state.lbPhotos[state.lbIdx];
  if (!item) return;
  const prog = document.getElementById('lb-progress');
  prog.classList.add('active');
  const srcs = [item.webp, item.src, item.thumb].filter(Boolean);
  let si = 0;
  const tryNext = () => {
    if (si >= srcs.length) { prog.classList.remove('active'); return; }
    const src = srcs[si++];
    lbImg.onload  = () => prog.classList.remove('active');
    lbImg.onerror = tryNext;
    lbImg.src = src;
  };
  tryNext();
  document.getElementById('lightbox-prev').style.visibility = state.lbIdx > 0 ? '' : 'hidden';
  document.getElementById('lightbox-next').style.visibility = state.lbIdx < state.lbPhotos.length - 1 ? '' : 'hidden';
  // lb-counter masqué
  // Bouton téléchargement → Sources/ (même sous-arborescence que Photos/)
  const dlBtn = document.getElementById('lb-download');
  const srcUrl = (item.src || item.thumb).replace('/Photos/', '/Sources/');
  dlBtn.onclick = () => {
    const a = document.createElement('a');
    a.href = srcUrl;
    a.download = srcUrl.split('/').pop();
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
  };
}

document.getElementById('lightbox-backdrop').addEventListener('click', closeLightbox);
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', () => { if (state.lbIdx > 0) { state.lbIdx--; lbShowCurrent(); } });
document.getElementById('lightbox-next').addEventListener('click', () => { if (state.lbIdx < state.lbPhotos.length - 1) { state.lbIdx++; lbShowCurrent(); } });


// ── Timeline ──────────────────────────────────────────────────────────
function updateTimelineThumb(idx) {
  // Position the thumb according to real chronological time, not index.
  let pct = 0;
  if (state.entryTimes && state.entryTimes.length > 1) {
    const t = state.entryTimes[idx];
    const span = state.entryTimeMax - state.entryTimeMin;
    if (span > 0) pct = (t - state.entryTimeMin) / span;
    else pct = state.entries.length > 1 ? idx / (state.entries.length - 1) : 0;
  } else {
    const total  = state.entries.length - 1;
    pct = total > 0 ? idx / total : 0;
  }
  const wrapW  = document.getElementById('timeline-slider-wrap').offsetWidth;
  const offset = pct * (wrapW - 14) + 7;
  tlThumbLabel.style.left = `${offset}px`;
  const e = state.entries[idx];
  if (e) tlThumbLabel.textContent = `${e.day} ${MONTHS_FR[e.month]} · ${e.hour}h${String(e.minute).padStart(2,'0')}`;
}

function updateTimelineThumbForTime(t) {
  // place thumb by timestamp
  if (!state.entryTimes || state.entryTimes.length < 2) {
    return updateTimelineThumb(0);
  }
  const span = state.entryTimeMax - state.entryTimeMin;
  const pct = span > 0 ? (t - state.entryTimeMin) / span : 0;
  const wrapW  = document.getElementById('timeline-slider-wrap').offsetWidth;
  const offset = Math.max(7, Math.min(wrapW - 7, pct * (wrapW - 14) + 7));
  tlThumbLabel.style.left = `${offset}px`;
  const cest = new Date(t + 2 * 3600000);
  const day = cest.getUTCDate();
  const month = MONTHS_FR[cest.getUTCMonth() + 1];
  const hour = cest.getUTCHours();
  const minute = String(cest.getUTCMinutes()).padStart(2, '0');
  tlThumbLabel.textContent = `${day} ${month} · ${hour}h${minute}`;
}

function buildTimelineCities(cities, totalEntries) {
  if (!tlCitiesRow) {
    console.warn('buildTimelineCities: `timeline-cities-row` not found in DOM');
    return;
  }
  tlCitiesRow.innerHTML = '';
  // find Copenhagen (if present) to avoid duplicate ticks for nearby Malmö
  const copenhagen = cities.find(v => (v.name || '').toLowerCase().includes('copenh'));
  const toMeters = (lat1, lon1, lat2, lon2) => {
    const toRad = a => a * Math.PI / 180;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };
  // Track escale city names already rendered as ticks (normalized)
  let escaleCities = [];
  let escaleTicked = new Set();
  if (window.escales && Array.isArray(window.escales)) {
    escaleCities = window.escales.map(e => (e.city || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, ''));
  }
  cities.filter(c => c.entryIdx != null).forEach(c => {
    // Ne pas afficher le tick classique si la ville est une escale (pour éviter doublon)
    const cname = (c.name || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    if (escaleCities.includes(cname)) return;
    // Exclure explicitement Honningsvåg si Nordkapp est une escale
    if (cname.includes('honningsvag') && escaleCities.some(ec => ec.includes('nordkapp'))) return;
    // Supprime explicitement Lødingen si déjà en escale (sécurité)
    if (cname.includes('lodingen') && escaleCities.some(ec => ec.includes('lodingen'))) return;
    if (c.name === 'Malmö' && copenhagen) {
      const d = toMeters(c.lat, c.lon, copenhagen.lat, copenhagen.lon);
      if (d < 30000) return;
    }
    let pct = 0;
    if (state.entryTimes && state.entryTimes.length > 1) {
      const t = state.entryTimes[c.entryIdx];
      const span = state.entryTimeMax - state.entryTimeMin;
      pct = span > 0 ? ((t - state.entryTimeMin) / span) * 100 : (c.entryIdx / (totalEntries - 1)) * 100;
    } else {
      pct = (c.entryIdx / (totalEntries - 1)) * 100;
    }
    const entry = state.entries && state.entries[c.entryIdx];
    if (entry && entry.url) {
      const m = String(entry.url).match(/(\d{2})(\d{2})_(\d{2})(\d{2})/);
      const matchesTime = m && Number(m[1]) === Number(entry.day) && Number(m[2]) === Number(entry.month) && Number(m[3]) === Number(entry.hour) && Number(m[4]) === Number(entry.minute);
      if (!matchesTime) return;
    }
    const div = document.createElement('div');
    div.className = 'tl-city-tick';
    div.style.left = `${pct}%`;
    div.innerHTML = `<div class=\"tick-line\"></div><div class=\"tick-name\">${c.name}</div>`;
    tlCitiesRow.appendChild(div);
  });

  // Ajouter en plus les ticks centrés pour chaque escale (classe spéciale), but only once per city
  if (window.escales && Array.isArray(window.escales) && state.entryTimes && state.entryTimes.length > 1) {
    const span = state.entryTimeMax - state.entryTimeMin;
    window.escales.forEach(e => {
      const escaleNameNorm = (e.city || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      if (escaleTicked.has(escaleNameNorm)) return; // already rendered
      escaleTicked.add(escaleNameNorm);
      function parseISOtoUTC(str) {
        const d = new Date(str + 'Z');
        d.setUTCHours(d.getUTCHours() - 2);
        return d.getTime();
      }
      const t0 = parseISOtoUTC(e.start);
      const t1 = parseISOtoUTC(e.end);
      let pct0 = span > 0 ? ((t0 - state.entryTimeMin) / span) : 0;
      let pct1 = span > 0 ? ((t1 - state.entryTimeMin) / span) : 0;
      pct0 = Math.max(0, Math.min(1, pct0));
      pct1 = Math.max(0, Math.min(1, pct1));
      const pct = ((pct0 + pct1) / 2) * 100;
      const div = document.createElement('div');
      div.className = 'tl-city-tick tl-escale-city-tick';
      div.style.left = `${pct}%`;
      // Ajoute la classe glow si Nordkapp
      const isNordkapp = escaleNameNorm.includes('nordkapp');
      div.innerHTML = `<div class=\"tick-line\"></div><div class=\"tick-name${isNordkapp ? ' nordkapp-glow' : ''}\">${e.city}</div>`;
      tlCitiesRow.appendChild(div);
    });
  }
}

// ── Carousel ──────────────────────────────────────────────────────────
const THUMB_STEP = 124; // 120px + 4px gap

function nearestPhotoIdx(entryIdx) {
  const photos = state.photos;
  let lo = 0, hi = photos.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (photos[mid].entryIdx < entryIdx) lo = mid + 1;
    else hi = mid;
  }
  const a = lo > 0 ? lo - 1 : 0;
  const b = lo < photos.length ? lo : photos.length - 1;
  return Math.abs(photos[a].entryIdx - entryIdx) <= Math.abs(photos[b].entryIdx - entryIdx) ? a : b;
}

// Convert an arbitrary time (ms since epoch) to the nearest entry index using binary search
function timeToIndex(t) {
  const times = state.entryTimes;
  if (!times || times.length === 0) return 0;
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] === t) return mid;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid - 1;
  }
  // lo is the first index with times[lo] > t, hi = lo-1
  const a = Math.max(0, hi);
  const b = Math.min(times.length - 1, lo);
  return (Math.abs(times[a] - t) <= Math.abs(times[b] - t)) ? a : b;
}

// Interpolate geographic position (and basic fields) for an arbitrary timestamp
function interpolatePosition(t) {
  const times = state.entryTimes;
  const entries = state.entries;
  if (!times || times.length === 0) return null;
  if (t <= times[0]) return { lat: entries[0].lat, lon: entries[0].lon, idx: 0 };
  const n = times.length - 1;
  if (t >= times[n]) return { lat: entries[n].lat, lon: entries[n].lon, idx: n };
  // find hi = first index with times[hi] > t
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const a = Math.max(0, lo - 1);
  const b = lo;
  const ta = times[a], tb = times[b];
  const frac = tb === ta ? 0 : (t - ta) / (tb - ta);
  const lat = entries[a].lat + frac * (entries[b].lat - entries[a].lat);
  const lon = entries[a].lon + frac * (entries[b].lon - entries[a].lon);
  return { lat, lon, a, b, frac };
}

function previewAtTime(t) {
  const ip = interpolatePosition(t);
  if (!ip) return;
  // update ring marker position without opening panel
  try { showRing([ip.lat, ip.lon]); } catch (e) { /* ignore */ }
  // update terminator to that exact time
  scheduleTerminatorUpdate(new Date(t));
  // compute sun elevation at this time and place
  let elev = 0;
  if (window.SunCalc) {
    const pos = SunCalc.getPosition(new Date(t), ip.lat, ip.lon);
    elev = pos.altitude * 180 / Math.PI;
  } else {
    // fall back to approximate hour/min interpolation
    const cest = new Date(t + 2 * 3600000);
    elev = sunElevationDeg(ip.lat, ip.lon, cest.getUTCDate(), cest.getUTCMonth() + 1, cest.getUTCHours(), cest.getUTCMinutes());
  }
  applyDaylight(elev);
  // update date display on thumb
  updateTimelineThumbForTime(t);
}

function scrollCarouselTo(pi) {
  if (pi === state.activePhotoIdx) return;
  const carousel = document.getElementById('photo-carousel');
  carousel.scrollTo({ left: pi * THUMB_STEP + THUMB_STEP / 2, behavior: 'smooth' });
  const prev = state.thumbEls[state.activePhotoIdx];
  if (prev) { prev.classList.remove('active'); prev.fetchPriority = 'low'; }
  const next = state.thumbEls[pi];
  if (next) {
    next.classList.add('active');
    next.fetchPriority = 'high';
    // Charger immédiatement si pas encore chargé
    if (next.dataset.src && !next.src) { 
      next.src = next.dataset.src; 
      delete next.dataset.src; 
    }
  }
  state.activePhotoIdx = pi;
}

// ── Select entry ─────────────────────────────────────────────────────
function selectEntry(idx) {
  const entries = state.entries;
  if (idx < 0 || idx >= entries.length) return;
  const e = entries[idx];
  state.activeIdx = idx;

  showRing([e.lat, e.lon]);
  // Date UTC du moment (voyage en CEST = UTC+2)
  scheduleTerminatorUpdate(new Date(Date.UTC(2024, e.month - 1, e.day, e.hour - 2, e.minute)));
  applyDaylight(sunElevationDeg(e.lat, e.lon, e.day, e.month, e.hour, e.minute));
  scrollCarouselTo(nearestPhotoIdx(idx));
  if (!map.getBounds().contains([e.lat, e.lon])) {
    map.panTo([e.lat, e.lon], { animate: true, duration: 0.4 });
  }

  // If this entry has a video URL, open the video panel as before.
  // Otherwise, avoid opening an empty video panel; if photos exist for
  // this entry, open the lightbox to show them. If neither video nor
  // photos are available, just show the ring and pan without opening UI.
  if (e.url) {
    openPanel();
    updatePanel(e, idx);
  } else {
    // Do not open photos automatically when there's no video for this entry.
    // Close any open panel and ensure the player is stopped/cleared.
    try {
      closePanel();
      player.pause();
      player.removeAttribute('src');
      player.load();
    } catch (err) { /* ignore */ }
  }

  // Keep the slider value time-based (ms UTC) so spacing reflects real time
  if (state.entryTimes && state.entryTimes[idx] != null) tlInput.value = state.entryTimes[idx];
  else tlInput.value = idx;
  updateTimelineThumb(idx);
}

// ── Panel content ─────────────────────────────────────────────────────
function updatePanel(e, idx) {
  const entries = state.entries;

  dateDay.textContent   = e.day;
  dateMonth.textContent = MONTHS_FR[e.month];
  dateTime.textContent  = `${e.hour}h${String(e.minute).padStart(2, '0')}`;

  if (player.src !== e.url) {
    player.src = e.url;
    player.load();
  }
  // Précharger la vidéo suivante
  const nextE = state.entries[idx + 1];
  if (nextE && preloader.src !== nextE.url) {
    preloader.src = nextE.url;
    preloader.load();
  }
  player.oncanplay = () => {
    player.playbackRate = currentRate();
    player.play().catch(() => { player.muted = true; player.play().catch(() => {}); });
  };
  player.onerror = (err) => {
    console.error('Erreur de chargement vidéo:', e.url, err);
  };
  player.onended = () => {
    const next = state.activeIdx + 1;
    if (next < entries.length) selectEntry(next);
  };

}

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  let entries, photos, cities, visited, escales, gapRoutes;
  try {
    [entries, photos, cities, visited, escales, gapRoutes] = await Promise.all([
      fetch('travel.json?v=1774802661').then(r => r.json()),
      fetch('photos.json?v=1774804575').then(r => r.json()),
      fetch('cities.json?v=1774802661').then(r => r.json()),
      fetch('visited.json').then(r => r.json()),
      fetch('escales.json').then(r => r.json()),
      fetch('gap_routes.json').then(r => r.json()).catch(() => []),
    ]);
    window.escales = escales; // <--- Ajouté pour rendre escales global et accessible partout
  } catch (err) {
    console.error('Impossible de charger les données', err);
    return;
  }
  if (!entries.length) return;
    // ── Timeline Base Line (always visible) ──
    function renderTimelineBaseLine() {
      const wrap = document.getElementById('timeline-slider-wrap');
      if (!wrap) return;
      let base = wrap.querySelector('.tl-base-line');
      if (!base) {
        base = document.createElement('div');
        base.className = 'tl-base-line';
        wrap.insertBefore(base, wrap.firstChild);
      }
      // full width, centered vertically
      base.style.position = 'absolute';
      base.style.left = '0';
      base.style.width = '100%';
      base.style.top = '50%';
      base.style.height = '2px';
      base.style.transform = 'translateY(-50%)';
      base.style.background = 'rgba(240,192,96,0.75)'; // gold, same as city names
      base.style.zIndex = '0';
      base.style.pointerEvents = 'none';
    }

    // ── Timeline Escale Highlights ──
    // Render thick highlight bars for escale periods
    function renderTimelineEscales(escales, entryTimes, entryTimeMin, entryTimeMax) {
      const wrap = document.getElementById('timeline-slider-wrap');
      if (!wrap || !escales || !entryTimes || entryTimes.length < 2) return;
      // Remove previous highlights if any
      Array.from(wrap.querySelectorAll('.tl-escale-bar')).forEach(el => el.remove());
      const span = entryTimeMax - entryTimeMin;
      escales.forEach(e => {
        // Corrige le placement : les timestamps dans escales.json sont en CEST (UTC+2), il faut les convertir en UTC
        function parseCESTtoUTC(str) {
          // str: "2024-06-13T18:00:00" (CEST)
          const d = new Date(str + 'Z'); // parse as UTC
          // retire 2h pour obtenir UTC
          d.setUTCHours(d.getUTCHours() - 2);
          return d.getTime();
        }
        const t0 = parseCESTtoUTC(e.start);
        const t1 = parseCESTtoUTC(e.end);
        if (isNaN(t0) || isNaN(t1)) return;
        let pct0 = (t0 - entryTimeMin) / span;
        let pct1 = (t1 - entryTimeMin) / span;
        pct0 = Math.max(0, Math.min(1, pct0));
        pct1 = Math.max(0, Math.min(1, pct1));
        if (pct1 <= pct0) return;
        // Create a background cover to hide the base line under the escale
        const cover = document.createElement('div');
        cover.className = 'tl-escale-cover';
        cover.style.position = 'absolute';
        cover.style.left = (pct0 * 100) + '%';
        cover.style.width = ((pct1 - pct0) * 100) + '%';
        cover.style.top = '50%';
        cover.style.height = '6px'; // same as escale bar
        cover.style.marginTop = '-2px'; // align with escale bar
        cover.style.transform = 'translateY(-16%)'; // align with escale bar
        cover.style.background = 'rgba(240,192,96,1)';
        cover.style.zIndex = '1';
        cover.style.pointerEvents = 'none';
        wrap.appendChild(cover);

        // Foreground escale bar (thick, gold)
        const bar = document.createElement('div');
        bar.className = 'tl-escale-bar';
        bar.title = `${e.city} — ${e.duration_h}h`;
        bar.style.position = 'absolute';
        bar.style.left = (pct0 * 100) + '%';
        bar.style.width = ((pct1 - pct0) * 100) + '%';
        bar.style.top = '50%';
        bar.style.height = '6px';
        bar.style.marginTop = '-2px';
        bar.style.transform = 'translateY(-16%)';
        bar.style.background = 'rgba(240,192,96,1)';
        bar.style.borderRadius = '3px';
        bar.style.zIndex = '2';
        bar.style.boxShadow = '0 0 2px 0px rgba(240,192,96,0.10)';
        bar.style.cursor = 'pointer';
        // Clique : va à l'entrée la plus proche du début de l'escale
        bar.onclick = () => {
          if (!entryTimes || entryTimes.length === 0) return;
          // Cherche l'index de l'entrée média la plus proche APRÈS la fin de l'escale
          let idx = 0;
          let minDt = Infinity;
          const tRef = t1; // t1 = fin de l'escale
          if (typeof mediaEntries !== 'undefined' && mediaEntries.size > 0) {
            for (const i of mediaEntries) {
              if (i < 0 || i >= entryTimes.length) continue;
              const dt = entryTimes[i] - tRef;
              if (dt < 0) continue; // Ignore points in the past
              if (dt < minDt) { minDt = dt; idx = i; }
            }
            // Fallback : si aucun point futur, prendre le plus proche dans le passé
            if (minDt === Infinity) {
              let bestPast = null;
              let bestPastDt = Infinity;
              for (const i of mediaEntries) {
                if (i < 0 || i >= entryTimes.length) continue;
                const dt = tRef - entryTimes[i];
                if (dt < 0) continue;
                if (dt < bestPastDt) { bestPastDt = dt; bestPast = i; }
              }
              if (bestPast !== null) idx = bestPast;
            }
          } else {
            for (let i = 0; i < entryTimes.length; i++) {
              const dt = entryTimes[i] - tRef;
              if (dt < 0) continue;
              if (dt < minDt) { minDt = dt; idx = i; }
            }
            if (minDt === Infinity) {
              let bestPast = null;
              let bestPastDt = Infinity;
              for (let i = 0; i < entryTimes.length; i++) {
                const dt = tRef - entryTimes[i];
                if (dt < 0) continue;
                if (dt < bestPastDt) { bestPastDt = dt; bestPast = i; }
              }
              if (bestPast !== null) idx = bestPast;
            }
          }
          const tlInput = document.getElementById('timeline-input');
          const thumbLabel = document.getElementById('timeline-thumb-label');
          if (tlInput && typeof animateToTime === 'function') {
            // Affiche le label date pendant l'animation (avec !important)
            if (thumbLabel) {
              thumbLabel.style.setProperty('opacity', '1', 'important');
            }
            const from = Number(tlInput.value);
            const to = entryTimes[idx];
            animateToTime(from, to, 2000,
              (val) => {
                const v = Math.round(val);
                tlInput.value = v;
                previewAtTime(v);
                updateTimelineThumbForTime(v);
              },
              () => {
                tlInput.value = to;
                previewAtTime(to);
                updateTimelineThumbForTime(to);
                selectEntry(idx);
                // Cache le label si le slider n'est pas hover/focus
                setTimeout(() => {
                  if (thumbLabel && !tlInput.matches(':hover') && document.activeElement !== tlInput) {
                    thumbLabel.style.removeProperty('opacity');
                  }
                }, 400);
              }
            );
          } else if (typeof selectEntry === 'function') {
            selectEntry(idx);
          }
        };
        wrap.appendChild(bar);
      });
    }
    // Render base line and escale highlights after timeline is set up
    setTimeout(() => {
      renderTimelineBaseLine();
      renderTimelineEscales(escales, state.entryTimes, state.entryTimeMin, state.entryTimeMax);
    }, 0);
  state.entries = entries;
  state.photos  = photos;
  state.cities  = cities;
  // Remove video URLs from entries when the filename's timestamp does not
  // exactly match the entry timestamp. This prevents linking interpolated
  // points to a video that was recorded at a different timecode.
  const filenameEncodesEntry = (url, e) => {
    if (!url) return false;
    const m = String(url).match(/(\d{2})(\d{2})_(\d{2})(\d{2})/);
    if (!m) return false;
    const d = Number(m[1]), mo = Number(m[2]), h = Number(m[3]), mi = Number(m[4]);
    return d === Number(e.day) && mo === Number(e.month) && h === Number(e.hour) && mi === Number(e.minute);
  };
  entries.forEach(e => {
    if (e.url && !filenameEncodesEntry(e.url, e)) {
      // clear the url so the rest of the app treats this entry as having no video
      console.debug('Clearing mismatched video URL for entry', e.id || '(no id)', `${e.day}/${e.month} ${e.hour}:${e.minute}`, '->', e.url);
      e.url = null;
    }
  });
  // Precompute entry timestamps (UTC). Entries recorded in CEST (UTC+2),
  // convert by subtracting 2 hours so spacing on timeline matches real time.
  const year = entries[0]?.year || 2024;
  state.entryTimes = entries.map(e => Date.UTC(year, e.month - 1, e.day, (e.hour || 0) - 2, e.minute || 0));
  state.entryTimeMin = Math.min(...state.entryTimes);
  state.entryTimeMax = Math.max(...state.entryTimes);

  // Initialize terminator geometry once the map is ready using the first
  // available entry timestamp so no `current` date is loaded at module init.
  const firstT = state.entryTimeMin || Date.now();
  map.whenReady(() => scheduleTerminatorUpdate(new Date(firstT)));

  // If the travel data contains an entry on June 21, compute the terminator
  // opacity used for that entry and lock it for all timeline previews so the
  // shadow/terminator appearance remains constant across time.
  try {
    const june21 = entries.find(e => Number(e.day) === 21 && Number(e.month) === 6);
    if (june21) {
      // compute elevation for that entry (use same fallback as elsewhere)
      let elev = 0;
      if (window.SunCalc) {
        const pos = SunCalc.getPosition(new Date(Date.UTC(year, june21.month - 1, june21.day, (june21.hour || 0) - 2, june21.minute || 0)), june21.lat, june21.lon);
        elev = pos.altitude * 180 / Math.PI;
      } else {
        elev = sunElevationDeg(june21.lat, june21.lon, june21.day, june21.month, june21.hour || 0, june21.minute || 0);
      }
      // reuse computeTermOpacity logic by calling applyDaylight once and
      // reading the style — but because applyDaylight now respects fixedTermOp
      // we must compute value locally. Re-implement computeTermOpacity here.
      const NO_DARK_thresh = -3; const FULL_NIGHT_thresh = -12;
      let t;
      if (elev >= NO_DARK_thresh) t = 0;
      else if (elev <= FULL_NIGHT_thresh) t = 1;
      else t = (NO_DARK_thresh - elev) / (NO_DARK_thresh - FULL_NIGHT_thresh);
      t = t * t * (3 - 2 * t);
      const baseOp = 0.20; const extra = 0.60;
      fixedTermOp = Math.max(0, Math.min(0.8, baseOp + t * extra));
      // Override to a stronger (darker) fixed opacity as requested
      fixedTermOp = 0.7;
      // Force the terminator to use this opacity immediately
      if (terminator) terminator.setStyle({ fillOpacity: fixedTermOp, fillColor: '#000412' });
      console.info('Fixed terminator opacity overridden to:', fixedTermOp);
    }
  } catch (err) {
    console.warn('Could not compute fixed terminator opacity for June 21', err);
  }

  // Carousel
  const carousel = document.getElementById('photo-carousel');
  const thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        thumbObserver.unobserve(img);
      }
    });
  }, { root: carousel, rootMargin: '0px 600px 0px 600px' });

  const fragment = document.createDocumentFragment();
  photos.forEach((p, i) => {
    const img = document.createElement('img');
    // Charger immédiatement les 10 premières images, lazy-load le reste
    if (i < 10) {
      img.src = p.thumb || p.src;
    } else {
      img.dataset.src = p.thumb || p.src;
    }
    img.className = 'photo-thumb';
    img.draggable = false;
    img.addEventListener('click', () => openLightbox(photos, i));
    // Gestion des erreurs de chargement : fallback vers src si thumb échoue
    img.onerror = () => {
      if (img.src.includes('/Thumbs/') && p.src) {
        img.src = p.src;
      }
    };
      fragment.appendChild(img);
    });
    if (carousel) {
      carousel.appendChild(fragment);
      state.thumbEls = Array.from(carousel.querySelectorAll('.photo-thumb'));
      state.thumbEls.forEach(img => thumbObserver.observe(img));
    } else {
      console.warn('photo-carousel element not found; skipping thumbnail setup');
      state.thumbEls = [];
    }

  // Nearest entryIdx for each city (cities.json + visited.json)
  const assignEntryIdx = arr => arr.forEach(c => {
    let best = 0, bestD = Infinity;
    entries.forEach((e, i) => {
      const d = (e.lat - c.lat) ** 2 + (e.lon - c.lon) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    c.entryIdx = best;
  });
  assignEntryIdx(cities);
  assignEntryIdx(visited);

  // Route polylines — ligne épaisse sur segments vidéo, fine+tirets sur segments interpolés
  const findNearestEntry = (latlng) => {
    let best = 0, bestD = Infinity;
    entries.forEach((e, i) => {
      const d = (e.lat - latlng.lat) ** 2 + (e.lon - latlng.lng) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  const latlngs = entries.map(e => [e.lat, e.lon]);

  // Calcul de distance haversine entre deux entrées (en km)
  function gapKm(a, b) {
    const R = 6371;
    const lat1 = a.lat * Math.PI / 180, lon1 = a.lon * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180, lon2 = b.lon * Math.PI / 180;
    const dlat = lat2 - lat1, dlon = lon2 - lon1;
    const h = Math.sin(dlat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon/2)**2;
    return R * 2 * Math.asin(Math.sqrt(h));
  }
  const GAP_THRESHOLD_KM = 10; // coupe la trace si saut > 10 km

  let curSeg = [], curInterp = null;
  const flushSeg = (interp) => {
    if (curSeg.length < 2) return;
    const opts = interp
      ? { color: ACCENT, weight: 2, opacity: 1, smoothFactor: 1, dashArray: '6 6' }
      : { color: ACCENT, weight: 4, opacity: 0.65, smoothFactor: 1 };
    const line = L.polyline(curSeg, opts)
      .on('click', ev => selectEntry(findNearestEntry(ev.latlng)))
      .addTo(map);
    state.polylines.push({ line, interp });
  };
  entries.forEach((e, i) => {
    const interp = e.frame === 0;
    // Couper la trace sur les trous GPS (saut > seuil) — relier par l'itinéraire routier
    if (i > 0 && gapKm(entries[i - 1], e) > GAP_THRESHOLD_KM) {
      flushSeg(curInterp);
      // Chercher l'itinéraire pré-calculé correspondant à ce gap
      const prev = entries[i - 1];
      const gap = gapRoutes.find(g =>
        Math.abs(g.fromLatLon[0] - prev.lat) < 0.001 && Math.abs(g.fromLatLon[1] - prev.lon) < 0.001
      );
      const gapCoords = gap ? gap.coords : [[prev.lat, prev.lon], [e.lat, e.lon]];
      L.polyline(gapCoords, { color: ACCENT, weight: 2, opacity: 1, dashArray: '6 6', smoothFactor: 1 })
        .on('click', ev => selectEntry(findNearestEntry(ev.latlng)))
        .addTo(map);
      curSeg = [];
      curInterp = interp;
    } else if (curInterp === null) {
      curInterp = interp;
    } else if (interp !== curInterp) {
      const join = curSeg[curSeg.length - 1];
      flushSeg(curInterp);
      curSeg = [join];
      curInterp = interp;
    }
    curSeg.push([e.lat, e.lon]);
  });
  flushSeg(curInterp);

  // Tick labels every 10 minutes
  let lastTick = -1;
  // Build set of entries that actually have media (photos or video URL)
  const mediaEntries = new Set();
  photos.forEach(p => { if (p.entryIdx != null) mediaEntries.add(p.entryIdx); });
  entries.forEach((e, i) => { if (e.url) mediaEntries.add(i); });
  entries.forEach((e, i) => {
    const slot = e.hour * 6 + Math.floor(e.minute / 10);
    if (slot === lastTick) return;
    lastTick = slot;
    // Skip tick markers for approximated/interpolated entries unless they have
    // an exact video filename matching this entry's timestamp.
    if (e.frame === 0) {
      let hasExactVideo = false;
      if (e.url) {
        const m = String(e.url).match(/(\d{2})(\d{2})_(\d{2})(\d{2})/);
        if (m) {
          const d = Number(m[1]), mo = Number(m[2]), h = Number(m[3]), mi = Number(m[4]);
          if (d === Number(e.day) && mo === Number(e.month) && h === Number(e.hour) && mi === Number(e.minute)) hasExactVideo = true;
        }
      }
      if (!hasExactVideo) return;
    }
    const label = `${e.day} ${MONTHS_FR[e.month]} · ${e.hour}h${String(e.minute).padStart(2,'0')}`;
    // Show the small dot only when the video's filename encodes the exact timestamp
    // of this entry (format like "DDMM_HHMM" e.g. 1806_0938 for 18/06 09:38).
    let dotHtml = '';
    if (e.url) {
      const m = String(e.url).match(/(\d{2})(\d{2})_(\d{2})(\d{2})/);
      if (m) {
        const d = Number(m[1]);
        const mo = Number(m[2]);
        const h = Number(m[3]);
        const mi = Number(m[4]);
        if (d === Number(e.day) && mo === Number(e.month) && h === Number(e.hour) && mi === Number(e.minute)) {
          dotHtml = '<div class="time-tick-dot"></div>';
        }
      }
    }
    L.marker([e.lat, e.lon], {
      icon: L.divIcon({
        className: 'time-tick',
        html: `${dotHtml}<div class="time-tick-label">${label}</div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
      interactive: true,
    }).on('click', () => selectEntry(i)).addTo(map);
  });

  state.markers = [];


  map.fitBounds(L.latLngBounds(latlngs), { padding: [20,20] });

  // Visited city labels
  // Add city labels into the high-z-index `labelsPane` so they sit above routes
  // Skip labeling Malmö when it is effectively overlapping with Copenhagen
  const copenhagen = visited.find(v => (v.name || '').toLowerCase().includes('copenh'));
  function haversine_meters(lat1, lon1, lat2, lon2) {
    const toRad = a => a * Math.PI / 180;
    const R = 6371000; // meters
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  visited.forEach(c => {
    // If this is Malmö and Copenhagen exists nearby, skip the label to avoid overlap
    if (c.name === 'Malmö' && copenhagen) {
      const d = haversine_meters(c.lat, c.lon, copenhagen.lat, copenhagen.lon);
      if (d < 30000) return; // skip Malmö label when within 30 km of Copenhagen
    }
    L.marker([c.lat, c.lon], {
      pane: 'labelsPane',
      icon: L.divIcon({ className: 'city-label', html: c.name, iconAnchor: [0, 0] }),
      interactive: false,
    }).addTo(map);
  });

  // (VectorGrid demo removed — using raster tiles + hillshade overlay instead)
  // Timeline
  tlInput.max = entries.length - 1;
  // Make the timeline input represent real time (ms UTC) so gaps are shown
  if (state.entryTimes && state.entryTimes.length > 1) {
    tlInput.min = state.entryTimeMin;
    tlInput.max = state.entryTimeMax;
    // step of 1 minute to keep slider reasonably responsive
    tlInput.step = 60000;
    tlInput.value = state.entryTimeMin;
  } else {
    tlInput.min = 0;
    tlInput.max = entries.length - 1;
    tlInput.step = 1;
    tlInput.value = 0;
  }
  // Démarrage sur une entrée aléatoire avec vidéo
  const videoEntryIndices = entries.map((e, i) => e.url ? i : -1).filter(i => i >= 0);
  const randomIdx = videoEntryIndices.length > 0
    ? videoEntryIndices[Math.floor(Math.random() * videoEntryIndices.length)]
    : 0;
  if (state.entryTimes && state.entryTimes.length > 1) {
    tlInput.value = state.entryTimes[randomIdx];
  } else {
    tlInput.value = randomIdx;
  }
  updateTimelineThumb(randomIdx);
  setTimeout(() => selectEntry(randomIdx), 0);
  buildTimelineCities(visited, entries.length);

  // Add explicit date markers for Lødingen (26/06 22:00) and Malmö (08/07 09:41),
  // but skip if already rendered as an escale tick
  const escaleTickedForDateMarker = new Set();
  function addDateMarker(day, month, hour, minute, label) {
    if (!tlCitiesRow) return;
    const year = state.entries[0]?.year || 2024;
    // Only show the city name (strip any appended date after ' · ')
    const displayName = (label || '').split(' · ')[0];
    // Normalize for comparison
    const displayNameNorm = displayName.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    // If already rendered as an escale tick, skip
    if (escaleTickedForDateMarker.has(displayNameNorm)) return;
    // Also check if this city is in escales
    if (window.escales && Array.isArray(window.escales)) {
      const escaleCities = window.escales.map(e => (e.city || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, ''));
      if (escaleCities.includes(displayNameNorm)) {
        escaleTickedForDateMarker.add(displayNameNorm);
        return;
      }
    }
    escaleTickedForDateMarker.add(displayNameNorm);
    const t = Date.UTC(year, month - 1, day, hour - 2, minute);
    const idx = timeToIndex(t);
    // compute pct position across timeline using entryTimes
    let pct = 0;
    if (state.entryTimes && state.entryTimes.length > 1) {
      const span = state.entryTimeMax - state.entryTimeMin;
      const tt = state.entryTimes[idx];
      pct = span > 0 ? ((tt - state.entryTimeMin) / span) * 100 : (idx / (state.entries.length - 1)) * 100;
    } else {
      pct = (idx / (state.entries.length - 1)) * 100;
    }
    const div = document.createElement('div');
    div.className = 'tl-city-tick';
    div.style.left = `${pct}%`;
    div.innerHTML = `<div class=\"tick-line\"></div><div class=\"tick-name\">${displayName}</div>`;
    tlCitiesRow.appendChild(div);
  }
  // Lødingen: 26 June 22:00 (CEST)
  addDateMarker(26, 6, 22, 0, 'Lødingen · 26/06 22:00');
  // Malmö: 08 July 09:41 (CEST)
  addDateMarker(8, 7, 9, 41, 'Malmö · 08/07 09:41');

  // Auto-slide animation id (for requestAnimationFrame)
  let autoSlideRAF = null;
  function cancelAutoSlide() {
    if (autoSlideRAF) {
      cancelAnimationFrame(autoSlideRAF);
      autoSlideRAF = null;
    }
  }
  // Animate numeric value from `from` to `to` over `duration` ms, calling onUpdate(value)
  // on each frame and onEnd() when finished.
  function animateToTime(from, to, duration, onUpdate, onEnd) {
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      // ease-in-out (cosine)
      const eased = (1 - Math.cos(Math.PI * t)) / 2;
      const val = from + (to - from) * eased;
      onUpdate(val);
      if (t < 1) {
        autoSlideRAF = requestAnimationFrame(step);
      } else {
        autoSlideRAF = null;
        if (onEnd) onEnd();
      }
    }
    cancelAutoSlide();
    autoSlideRAF = requestAnimationFrame(step);
  }

  tlInput.addEventListener('input', () => {
    // User is actively dragging — cancel any pending auto-slide
    cancelAutoSlide();
    if (state.entryTimes && state.entryTimes.length > 1) {
      const t = Number(tlInput.value);
      // continuous preview while dragging: interpolate position and update terminator
      previewAtTime(t);
      updateTimelineThumbForTime(t);
    } else {
      const idx = Number(tlInput.value);
      updateTimelineThumb(idx);
      selectEntry(idx);
    }
    // Re-render escale highlights in case of resize
    renderTimelineEscales(escales, state.entryTimes, state.entryTimeMin, state.entryTimeMax);
    // Re-render escale highlights on resize
    window.addEventListener('resize', () => {
      renderTimelineEscales(escales, state.entryTimes, state.entryTimeMin, state.entryTimeMax);
    });
  });
  // On change (release), if the released time isn't exactly an event timestamp,
  // animate the slider toward the nearest event over 2s, updating preview continuously.
  tlInput.addEventListener('change', () => {
    if (state.entryTimes && state.entryTimes.length > 1) {
      const t = Number(tlInput.value);
      const tIdx = timeToIndex(t);
      // Prefer selecting an entry that actually has media (video/photo).
      // Use time-distance (ms) to find the closest media-bearing entry to the
      // released timestamp `t` rather than relying on index distance which can
      // be misleading when there are irregular time gaps.
      let idx = tIdx;
      if (typeof mediaEntries !== 'undefined' && mediaEntries.size > 0) {
        let best = null;
        let bestDt = Infinity;
        for (const i of mediaEntries) {
          if (i < 0 || i >= state.entryTimes.length) continue;
          const dt = state.entryTimes[i] - t;
          if (dt < 0) continue; // Ignore points in the past
          if (dt < bestDt) { bestDt = dt; best = i; }
        }
        // Si aucun point futur trouvé, fallback sur le plus proche dans le passé
        if (best === null) {
          let bestPast = null;
          let bestPastDt = Infinity;
          for (const i of mediaEntries) {
            if (i < 0 || i >= state.entryTimes.length) continue;
            const dt = t - state.entryTimes[i];
            if (dt < 0) continue;
            if (dt < bestPastDt) { bestPastDt = dt; bestPast = i; }
          }
          if (bestPast !== null) best = bestPast;
        }
        if (best !== null) idx = best;
      }
      const target = state.entryTimes[idx];
      if (t === target) {
        selectEntry(idx);
        return;
      }
      // 2000 ms slide animation toward the chosen target
      animateToTime(t, target, 2000, (val) => {
        const v = Math.round(val);
        tlInput.value = v;
        previewAtTime(v);
        updateTimelineThumbForTime(v);
      }, () => selectEntry(idx));
    }
  });

  // Panel controls
  document.getElementById('panel-close').addEventListener('click', () => { closePanel(); player.pause(); });

  // Carousel arrows — défilement continu 1 photo/300ms au maintien du bouton
  const carouselEl = document.getElementById('photo-carousel');
  function selectEntryFromCarouselCenter() {
    const scrollLeft = carouselEl.scrollLeft;
    const centerX = scrollLeft + carouselEl.clientWidth / 2;
    const photoIdx = Math.max(0, Math.min(state.photos.length - 1, Math.round((centerX - THUMB_STEP / 2) / THUMB_STEP)));
    const p = state.photos[photoIdx];
    if (p && p.entryIdx != null) selectEntry(p.entryIdx);
  }

  function attachCarouselArrow(btnId, dir) {
    const btn = document.getElementById(btnId);
    let intervalId = null;
    function step() {
      carouselEl.scrollBy({ left: dir * THUMB_STEP, behavior: 'smooth' });
      selectEntryFromCarouselCenter();
    }
    function start() {
      step();
      intervalId = setInterval(step, 300);
    }
    function stop() {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    }
    btn.addEventListener('mousedown', start);
    btn.addEventListener('touchstart', start, { passive: true });
    btn.addEventListener('mouseup', stop);
    btn.addEventListener('mouseleave', stop);
    btn.addEventListener('touchend', stop);
  }

  attachCarouselArrow('carousel-prev', -1);
  attachCarouselArrow('carousel-next',  1);

  // Mode immersif
  const stage     = document.getElementById('video-stage');
  const videoWrap = document.getElementById('video-wrap');
  const toolbar   = document.getElementById('video-toolbar');
  const rateRates = [0.5, 1, 1.5, 2, 3, 4];

  const routeBounds = L.latLngBounds(entries.map(e => [e.lat, e.lon])).pad(0.15);

  function enterImmersive() {
    const mapEl = document.getElementById('map');
    if (stage) {
      stage.appendChild(player);
      stage.appendChild(mapEl);
    }
    document.body.classList.add('immersive');
    map.setMaxBounds(routeBounds);
    setTimeout(() => {
      map.invalidateSize();
      if (state.activeIdx !== null) {
        const e = state.entries[state.activeIdx];
        map.panTo([e.lat, e.lon]);
      }
    }, 50);
  }

  function exitImmersive() {
    const mapEl = document.getElementById('map');
    const photoBar = document.getElementById('photo-bar');
    videoWrap.insertBefore(player, toolbar);
    document.body.insertBefore(mapEl, photoBar);
    document.body.classList.remove('immersive');
    map.setMaxBounds(null);
    setTimeout(() => map.invalidateSize(), 50);
  }

  document.getElementById('video-wrap').addEventListener('click', enterImmersive);
  document.getElementById('btn-immersive').addEventListener('click', enterImmersive);
  document.getElementById('btn-exit-immersive').addEventListener('click', exitImmersive);

  const stageRateBtn = document.getElementById('stage-rate-btn');
  stageRateBtn.addEventListener('click', () => {
    const cur = rateRates.indexOf(parseFloat(stageRateBtn.textContent));
    const next = rateRates[(cur + 1) % rateRates.length];
    player.playbackRate = next;
    stageRateBtn.textContent = `${next}×`;
  });

  // ── Mobile landscape ──────────────────────────────────
  const mobileLeft   = document.getElementById('mobile-left');
  const mobBtnVideo  = document.getElementById('mob-btn-video');
  const mobBtnPhotos = document.getElementById('mob-btn-photos');
  const mqlMobile    = window.matchMedia('(orientation: landscape) and (max-height: 500px)');

  let mobilePhotoStrip = null;

  function isMobileLandscape() { return mqlMobile.matches; }

  function enterMobileLandscape() {
    if (mobileLeft) mobileLeft.appendChild(player);
    map.setMaxBounds(routeBounds);
    setTimeout(() => {
      map.invalidateSize();
      if (state.activeIdx !== null) map.panTo([entries[state.activeIdx].lat, entries[state.activeIdx].lon]);
    }, 50);
  }

  function exitMobileLandscape() {
    videoWrap.insertBefore(player, toolbar);
    map.setMaxBounds(null);
    setTimeout(() => map.invalidateSize(), 50);
  }

  function buildMobilePhotoStrip() {
    if (mobilePhotoStrip) return;
    mobilePhotoStrip = document.createElement('div');
    mobilePhotoStrip.className = 'mob-photo-strip';
    const stripObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
          stripObserver.unobserve(img);
        }
      });
    }, { root: mobilePhotoStrip, rootMargin: '0px 400px 0px 400px' });

    photos.forEach((p, i) => {
      const img = document.createElement('img');
      img.dataset.src = p.thumb || p.src;
      img.draggable = false;
      img.addEventListener('click', () => openLightbox(photos, i));
      mobilePhotoStrip.appendChild(img);
      stripObserver.observe(img);
    });
  }

  function mobShowVideo() {
    mobBtnVideo.classList.add('active');
    mobBtnPhotos.classList.remove('active');
    if (mobilePhotoStrip && mobileLeft && mobileLeft.contains(mobilePhotoStrip)) mobileLeft.removeChild(mobilePhotoStrip);
    if (mobileLeft) mobileLeft.appendChild(player);
  }

  function mobShowPhotos() {
    mobBtnPhotos.classList.add('active');
    mobBtnVideo.classList.remove('active');
    if (mobileLeft && mobileLeft.contains(player)) mobileLeft.removeChild(player);
    buildMobilePhotoStrip();
    if (mobileLeft) mobileLeft.appendChild(mobilePhotoStrip);
    if (state.activePhotoIdx !== null) {
      const step = 124;
      mobilePhotoStrip.scrollTo({ left: state.activePhotoIdx * step + step / 2, behavior: 'smooth' });
    }
  }

  mobBtnVideo.addEventListener('click', mobShowVideo);
  mobBtnPhotos.addEventListener('click', mobShowPhotos);

  mqlMobile.addEventListener('change', e => {
    if (e.matches) enterMobileLandscape();
    else exitMobileLandscape();
  });
  if (isMobileLandscape()) enterMobileLandscape();

  // Keyboard
  document.addEventListener('keydown', ev => {
    if (!lightbox.hidden) {
      if (ev.key === 'ArrowLeft')  { if (state.lbIdx > 0) { state.lbIdx--; lbShowCurrent(); } }
      if (ev.key === 'ArrowRight') { if (state.lbIdx < state.lbPhotos.length - 1) { state.lbIdx++; lbShowCurrent(); } }
      if (ev.key === 'Escape') closeLightbox();
      return;
    }
    if (state.activeIdx === null) return;
    if      (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); if (state.activeIdx < entries.length - 1) selectEntry(state.activeIdx + 1); }
    else if (ev.key === 'ArrowLeft'  || ev.key === 'ArrowUp')   { ev.preventDefault(); if (state.activeIdx > 0) selectEntry(state.activeIdx - 1); }
    else if (ev.key === 'Escape') {
      if (document.body.classList.contains('immersive')) exitImmersive();
      else { closePanel(); player.pause(); }
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
