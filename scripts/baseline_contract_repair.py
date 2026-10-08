"""Load a checksum-recorded application format repair into a frozen baseline run."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

receipt = json.loads(Path(os.environ['MFLOW_BASELINE_CONTRACT_REPAIR']).read_text())
original = Path(receipt['original'])
if original.name != 'repairs.py' or original.parent.name != 'baselines':
    raise ValueError('Unexpected baseline contract repair target')
for field in ('original', 'replacement'):
    if hashlib.sha256(Path(receipt[field]).read_bytes()).hexdigest() != receipt[field + 'Sha256']:
        raise ValueError('Baseline contract repair checksum mismatch')
sys.path.insert(0, str(original.parent))
spec = importlib.util.spec_from_file_location('repairs', receipt['replacement'])
module = importlib.util.module_from_spec(spec)
sys.modules['repairs'] = module
spec.loader.exec_module(module)
import automation_run
if __name__ == '__main__':
    automation_run.main()
