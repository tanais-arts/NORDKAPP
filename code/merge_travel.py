#!/usr/bin/env python3
"""
Merge new_travel_entries.json into travel.json.
Assigns new sequential IDs, preserving chronological order.
Removes duplicates (same day/month/hour/minute already in travel.json).
"""

import json
from datetime import datetime

TRAVEL     = '/Users/nathalie/Documents/_TOTO/NORDKAPP/docs/travel.json'
NEW_ENTRIES= '/Users/nathalie/Documents/_TOTO/NORDKAPP/code/new_travel_entries.json'
OUT        = '/Users/nathalie/Documents/_TOTO/NORDKAPP/docs/travel.json'

def entry_dt(e):
    return datetime(2024, e['month'], e['day'], e['hour'], e['minute'])

with open(TRAVEL) as f:
    travel = json.load(f)

with open(NEW_ENTRIES) as f:
    new_entries = json.load(f)

# Build existing timestamp set
existing_keys = {
    (e['day'], e['month'], e['hour'], e['minute'])
    for e in travel
}

# Filter out duplicates
added = []
skipped = 0
for e in new_entries:
    key = (e['day'], e['month'], e['hour'], e['minute'])
    if key in existing_keys:
        skipped += 1
    else:
        added.append(e)
        existing_keys.add(key)

print(f"New entries to add : {len(added)}")
print(f"Duplicates skipped : {skipped}")

# Merge and sort
merged = travel + added
merged.sort(key=entry_dt)

# Re-assign sequential IDs
for i, e in enumerate(merged):
    e['id'] = i + 1

with open(OUT, 'w') as f:
    json.dump(merged, f, separators=(',', ':'), ensure_ascii=False)

print(f"travel.json updated: {len(merged)} total entries")
