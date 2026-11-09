#!/usr/bin/env python3
"""Copy shared/ into the overlays that use it, or --check that copies match.

Packages must be self-contained, so each overlay folder carries its own copy of the shared files:
vosu-overlay.js (client), m3.js (colour bundle for mapPalette()), tokens.css plus fonts/ (the
18-LAB tokens and fonts; vosu serves them at /assets/, but the vosu-tools replay renderer and
tosu do not) and kit.css (the overlay system: type, colour roles, backings, signature, motion;
docs/overlay-system.md). An overlay opts in per top-level entry by having a file or folder of that
name; overlays that never adopted one (for example ratings-timeline) are left alone. kit.css is
required: every overlay that carries vosu-overlay.js gets it.

--check also fails when an overlay still loads vosu's /assets/ instead of its own copies.
--tokens <vosu>/assets/server regenerates shared/tokens.css and shared/fonts/ from vosu.
"""
import argparse
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
SHARED = ROOT / 'shared'
HEADER = ("/* Bundled copy of vosu's assets/server/tokens.css with font URLs made relative, so overlays render\n"
          " * the same under hosts that do not serve vosu's /assets/ (vosu-tools replay renderer, tosu).\n"
          " * Regenerate with scripts/sync_shared.py --tokens <vosu>/assets/server; do not edit by hand. */\n")
ASSET_REFERENCE = re.compile(r'''(?:href|src)\s*=\s*["']/assets/|url\(\s*["']?/assets/''')
# Shared entries every overlay built on the shared client must carry, whether or not it has one yet.
REQUIRED = {'kit.css'}


def wanted(overlay, entry):
    """True when `overlay` should carry a copy of the shared `entry`."""
    if (overlay / entry.name).exists():
        return True
    return entry.name in REQUIRED and (overlay / 'vosu-overlay.js').exists()


def regenerate_tokens(source):
    css = (source / 'tokens.css').read_text()
    (SHARED / 'tokens.css').write_text(HEADER + re.sub(r'url\("/assets/([^"]+\.woff2)"\)', r'url("fonts/\1")', css))
    fonts = SHARED / 'fonts'
    shutil.rmtree(fonts, ignore_errors=True)
    fonts.mkdir()
    for font in sorted(source.glob('*.woff2')):
        shutil.copyfile(font, fonts / font.name)
    shutil.copyfile(source / 'fonts-OFL.txt', ROOT / 'licenses' / 'fonts-OFL.txt')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='fail if any copy differs instead of writing')
    parser.add_argument('--tokens', type=Path, help="vosu's assets/server folder to regenerate tokens.css and fonts from")
    args = parser.parse_args()
    if args.tokens:
        regenerate_tokens(args.tokens)
    stale = []
    for overlay in sorted(p for p in (ROOT / 'overlays').iterdir() if p.is_dir()):
        for entry in sorted(SHARED.iterdir()):
            if not wanted(overlay, entry):
                continue
            sources = sorted(f for f in entry.rglob('*') if f.is_file()) if entry.is_dir() else [entry]
            expected = {f.relative_to(SHARED) for f in sources}
            if entry.is_dir():
                # A copied folder holds exactly the shared files: removed fonts must not linger.
                for extra in sorted(f for f in (overlay / entry.name).rglob('*') if f.is_file()):
                    if extra.relative_to(overlay) not in expected:
                        stale.append(extra.relative_to(ROOT))
                        if not args.check:
                            extra.unlink()
            for source in sources:
                copy = overlay / source.relative_to(SHARED)
                if copy.is_file() and copy.read_bytes() == source.read_bytes():
                    continue
                stale.append(copy.relative_to(ROOT))
                if not args.check:
                    copy.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, copy)
    asset_users = sorted(
        path.relative_to(ROOT)
        for overlay in (ROOT / 'overlays').iterdir() if (overlay / 'vosu-overlay.js').exists()
        for path in overlay.rglob('*') if path.suffix in ('.html', '.css', '.js') and path.name != 'tokens.css'
        and ASSET_REFERENCE.search(path.read_text(errors='replace')))
    if args.check and (stale or asset_users):
        if stale:
            print('stale shared copies (run python scripts/sync_shared.py):', *stale, sep='\n  ', file=sys.stderr)
        if asset_users:
            print("overlays loading vosu's /assets/ (link the bundled tokens.css instead):", *asset_users, sep='\n  ', file=sys.stderr)
        return 1
    for path in stale:
        print(f'updated {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
