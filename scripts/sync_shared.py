#!/usr/bin/env python3
"""Copy shared/vosu-overlay.js into every overlay that uses it, or --check that copies match.

Packages must be self-contained, so each overlay folder carries its own copy of the shared
client. An overlay opts in by having a vosu-overlay.js file; overlays that never adopted the
shared client (for example ratings-timeline) are left alone.
"""
import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'shared' / 'vosu-overlay.js'
NAME = SOURCE.name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail if any copy differs instead of writing')
    args = parser.parse_args()
    expected = SOURCE.read_bytes()
    stale = []
    for copy in sorted((ROOT / 'overlays').glob(f'*/{NAME}')):
        if copy.read_bytes() == expected:
            continue
        stale.append(copy.relative_to(ROOT))
        if not args.check:
            copy.write_bytes(expected)
    if args.check and stale:
        print('stale shared client copies (run python scripts/sync_shared.py):', *stale, sep='\n  ', file=sys.stderr)
        return 1
    for path in stale:
        print(f'updated {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
