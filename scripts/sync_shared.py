#!/usr/bin/env python3
"""Copy every shared/ file into the overlays that use it, or --check that copies match.

Packages must be self-contained, so each overlay folder carries its own copy of the shared
files (vosu-overlay.js, the client; m3.js, the colour bundle mapPalette() loads). An overlay
opts in per file by having a file of that name; overlays that never adopted one (for example
ratings-timeline) are left alone.
"""
import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SHARED = ROOT / 'shared'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail if any copy differs instead of writing')
    args = parser.parse_args()
    stale = []
    for source in sorted(SHARED.iterdir()):
        expected = source.read_bytes()
        for copy in sorted((ROOT / 'overlays').glob(f'*/{source.name}')):
            if copy.read_bytes() == expected:
                continue
            stale.append(copy.relative_to(ROOT))
            if not args.check:
                copy.write_bytes(expected)
    if args.check and stale:
        print('stale shared copies (run python scripts/sync_shared.py):', *stale, sep='\n  ', file=sys.stderr)
        return 1
    for path in stale:
        print(f'updated {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
