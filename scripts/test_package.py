#!/usr/bin/env python3
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

import package


class OverlayPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.overlay = self.root / 'overlays/timeline'
        self.overlay.mkdir(parents=True)
        (self.overlay / 'index.html').write_text('<h1>timeline</h1>')
        (self.overlay / 'overlay.js').write_text('console.log("timeline")')
        (self.overlay / 'settings.json').write_text('[]')
        (self.overlay / 'metadata.txt').write_text('name = Timeline\nauthor = 18-LAB\nversion = 0.1.0\ndescription = Test overlay\nrequires_tools = [{"id":"map-analysis","version":">=0.1.0"}]\nresolution = [1920,1080]\n')
        (self.root / 'LICENSE').write_text('MIT test license text')
        for sidecar in ['lyrics', 'map', 'keys']:
            directory = self.root / sidecar
            directory.mkdir()
            (directory / 'index.html').write_text('sidecar-only')

    def build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return package.package(self.root, self.root / 'dist', 'https://example.com/releases/v1', '2026-10-21T00:00:00Z')

    def test_only_self_contained_overlays_are_cataloged(self):
        catalog = self.build()
        self.assertEqual([entry['id'] for entry in catalog['overlays']], ['timeline'])
        self.assertEqual(catalog['overlays'][0]['requires_tools'], [{'id': 'map-analysis', 'version': '>=0.1.0'}])
        self.assertEqual(catalog['overlays'][0]['resolution'], [1920, 1080])
        self.assertEqual(json.loads((self.root / 'dist/catalog.json').read_text()), catalog)

    def test_zip_is_deterministic_with_size_digest_modes_and_license(self):
        first = self.build()
        path = next((self.root / 'dist').glob('*.zip'))
        original = path.read_bytes()
        second = self.build()
        self.assertEqual(original, path.read_bytes())
        self.assertEqual(first, second)
        record = first['overlays'][0]['package']
        self.assertEqual(record['sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(record['size'], len(original))
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.namelist(), sorted(archive.namelist()))
            self.assertIn('licenses/project-MIT.txt', archive.namelist())
            for entry in archive.infolist():
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(entry.external_attr >> 16, stat.S_IFREG | 0o644)

    def test_preview_is_a_separate_release_asset(self):
        (self.overlay / 'preview.png').write_bytes(b'fixture preview')
        catalog = self.build()
        preview = catalog['overlays'][0]['preview']
        self.assertEqual(preview, 'https://example.com/releases/v1/vosu-overlay-timeline-0.1.0-preview.png')
        self.assertEqual((self.root / 'dist/vosu-overlay-timeline-0.1.0-preview.png').read_bytes(), b'fixture preview')

    def test_artwork_fallback_and_explicit_metadata(self):
        (self.overlay / 'icon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>')
        (self.overlay / 'wide.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400"/>')
        with (self.overlay / 'metadata.txt').open('a') as output:
            output.write('banner = wide.svg\n')
        entry = self.build()['overlays'][0]
        self.assertEqual(entry['icon_url'], 'https://example.com/releases/v1/vosu-overlay-timeline-icon.svg')
        self.assertEqual(entry['banner_url'], 'https://example.com/releases/v1/vosu-overlay-timeline-banner.svg')
        self.assertEqual((self.root / 'dist/vosu-overlay-timeline-banner.svg').read_bytes(), (self.overlay / 'wide.svg').read_bytes())
        with zipfile.ZipFile(next((self.root / 'dist').glob('*.zip'))) as archive:
            self.assertIn('wide.svg', archive.namelist())

    def test_invalid_declared_art_is_not_silently_omitted(self):
        with (self.overlay / 'metadata.txt').open('a') as output:
            output.write('banner = missing.svg\n')
        with self.assertRaises(ValueError):
            self.build()

    def test_rejects_missing_index_and_invalid_identity(self):
        (self.overlay / 'index.html').unlink()
        with self.assertRaises(ValueError):
            self.build()
        (self.overlay / 'index.html').write_text('okay')
        self.overlay.rename(self.overlay.with_name('BadId'))
        with self.assertRaises(ValueError):
            self.build()

    def test_rejects_symlinks(self):
        try:
            (self.overlay / 'linked').symlink_to(self.root / 'LICENSE')
        except OSError:
            self.skipTest('symlinks unavailable')
        with self.assertRaises(ValueError):
            self.build()

    def test_rejects_bad_metadata_dependencies_and_non_https_base(self):
        with self.assertRaises(ValueError):
            package.release_url('http://example.com', 'catalog.json')
        path = self.overlay / 'metadata.txt'
        original = path.read_text()
        for replacement in ['requires_tools = [{"id":"../bad","version":">=0.1.0"}]', 'requires_tools = [{"id":"map-analysis","version":"bad"}]', 'requires_tools = "map-analysis"']:
            path.write_text('\n'.join(line for line in original.splitlines() if not line.startswith('requires_tools')) + '\n' + replacement + '\n')
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                self.build()


if __name__ == '__main__':
    unittest.main()
