"""Apply a recorded episode I/O fix without changing a frozen framework or prompts."""
import ast
import hashlib
import json
import os
from pathlib import Path
import sys

receipt=json.loads(Path(os.environ['MFLOW_LEGACY_IO_REPAIR']).read_text())
original=Path(receipt['original'])
if original.name!='automation_run.py':raise ValueError('Unexpected legacy repair target')
for field in ('original','replacement'):
    if hashlib.sha256(Path(receipt[field]).read_bytes()).hexdigest()!=receipt[field+'Sha256']:
        raise ValueError('Legacy I/O repair checksum mismatch')
sys.path.insert(0,str(original.parent))
import automation_run
definition=next(n for n in ast.parse(Path(receipt['replacement']).read_text()).body
                if isinstance(n,ast.FunctionDef) and n.name=='episode')
exec(compile(ast.Module(body=[definition],type_ignores=[]),receipt['replacement'],'exec'),automation_run.__dict__)
if __name__=='__main__':automation_run.main()
