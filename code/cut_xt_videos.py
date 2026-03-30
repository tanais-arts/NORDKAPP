#!/usr/bin/env python3
"""
Cut xt highlight videos into 1-minute segments, interpolating GPS coordinates.
- Clips with < 5km spread: use fixed midpoint GPS
- Clips with >= 5km spread: use OSRM road routing to interpolate GPS per minute
Output: /Volumes/Transfert/xt_segments/ — ready to upload to filedn /vid/
Also generates new_travel_entries.json to merge into travel.json
"""

import json
import math
import subprocess
import time
import urllib.request
import urllib.parse
import os
from datetime import datetime, timedelta

# ── Config ──────────────────────────────────────────────────────────────────
XT_DIR   = "/Volumes/Transfert/xt"
OUT_DIR  = "/Volumes/Transfert/xt_segments"
TRAVEL   = "/Users/nathalie/Documents/_TOTO/NORDKAPP/docs/travel.json"
CDN_BASE = "https://filedn.com/lkWW0YSMhAbFD13RbGDalo0/vid"
OSRM_API = "https://router.project-osrm.org/route/v1/driving"

os.makedirs(OUT_DIR, exist_ok=True)

# ── Load travel.json ─────────────────────────────────────────────────────────
with open(TRAVEL) as f:
    travel = json.load(f)

def entry_dt(e):
    return datetime(2024, e['month'], e['day'], e['hour'], e['minute'])

travel_sorted = sorted(travel, key=entry_dt)

# ── Helpers ──────────────────────────────────────────────────────────────────
def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat/2)**2
         + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2)
    return R * 2 * math.asin(math.sqrt(max(0, min(1, a))))

def lerp(a, b, t):
    return a + (b - a) * t

def find_bracket(start_dt, end_dt):
    """Return (entry_before_start, entry_after_end)."""
    before = None
    after  = None
    for e in travel_sorted:
        dt = entry_dt(e)
        if dt <= start_dt:
            before = e
        elif dt >= end_dt and after is None:
            after = e
    return before, after

def get_osrm_route(lat1, lon1, lat2, lon2):
    """Return list of (lat, lon) waypoints from OSRM."""
    url = (f"{OSRM_API}/{lon1},{lat1};{lon2},{lat2}"
           f"?overview=full&geometries=geojson&steps=false")
    print(f"  OSRM: {url}")
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read())
        coords = data['routes'][0]['geometry']['coordinates']
        # OSRM returns [lon, lat]
        return [(c[1], c[0]) for c in coords]
    except Exception as ex:
        print(f"  OSRM failed: {ex} — falling back to linear")
        return [(lat1, lon1), (lat2, lon2)]

def interpolate_along_route(waypoints, n_points):
    """Distribute n_points evenly along a list of (lat,lon) waypoints by cumulative distance."""
    if n_points == 1:
        return [waypoints[0]]
    # Build cumulative distances
    cumdist = [0.0]
    for i in range(1, len(waypoints)):
        d = haversine_km(waypoints[i-1][0], waypoints[i-1][1],
                         waypoints[i][0],   waypoints[i][1])
        cumdist.append(cumdist[-1] + d)
    total = cumdist[-1]
    if total == 0:
        return [waypoints[0]] * n_points
    result = []
    for k in range(n_points):
        target = total * k / (n_points - 1) if n_points > 1 else 0
        # Find segment
        for i in range(1, len(cumdist)):
            if cumdist[i] >= target or i == len(cumdist)-1:
                seg_len = cumdist[i] - cumdist[i-1]
                t = (target - cumdist[i-1]) / seg_len if seg_len > 0 else 0
                lat = lerp(waypoints[i-1][0], waypoints[i][0], t)
                lon = lerp(waypoints[i-1][1], waypoints[i][1], t)
                result.append((round(lat, 6), round(lon, 6)))
                break
    return result

def get_video_duration(path):
    out = subprocess.check_output(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', path],
        stderr=subprocess.DEVNULL
    )
    return float(json.loads(out)['format']['duration'])

def cut_video(src, out_dir, start_name, start_dt, n_mins):
    """Cut src into 1-minute segments; name them JJMM_HHMM.mp4."""
    out_paths = []
    for i in range(n_mins):
        seg_dt = start_dt + timedelta(minutes=i)
        name = f"{seg_dt.day:02d}{seg_dt.month:02d}_{seg_dt.hour:02d}{seg_dt.minute:02d}.mp4"
        out_path = os.path.join(out_dir, name)
        out_paths.append((out_path, name, seg_dt))
        if os.path.exists(out_path):
            print(f"  skip {name} (exists)")
            continue
        cmd = [
            'ffmpeg', '-y', '-ss', str(i * 60), '-i', src,
            '-t', '60', '-c', 'copy', '-movflags', '+faststart',
            out_path
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print(f"  cut  {name}")
    return out_paths

# ── xt file list with parsed timestamps ──────────────────────────────────────
xt_files = []
for fname in sorted(os.listdir(XT_DIR)):
    if not fname.endswith('.mp4'):
        continue
    base = fname[:-4]       # e.g. "0207_0923"
    day   = int(base[0:2])
    month = int(base[2:4])
    hour  = int(base[5:7])
    minute= int(base[7:9])
    xt_files.append((fname, base, day, month, hour, minute))

# ── Main loop ─────────────────────────────────────────────────────────────────
new_entries = []

for fname, base, day, month, hour, minute in xt_files:
    src = os.path.join(XT_DIR, fname)
    print(f"\n{'='*60}")
    print(f"Processing {fname}")

    start_dt = datetime(2024, month, day, hour, minute)
    dur_s    = get_video_duration(src)
    n_mins   = int(dur_s // 60)
    end_dt   = start_dt + timedelta(seconds=dur_s)

    print(f"  Start: {start_dt}  End: {end_dt}  Segments: {n_mins}")

    before, after = find_bracket(start_dt, end_dt)
    if not before:
        print("  WARNING: no entry before — using start_dt position unknown")
    if not after:
        print("  WARNING: no entry after — using last known position")

    # GPS anchor points
    lat1 = before['lat'] if before else (after['lat'] if after else 0)
    lon1 = before['lon'] if before else (after['lon'] if after else 0)
    lat2 = after['lat']  if after  else lat1
    lon2 = after['lon']  if after  else lon1

    dist_km = haversine_km(lat1, lon1, lat2, lon2)
    print(f"  GPS: ({lat1:.4f},{lon1:.4f}) → ({lat2:.4f},{lon2:.4f})  dist={dist_km:.1f} km")

    # Get GPS waypoints
    if dist_km > 5:
        waypoints = get_osrm_route(lat1, lon1, lat2, lon2)
        print(f"  OSRM returned {len(waypoints)} waypoints")
        time.sleep(1)  # be polite to free API
    else:
        waypoints = [(lat1, lon1), (lat2, lon2)]

    # Distribute n_mins+1 GPS points along route (one per minute boundary)
    gps_pts = interpolate_along_route(waypoints, max(n_mins, 1))

    # Cut video into segments
    if n_mins == 0:
        print("  Clip < 1 minute — skipping cut, keeping as single segment")
        # Still generate one entry
        name = f"{day:02d}{month:02d}_{hour:02d}{minute:02d}.mp4"
        out_path = os.path.join(OUT_DIR, name)
        if not os.path.exists(out_path):
            cmd = ['ffmpeg', '-y', '-i', src, '-c', 'copy', '-movflags', '+faststart', out_path]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            print(f"  copy {name}")
        pt = gps_pts[0]
        new_entries.append({
            'day': day, 'month': month, 'hour': hour, 'minute': minute,
            'lat': pt[0], 'lon': pt[1],
            'url': f"{CDN_BASE}/{name}",
            'frame': 4
        })
        continue

    out_segs = cut_video(src, OUT_DIR, base, start_dt, n_mins)

    for i, (out_path, seg_name, seg_dt) in enumerate(out_segs):
        pt = gps_pts[i] if i < len(gps_pts) else gps_pts[-1]
        new_entries.append({
            'day':    seg_dt.day,
            'month':  seg_dt.month,
            'hour':   seg_dt.hour,
            'minute': seg_dt.minute,
            'lat':    pt[0],
            'lon':    pt[1],
            'url':    f"{CDN_BASE}/{seg_name}",
            'frame':  4
        })

print(f"\n{'='*60}")
print(f"Generated {len(new_entries)} new entries")

# Save new entries
with open('/Users/nathalie/Documents/_TOTO/NORDKAPP/code/new_travel_entries.json', 'w') as f:
    json.dump(new_entries, f, indent=2, ensure_ascii=False)
print("Saved → new_travel_entries.json")
