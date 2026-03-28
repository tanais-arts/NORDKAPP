// NORDKAPP — interactive travel journal
'use strict';

const FRAME_BASE = '../media/frames/frame-';
const MONTHS_FR  = ['','janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
const ACCENT     = '#f0c060';
const DOT_COLOR  = '#f0c060';
const DOT_RADIUS = 4;
const DOT_ACTIVE = 8;

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
};

// ── Map ──────────────────────────────────────────────────────────────
const renderer = L.canvas({ padding: 0.5 });

const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView([55, 10], 5);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  maxZoom: 19, subdomains: 'abcd',
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

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
  lbImg.onload  = () => prog.classList.remove('active');
  lbImg.onerror = () => prog.classList.remove('active');
  lbImg.src = item.src;
  document.getElementById('lightbox-prev').style.visibility = state.lbIdx > 0 ? '' : 'hidden';
  document.getElementById('lightbox-next').style.visibility = state.lbIdx < state.lbPhotos.length - 1 ? '' : 'hidden';
}

document.getElementById('lightbox-backdrop').addEventListener('click', closeLightbox);
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', () => { if (state.lbIdx > 0) { state.lbIdx--; lbShowCurrent(); } });
document.getElementById('lightbox-next').addEventListener('click', () => { if (state.lbIdx < state.lbPhotos.length - 1) { state.lbIdx++; lbShowCurrent(); } });


// ── Timeline ──────────────────────────────────────────────────────────
function updateTimelineThumb(idx) {
  const total  = state.entries.length - 1;
  const pct    = total > 0 ? idx / total : 0;
  const wrapW  = document.getElementById('timeline-slider-wrap').offsetWidth;
  const offset = pct * (wrapW - 14) + 7;
  tlThumbLabel.style.left = `${offset}px`;
  const e = state.entries[idx];
  if (e) tlThumbLabel.textContent = `${e.day} ${MONTHS_FR[e.month]}`;
}

function buildTimelineCities(cities, totalEntries) {
  tlCitiesRow.innerHTML = '';
  cities.filter(c => c.entryIdx != null).forEach(c => {
    const pct = (c.entryIdx / (totalEntries - 1)) * 100;
    const div = document.createElement('div');
    div.className = 'tl-city-tick';
    div.style.left = `${pct}%`;
    div.innerHTML = `<div class="tick-line"></div><div class="tick-name">${c.name}</div>`;
    tlCitiesRow.appendChild(div);
  });
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

function scrollCarouselTo(pi) {
  if (pi === state.activePhotoIdx) return;
  const carousel = document.getElementById('photo-carousel');
  carousel.scrollTo({ left: pi * THUMB_STEP + THUMB_STEP / 2, behavior: 'smooth' });
  const prev = state.thumbEls[state.activePhotoIdx];
  if (prev) { prev.classList.remove('active'); prev.fetchPriority = 'low'; }
  const next = state.thumbEls[pi];
  if (next) { next.classList.add('active'); next.fetchPriority = 'high'; next.loading = 'eager'; }
  state.activePhotoIdx = pi;
}

// ── Select entry ─────────────────────────────────────────────────────
function selectEntry(idx) {
  const entries = state.entries;
  if (idx < 0 || idx >= entries.length) return;
  const e = entries[idx];
  state.activeIdx = idx;

  state.markers.forEach((m, i) => {
    m.setStyle({
      fillColor:   i === idx ? '#fff' : DOT_COLOR,
      radius:      i === idx ? DOT_ACTIVE : DOT_RADIUS,
      fillOpacity: i === idx ? 1 : 0.75,
    });
  });

  showRing([e.lat, e.lon]);
  scrollCarouselTo(nearestPhotoIdx(idx));
  if (!map.getBounds().contains([e.lat, e.lon])) {
    map.panTo([e.lat, e.lon], { animate: true, duration: 0.4 });
  }

  openPanel();
  updatePanel(e, idx);

  tlInput.value = idx;
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
  player.onloadeddata = () => {
    player.playbackRate = currentRate();
    player.play().catch(() => { player.muted = true; player.play().catch(() => {}); });
  };
  player.onended = () => {
    const next = state.activeIdx + 1;
    if (next < entries.length) selectEntry(next);
  };

}

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  let entries, photos, cities, visited;
  try {
    [entries, photos, cities, visited] = await Promise.all([
      fetch('travel.json?v=1774643824').then(r => r.json()),
      fetch('photos.json?v=1774643824').then(r => r.json()),
      fetch('cities.json?v=1774643824').then(r => r.json()),
      fetch('visited.json').then(r => r.json()),
    ]);
  } catch (err) {
    console.error('Impossible de charger les données', err);
    return;
  }
  if (!entries.length) return;
  state.entries = entries;
  state.photos  = photos;
  state.cities  = cities;

  // Carousel
  const carousel = document.getElementById('photo-carousel');
  const fragment = document.createDocumentFragment();
  photos.forEach((p, i) => {
    const img = document.createElement('img');
    img.src = p.thumb || p.src;
    img.className = 'photo-thumb';
    img.loading = 'lazy';
    img.draggable = false;
    img.addEventListener('click', () => openLightbox(photos, i));
    fragment.appendChild(img);
  });
  carousel.appendChild(fragment);
  state.thumbEls = Array.from(carousel.querySelectorAll('.photo-thumb'));

  // Nearest entryIdx for each city
  cities.forEach(c => {
    let best = 0, bestD = Infinity;
    entries.forEach((e, i) => {
      const d = (e.lat - c.lat) ** 2 + (e.lon - c.lon) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    c.entryIdx = best;
  });

  // Route polyline
  const latlngs = entries.map(e => [e.lat, e.lon]);
  L.polyline(latlngs, { color: ACCENT, weight: 1.5, opacity: 0.45, smoothFactor: 1.5 }).addTo(map);

  // Video markers (canvas)
  state.markers = entries.map((e, i) => {
    const m = L.circleMarker([e.lat, e.lon], {
      renderer, radius: DOT_RADIUS, fillColor: DOT_COLOR,
      fillOpacity: 0.75, color: 'rgba(0,0,0,0.4)', weight: 0.5,
    }).addTo(map);
    m.on('click', () => selectEntry(i));
    m.bindTooltip(
      `<b>${e.day} ${MONTHS_FR[e.month]}</b> · ${e.hour}h${String(e.minute).padStart(2,'0')}`,
      { direction: 'top', offset: [0,-6], opacity: 0.9 }
    );
    return m;
  });


  map.fitBounds(L.latLngBounds(latlngs), { padding: [20,20] });

  // Visited city labels
  visited.forEach(c => {
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: 'city-label', html: c.name, iconAnchor: [0, 0] }),
      interactive: false,
    }).addTo(map);
  });



  // Timeline
  tlInput.max = entries.length - 1;
  tlInput.value = 0;
  updateTimelineThumb(0);
  buildTimelineCities(visited, entries.length);
  tlInput.addEventListener('input', () => {
    const idx = Number(tlInput.value);
    updateTimelineThumb(idx);
    selectEntry(idx);
  });

  // Panel controls
  document.getElementById('panel-close').addEventListener('click', () => { closePanel(); player.pause(); });

  // Carousel arrows
  const carouselEl = document.getElementById('photo-carousel');
  document.getElementById('carousel-prev').addEventListener('click', () => carouselEl.scrollBy({ left: -4 * THUMB_STEP, behavior: 'smooth' }));
  document.getElementById('carousel-next').addEventListener('click', () => carouselEl.scrollBy({ left:  4 * THUMB_STEP, behavior: 'smooth' }));

  // Rate
  const rateSlider  = document.getElementById('rate-slider');
  const rateDisplay = document.getElementById('rate-display');
  rateSlider.addEventListener('input', () => {
    const r = parseFloat(rateSlider.value);
    rateDisplay.textContent = `${r}×`;
    player.playbackRate = r;
  });

  // Expand video
  document.getElementById('btn-expand-video').addEventListener('click', () => {
    if (player.requestFullscreen) player.requestFullscreen();
    else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
  });

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
    else if (ev.key === 'Escape') { closePanel(); player.pause(); }
  });
}

document.addEventListener('DOMContentLoaded', init);
