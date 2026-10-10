"""Atomic evidence writes with optional transparent macOS filesystem compression."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def write_evidence(path, value):
    path = Path(path)
    data = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    temporary = path.with_name(path.name + '.tmp')
    compressed = path.with_name(path.name + '.compressed-tmp')
    try:
        temporary.write_bytes(data)
        if sys.platform == 'darwin' and os.environ.get('MFLOW_COMPRESS_EVIDENCE') == '1' and len(data) >= 65536:
            subprocess.run(['/usr/bin/ditto', '--hfsCompression', str(temporary), str(compressed)], check=True, capture_output=True)
            if hashlib.sha256(compressed.read_bytes()).digest() != hashlib.sha256(data).digest():
                raise ValueError('Evidence compression checksum mismatch')
            os.replace(compressed, temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
        compressed.unlink(missing_ok=True)
