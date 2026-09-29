import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('AFlow test recovery propagates outages past native answer retries without changing model-limit handling',()=>{
  const output=execFileSync('python3',['-c',`
import runpy,urllib.error
m=runpy.run_path('scripts/resume_aflow_test.py')
class TransportFailure(RuntimeError):pass
calls=[]
def failed(error):
 def call():
  calls.append(1)
  raise error
 return call
for error in [urllib.error.URLError('offline'), TimeoutError('offline'), TransportFailure('fetch failed'), TransportFailure('')]:
 try:m['guard_transport'](failed(error),TransportFailure)()
 except m['InfrastructureUnavailable']:pass
 except Exception:raise AssertionError('Native retry would swallow infrastructure failure')
 else:raise AssertionError('Missing interruption')
assert len(calls)==4
try:m['guard_transport'](failed(TransportFailure('Provider context/output ceiling reached; response is incomplete')),TransportFailure)()
except TransportFailure:pass
else:raise AssertionError('Changed model-limit semantics')
assert m['guard_transport'](lambda:'complete but wrong',TransportFailure)()=='complete but wrong'
print('OK')
`],{encoding:'utf8'});
  assert.equal(output.trim(),'OK');
});
