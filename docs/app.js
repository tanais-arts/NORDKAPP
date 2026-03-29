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
  document.getElementById('lb-counter').textContent = `${state.lbIdx + 1} / ${state.lbPhotos.length}`;
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
  if (next) {
    next.classList.add('active');
    next.fetchPriority = 'high';
    if (next.dataset.src) { next.src = next.dataset.src; delete next.dataset.src; }
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
  player.oncanplay = () => {
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
      fetch('travel.json?v=1774802661').then(r => r.json()),
      fetch('photos.json?v=1774802661').then(r => r.json()),
      fetch('cities.json?v=1774802661').then(r => r.json()),
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
    img.dataset.src = p.thumb || p.src;
    img.className = 'photo-thumb';
    img.draggable = false;
    img.addEventListener('click', () => openLightbox(photos, i));
    fragment.appendChild(img);
  });
  carousel.appendChild(fragment);
  state.thumbEls = Array.from(carousel.querySelectorAll('.photo-thumb'));
  state.thumbEls.forEach(img => thumbObserver.observe(img));

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
  let curSeg = [], curInterp = null;
  const flushSeg = (interp) => {
    if (curSeg.length < 2) return;
    if (interp) {
      L.polyline(curSeg, { color: ACCENT, weight: 1.5, opacity: 0.35, smoothFactor: 2, dashArray: '4 7' }).addTo(map);
    } else {
      L.polyline(curSeg, { color: ACCENT, weight: 4, opacity: 0.65, smoothFactor: 1 })
        .on('click', ev => selectEntry(findNearestEntry(ev.latlng)))
        .addTo(map);
    }
  };
  entries.forEach((e, i) => {
    const interp = e.frame === 0;
    if (curInterp === null) curInterp = interp;
    if (interp !== curInterp) {
      const join = curSeg[curSeg.length - 1];
      flushSeg(curInterp);
      curSeg = [join];
      curInterp = interp;
    }
    curSeg.push([e.lat, e.lon]);
  });
  flushSeg(curInterp);

  state.markers = [];


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

  // Mode immersif
  const stage     = document.getElementById('video-stage');
  const videoWrap = document.getElementById('video-wrap');
  const toolbar   = document.getElementById('video-toolbar');
  const rateRates = [0.5, 1, 1.5, 2, 3, 4];

  const routeBounds = L.latLngBounds(entries.map(e => [e.lat, e.lon])).pad(0.15);

  function enterImmersive() {
    stage.appendChild(player);
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
    videoWrap.insertBefore(player, toolbar);
    document.body.classList.remove('immersive');
    map.setMaxBounds(null);
    setTimeout(() => map.invalidateSize(), 50);
  }

  document.getElementById('btn-immersive').addEventListener('click', enterImmersive);
  document.getElementById('btn-exit-immersive').addEventListener('click', exitImmersive);

  const stageRateBtn = document.getElementById('stage-rate-btn');
  stageRateBtn.addEventListener('click', () => {
    const cur = rateRates.indexOf(parseFloat(stageRateBtn.textContent));
    const next = rateRates[(cur + 1) % rateRates.length];
    player.playbackRate = next;
    document.getElementById('rate-display').textContent = `${next}×`;
    document.getElementById('rate-slider').value = next;
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
    mobileLeft.appendChild(player);
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
    if (mobilePhotoStrip && mobileLeft.contains(mobilePhotoStrip)) mobileLeft.removeChild(mobilePhotoStrip);
    mobileLeft.appendChild(player);
  }

  function mobShowPhotos() {
    mobBtnPhotos.classList.add('active');
    mobBtnVideo.classList.remove('active');
    if (mobileLeft.contains(player)) mobileLeft.removeChild(player);
    buildMobilePhotoStrip();
    mobileLeft.appendChild(mobilePhotoStrip);
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
