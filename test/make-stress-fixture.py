#!/usr/bin/env python3
"""Generate a synthetic day that stresses the display in ways the real sample does not:

  - direction sweeps all 16 sectors (the real file uses 3)
  - speed builds from calm to gale-force 38 kn (the real file peaks at 11.2)
  - a 40-minute outage gap mid-file
  - repeated headers, sentinel rows, irregular 17-33s sampling
  - written in windows-1252 with CRLF, like the device

Usage: python3 test/make-stress-fixture.py > sample/SsLog-18-08-2026.csv
"""
import math
import random
import sys

random.seed(1808)

HEADER = ("'Date, 'Time, 'Latitude, 'Longitude, 'SOG, 'COG, "
          "'TWS, 'TWA, 'TWD, 'Comment, ")
LAT = "38\u00b0 19.080' N"
LON = "026\u00b0 41.698' E"
SENTINEL = "- - - - -"

out = []
# Device writes the header twice at file open, as observed in the real log.
out.append(HEADER)
out.append(HEADER)

t = 6 * 3600          # start 06:00 UTC
end = 22 * 3600       # stop 22:00 UTC
gap_start, gap_end = 13 * 3600, 13 * 3600 + 40 * 60
session_restart = True

while t < end:
    if gap_start <= t < gap_end:          # station powered down
        t += 30
        session_restart = True
        continue

    if session_restart and out[-1] != HEADER:
        out.append(HEADER)                # new session -> new header block
        session_restart = False

    hours = t / 3600.0
    # Speed: calm dawn, gale through the afternoon, easing at dusk.
    base = 3 + 33 * math.exp(-((hours - 15.5) / 3.4) ** 2)
    tws = max(0.4, base + random.gauss(0, 1.1) + 2.2 * math.sin(hours * 5))

    # Direction: full clockwise sweep across the day, with jitter.
    twd = (40 + (hours - 6) * 21 + random.gauss(0, 7)) % 360

    twa = int(abs(random.gauss(35, 18))) % 180
    side = 'Port' if random.random() < 0.55 else 'Stbd'

    if random.random() < 0.06:             # GPS dropout
        sog, cog = SENTINEL, SENTINEL
    else:
        sog = f"{random.uniform(0, 0.3):04.1f}"
        cog = f"{random.randint(350, 359):03d}\u00b0 M"

    hh, rem = divmod(int(t), 3600)
    mm, ss = divmod(rem, 60)
    out.append(
        f"18/08/2026, {hh:02d}:{mm:02d}:{ss:02d} UTC, {LAT}, {LON}, "
        f"{sog}, {cog}, {tws:04.1f}, {twa:03d}\u00b0 {side}, "
        f"{int(twd):03d}\u00b0 M, , "
    )

    t += random.choice([17, 25, 28, 29, 30, 30, 30, 30, 31, 32, 33])

sys.stdout.buffer.write(('\r\n'.join(out) + '\r\n').encode('cp1252'))
