#!/usr/bin/env python3
"""Package only self-contained overlays/ folders, not Python-sidecar routes."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def valid_id(value):
    return bool(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,31}', value))


def release_url(base, name):
    value = base.rstrip('/') + '/' + name
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError('release base URL must be HTTPS, without credentials or fragment')
    return value


def metadata(directory):
    result = {}
    for line in (directory / 'metadata.txt').read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or not key.strip() or key.strip() in result:
            raise ValueError(f'invalid or duplicate metadata line: {line}')
        value = value.strip()
        result[key.strip()] = json.loads(value) if value[:1] in ('[', '{', '"') else value
    for key in ('name', 'version', 'author', 'description'):
        if not isinstance(result.get(key), str) or not result[key]:
            raise ValueError(f'missing overlay metadata {key}: {directory}')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?', result['version']):
        raise ValueError('overlay version must be semantic version X.Y.Z')
    requirements = result.setdefault('requires_tools', [])
    if not isinstance(requirements, list):
        raise ValueError('requires_tools must be a JSON array')
    seen = set()
    clause = r'(?:>=|<=|>|<|=|~|\^)?\s*(?:\*|\d+(?:\.(?:\d+|\*)){0,2}(?:-[0-9A-Za-z.-]+)?)'
    for requirement in requirements:
        if not isinstance(requirement, dict) or set(requirement) != {'id', 'version'} or not valid_id(requirement['id']) or requirement['id'] in seen or not re.fullmatch(clause + r'(?:\s*,\s*' + clause + r')*', requirement['version']):
            raise ValueError('invalid/duplicate requires_tools entry')
        seen.add(requirement['id'])
    resolution = result.get('resolution')
    if resolution is not None and (not isinstance(resolution, list) or len(resolution) != 2 or any(type(v) is not int or v < 1 for v in resolution)):
        raise ValueError('resolution must be a JSON [width,height] of positive integers')
    return result


def files_for(root, directory):
    if directory.is_symlink() or not (directory / 'index.html').is_file():
        raise ValueError(f'overlay must be a real directory with index.html: {directory}')
    files = {}
    for source in sorted(directory.rglob('*')):
        mode = source.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError(f'non-regular overlay input: {source}')
        if source.is_file():
            files[source.relative_to(directory).as_posix()] = source.read_bytes()
    files['licenses/project-MIT.txt'] = (root / 'LICENSE').read_bytes()
    paths = set()
    for name in files:
        path = PurePosixPath(name)
        if path.is_absolute() or '\\' in name or ':' in name or '\0' in name or any(p in ('', '.', '..') for p in name.split('/')):
            raise ValueError(f'unsafe overlay path: {name}')
        for parent in path.parents:
            if parent.as_posix() != '.':
                if parent.as_posix() in files:
                    raise ValueError(f'file/directory collision: {name}')
                paths.add(parent.as_posix())
        paths.add(name)
    if len(paths) + 1 > 10000 or sum(map(len, files.values())) > 512 * 1024 * 1024:
        raise ValueError('overlay exceeds host archive limits')
    return files


def write_zip(path, files):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise ValueError('generated ZIP failed CRC validation')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return {'size': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def package(root, out, base_url, date, name='18-LAB official overlays'):
    release_url(base_url, 'catalog.json')
    directories = sorted(path for path in (root / 'overlays').iterdir() if path.is_dir())
    if not directories:
        raise ValueError('no self-contained overlays found')
    catalog = {'catalog_version': 1, 'name': name, 'published': date, 'overlays': []}
    out.mkdir(parents=True, exist_ok=True)
    for directory in directories:
        if not valid_id(directory.name) or directory.name == 'tools':
            raise ValueError(f'invalid overlay id: {directory.name}')
        values = metadata(directory)
        files = files_for(root, directory)
        filename = f'vosu-overlay-{directory.name}-{values["version"]}.zip'
        integrity = write_zip(out / filename, files)
        preview = values.get('preview')
        if preview is None:
            preview = next((path.name for path in sorted(directory.glob('preview.*')) if path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')), None)
        if preview:
            source = directory / preview
            if source.is_symlink() or not source.resolve().is_relative_to(directory.resolve()) or not source.is_file():
                raise ValueError('preview must be a regular image file inside the overlay')
            preview_name = f'vosu-overlay-{directory.name}-{values["version"]}-preview{source.suffix}'
            (out / preview_name).write_bytes(source.read_bytes())
            preview = release_url(base_url, preview_name)
        entry = {key: values[key] for key in ('name', 'version', 'description', 'author')}
        entry.update({'id': directory.name, 'homepage': values.get('homepage'), 'resolution': values.get('resolution'),
                      'preview': preview, 'requires_tools': values['requires_tools'],
                      'package': {'url': release_url(base_url, filename), **integrity}})
        catalog['overlays'].append(entry)
        print(f'{directory.name}\t{integrity["size"]}\t{integrity["sha256"]}')
    with tempfile.NamedTemporaryFile(dir=out, mode='w', encoding='utf-8', newline='\n', delete=False) as output:
        temporary = Path(output.name)
        json.dump(catalog, output, indent=2, sort_keys=True)
        output.write('\n')
    try:
        os.replace(temporary, out / 'catalog.json')
    finally:
        temporary.unlink(missing_ok=True)
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path, default=Path('dist'))
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--name', default='18-LAB official overlays')
    parser.add_argument('--published')
    args = parser.parse_args()
    try:
        epoch = os.environ.get('SOURCE_DATE_EPOCH')
        date = args.published or (datetime.fromtimestamp(int(epoch), timezone.utc) if epoch else datetime.now(timezone.utc)).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
        datetime.fromisoformat(date.replace('Z', '+00:00'))
        package(args.root.resolve(), args.out.resolve(), args.base_url, date, args.name)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
