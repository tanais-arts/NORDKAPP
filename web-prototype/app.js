// Simple app for NORDKAPP prototype
// - parses ../data/travel.txt
// - creates markers on the map
// - wires timeline, play/pause, rate, video and photo preview

const state = {
  entries: [],
  index: 0,
  timer: null,
  photoIndex: 0,
};

function pad(n, len = 4) { return String(n).padStart(len, '0'); }

function parseTravel(txt) {
  const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    // format: 1, 1.238043 44.842075 https://...mp4 17 6 13 8 4;
    const clean = line.replace(/;$/, '');
    const parts = clean.split(',');
    if (parts.length < 2) continue;
    const id = parts[0].trim();
    const rest = parts[1].trim().split(/\s+/);
    if (rest.length < 8) continue;
    const [lon, lat, url, day, month, hour, minute, frame] = rest;
    entries.push({
      id: Number(id), lon: Number(lon), lat: Number(lat), url,
      day: Number(day), month: Number(month), hour: Number(hour), minute: Number(minute), frame: Number(frame)
    });
  }
  return entries;
}

function computeBounds(entries) {
  const lons = entries.map(e => e.lon);
  const lats = entries.map(e => e.lat);
  return {
    lonMin: Math.min(...lons), lonMax: Math.max(...lons),
    latMin: Math.min(...lats), latMax: Math.max(...lats),
  };
}

function lonLatToPixels(lon, lat, bounds, img) {
  const {lonMin, lonMax, latMin, latMax} = bounds;
  const x = (lon - lonMin) / (lonMax - lonMin) * img.naturalWidth;
  const y = (latMax - lat) / (latMax - latMin) * img.naturalHeight; // invert y
  const scale = img.clientWidth / img.naturalWidth;
  return {x: x * scale, y: y * scale};
}

function makeMarkers(entries, bounds, img) {
  const container = document.getElementById('markers');
  container.innerHTML = '';
  entries.forEach((e, i) => {
    const el = document.createElement('div');
    el.className = 'marker';
    el.dataset.index = i;
    el.title = `${e.day}/${e.month} ${e.hour}:${String(e.minute).padStart(2,'0')}`;
    el.addEventListener('click', () => {
      selectIndex(i);
    });
    container.appendChild(el);
    // position now and on resize
    function position() {
      const p = lonLatToPixels(e.lon, e.lat, bounds, img);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    }
    position();
    window.addEventListener('resize', position);
  });
}

function updateActiveMarker(index) {
  document.querySelectorAll('#markers .marker').forEach(m => m.classList.remove('active'));
  const m = document.querySelector(`#markers .marker[data-index='${index}']`);
  if (m) m.classList.add('active');
}

function updateUIForEntry(e) {
  const player = document.getElementById('player');
  if (player.src !== e.url) {
    player.src = e.url;
    player.load();
  }
  // no debug link
  // try autoplay when the media is ready
  player.onloadeddata = () => {
    player.play().catch(() => {
      // some browsers block autoplay; try muting and play
      player.muted = true;
      player.play().catch(() => {});
    });
  };
  player.onended = () => {
    const next = state.index + 1;
    if (next < state.entries.length) selectIndex(next);
  };

  // expected frames: ../media/frames/frame-0004.jpg (pad to 4)
  const fname = `../media/frames/frame-${pad(e.frame)}.jpg`;
  const active = document.getElementById('active-photo-img');
  if (active) active.src = fname;
  const timeInfo = document.getElementById('time-info');
  timeInfo.textContent = `${e.day}/${e.month} ${e.hour}:${String(e.minute).padStart(2,'0')}`;
  const clock = document.getElementById('clock');
  clock.textContent = timeInfo.textContent;
}

function selectIndex(i) {
  state.index = i;
  state.photoIndex = i;
  const range = document.getElementById('timeline');
  range.value = i;
  const e = state.entries[i];
  updateActiveMarker(i);
  updateUIForEntry(e);
  renderCarouselAround(state.photoIndex);
}

function startAutoPlay() {
  stopAutoPlay();
  const rate = parseFloat(document.getElementById('rate').value) || 1;
  const delay = 1000 / rate;
  state.timer = setInterval(() => {
    let next = state.index + 1;
    if (next >= state.entries.length) { stopAutoPlay(); return; }
    selectIndex(next);
  }, delay);
}

function stopAutoPlay() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

function wireControls() {
  document.getElementById('timeline').addEventListener('input', (ev) => {
    selectIndex(Number(ev.target.value));
  });

  document.getElementById('rate').addEventListener('input', (ev) => {
    const v = parseFloat(ev.target.value);
    document.getElementById('player').playbackRate = v;
  });

  document.getElementById('prevPhoto').addEventListener('click', () => {
    // only change carousel photo, do not change map/timeline
    state.photoIndex = Math.max(0, state.photoIndex - 1);
    showPhotoForPhotoIndex(state.photoIndex);
  });
  document.getElementById('nextPhoto').addEventListener('click', () => {
    state.photoIndex = Math.min(state.entries.length - 1, state.photoIndex + 1);
    showPhotoForPhotoIndex(state.photoIndex);
  });
}

function showPhotoForPhotoIndex(photoIdx) {
  const e = state.entries[photoIdx];
  if (!e) return;
  const fname = `../media/frames/frame-${pad(e.frame)}.jpg`;
  const active = document.getElementById('active-photo-img');
  if (active) active.src = fname;
  renderCarouselAround(photoIdx);
}

function renderCarouselAround(centerIdx) {
  const c = document.getElementById('carousel');
  if (!c) return;
  c.innerHTML = '';
  const start = Math.max(0, centerIdx - 6);
  const end = Math.min(state.entries.length - 1, centerIdx + 6);
  for (let i = start; i <= end; i++) {
    const e = state.entries[i];
    const img = document.createElement('img');
    img.className = 'thumb' + (i === centerIdx ? ' active' : '');
    img.src = `../media/frames/frame-${pad(e.frame)}.jpg`;
    img.dataset.idx = i;
    img.addEventListener('click', (ev) => {
      const idx = Number(ev.currentTarget.dataset.idx);
      state.photoIndex = idx;
      showPhotoForPhotoIndex(idx);
    });
    c.appendChild(img);
  }
}

async function init() {
  try {
    // Prefer static JSON for faster loading; fallback to original travel.txt
    let entries = [];
    try {
      const r = await fetch('travel.json');
      if (r.ok) {
        entries = await r.json();
      } else {
        throw new Error('no json');
      }
    } catch (err) {
      const res = await fetch('../data/travel.txt');
      const txt = await res.text();
      entries = parseTravel(txt);
    }

    if (!entries.length) throw new Error('No entries parsed');
    state.entries = entries;
    const bounds = computeBounds(entries);

    const img = document.getElementById('map');
    if (!img.complete) {
      img.addEventListener('load', () => {
        makeMarkers(entries, bounds, img);
      });
    } else {
      makeMarkers(entries, bounds, img);
    }

    const range = document.getElementById('timeline');
    range.max = entries.length - 1;
    range.value = 0;

    wireControls();
    selectIndex(0);
  } catch (err) {
    console.error('Init error', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
