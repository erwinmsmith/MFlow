import test from 'node:test';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

test('AutoAgents invalid role serialization exits after local repairs instead of looping forever', async t => {
  const python = resolve('../MFlow-baselines/.venv-legacy/bin/python');
  try { await access(python); } catch { t.skip('Native legacy environment required'); return; }
  await promisify(execFile)(python, ['-c', `
import asyncio,sys,types
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path('baselines').resolve()))
import autoagents_adapter
autoagents_adapter.SCOPE.set(('AutoAgents','test','fixture'))
with patch.object(autoagents_adapter,'call',return_value='## Selected Roles List\\ninvalid JSON'),patch.object(autoagents_adapter,'save_row'):
 agent=autoagents_adapter.AutoAgents()
 from autoagents.environment import Environment
 info=types.SimpleNamespace(dict=lambda:{'Selected Roles List':'invalid JSON'})
 message=types.SimpleNamespace(role='Manager',instruct_content=info)
 try:asyncio.run(Environment.publish_message(types.SimpleNamespace(),message))
 except ValueError as error:assert 'three repairs' in str(error)
 else:raise AssertionError('Invalid format loop did not terminate')
 assert autoagents_adapter.call.call_count==3
`], {timeout:30000,maxBuffer:1024*1024});
});
