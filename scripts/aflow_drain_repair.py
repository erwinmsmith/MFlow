"""Resume a frozen AFlow adapter with only the recorded concurrent-drain fix."""
import ast
import hashlib
import json
import os
from pathlib import Path
import sys

receipt=json.loads(Path(os.environ['MFLOW_AFLOW_DRAIN_REPAIR']).read_text())
original=Path(receipt['original'])
if original.name!='automation_aflow.py':raise ValueError('Unexpected AFlow repair target')
for field in ('original','replacement'):
    if hashlib.sha256(Path(receipt[field]).read_bytes()).hexdigest()!=receipt[field+'Sha256']:
        raise ValueError('AFlow drain repair checksum mismatch')
sys.path.insert(0,str(original.parent))
import automation_aflow
definition=next(n for n in ast.parse(Path(receipt['replacement']).read_text()).body
                if isinstance(n,ast.AsyncFunctionDef) and n.name=='evaluate_static')
exec(compile(ast.Module(body=[definition],type_ignores=[]),receipt['replacement'],'exec'),automation_aflow.__dict__)
automation_aflow.main()
