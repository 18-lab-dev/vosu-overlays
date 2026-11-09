#!/usr/bin/env python3
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import sync_shared


class SyncSharedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        shared = self.root / 'shared'
        (shared / 'fonts').mkdir(parents=True)
        (shared / 'vosu-overlay.js').write_text('export const client = 1;\n')
        (shared / 'tokens.css').write_text(':root { --bg: #111; }\n')
        (shared / 'kit.css').write_text('.kit { color: var(--text-1); }\n')
        (shared / 'fonts' / 'Barlow.woff2').write_bytes(b'font')
        # A client overlay that adopted the client, tokens and fonts but not the kit yet.
        self.client = self.root / 'overlays' / 'pp-counter'
        (self.client / 'fonts').mkdir(parents=True)
        (self.client / 'index.html').write_text('<link rel="stylesheet" href="tokens.css">')
        (self.client / 'vosu-overlay.js').write_text('old client\n')
        (self.client / 'tokens.css').write_text(':root { --bg: #111; }\n')
        (self.client / 'fonts' / 'Barlow.woff2').write_bytes(b'font')
        (self.client / 'fonts' / 'Removed.woff2').write_bytes(b'gone')
        # A self-contained overlay that never used the shared client (ratings-timeline).
        self.standalone = self.root / 'overlays' / 'timeline'
        self.standalone.mkdir()
        (self.standalone / 'index.html').write_text('<h1>timeline</h1>')

    def run_sync(self, *args):
        output = io.StringIO()
        with mock.patch.object(sync_shared, 'ROOT', self.root), mock.patch.object(sync_shared, 'SHARED', self.root / 'shared'), \
                mock.patch.object(sys, 'argv', ['sync_shared.py', *args]), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            return sync_shared.main(), output.getvalue()

    def test_kit_is_required_for_every_client_overlay_and_check_reports_it(self):
        code, report = self.run_sync('--check')
        self.assertEqual(code, 1)
        self.assertIn('overlays/pp-counter/kit.css', report)
        self.assertIn('overlays/pp-counter/vosu-overlay.js', report)
        self.assertIn('overlays/pp-counter/fonts/Removed.woff2', report)
        self.assertFalse((self.client / 'kit.css').exists(), '--check never writes')

    def test_sync_copies_kit_updates_drift_and_leaves_standalone_overlays_alone(self):
        code, _ = self.run_sync()
        self.assertEqual(code, 0)
        self.assertEqual((self.client / 'kit.css').read_bytes(), (self.root / 'shared' / 'kit.css').read_bytes())
        self.assertEqual((self.client / 'vosu-overlay.js').read_text(), 'export const client = 1;\n')
        self.assertFalse((self.client / 'fonts' / 'Removed.woff2').exists())
        self.assertEqual(sorted(p.name for p in self.standalone.iterdir()), ['index.html'])
        self.assertEqual(self.run_sync('--check')[0], 0)

    def test_kit_drift_fails_the_check(self):
        self.run_sync()
        (self.client / 'kit.css').write_text('.kit { color: red; }\n')
        code, report = self.run_sync('--check')
        self.assertEqual(code, 1)
        self.assertIn('overlays/pp-counter/kit.css', report)

    def test_opt_in_entries_are_not_forced_on_client_overlays(self):
        (self.client / 'tokens.css').unlink()
        self.run_sync()
        self.assertFalse((self.client / 'tokens.css').exists())
        self.assertTrue((self.client / 'kit.css').exists())

    def test_check_flags_overlays_loading_vosu_assets(self):
        self.run_sync()
        (self.client / 'index.html').write_text('<link rel="stylesheet" href="/assets/tokens.css">')
        code, report = self.run_sync('--check')
        self.assertEqual(code, 1)
        self.assertIn('overlays/pp-counter/index.html', report)


class RepositoryTests(unittest.TestCase):
    def test_repository_copies_match_shared(self):
        output = io.StringIO()
        with mock.patch.object(sys, 'argv', ['sync_shared.py', '--check']), contextlib.redirect_stderr(output):
            self.assertEqual(sync_shared.main(), 0, output.getvalue())


if __name__ == '__main__':
    unittest.main()
