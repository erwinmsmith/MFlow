// Update future requests in a running Node application without stopping its work.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const [pidText, cwd, modulePath, expectedSha] = process.argv.slice(2);
if (!/^\d+$/.test(pidText ?? '') || !cwd || !modulePath || !/^[a-f0-9]{64}$/.test(expectedSha ?? ''))
  throw Error('Usage: node scripts/install_generation_guidance.mjs PID EXPECTED_CWD MODULE SHA256');
const pid = Number(pidText), source = realpathSync(modulePath);
if (createHash('sha256').update(readFileSync(source)).digest('hex') !== expectedSha) throw Error('Repair checksum mismatch');
const list = async () => {
  try { return await (await fetch('http://127.0.0.1:9229/json/list', {signal:AbortSignal.timeout(1000)})).json(); }
  catch { return []; }
};
let targets = await list(), opened = false;
if (!targets.length) {
  process.kill(pid, 'SIGUSR1'); opened = true;
  for (let i=0; i<50 && !targets.length; i++) { await delay(100); targets=await list(); }
}
if (targets.length !== 1) throw Error('Expected one local inspector; no repair applied');
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
let sequence = 0;
await new Promise((resolve,reject) => {socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
function evaluate(expression) {
  return new Promise((resolve,reject) => {
    const id=++sequence;
    const timer=setTimeout(()=>{socket.removeEventListener('message',receive);reject(Error('Inspector request timed out'));},10000);
    const receive=event=>{
      const reply=JSON.parse(event.data);if(reply.id!==id)return;
      clearTimeout(timer);socket.removeEventListener('message',receive);
      if(reply.error || reply.result?.exceptionDetails)reject(Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails)));
      else resolve(reply.result.result.value);
    };
    socket.addEventListener('message',receive);
    socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  });
}
let verified = false;
try {
  const identity=await evaluate('({pid:process.pid,cwd:process.cwd()})');
  if(identity.pid!==pid || realpathSync(identity.cwd)!==realpathSync(cwd)) throw Error('Inspector target mismatch; no repair applied');
  verified=true;
  const state=await evaluate(`(()=>{
    const fs=process.getBuiltinModule('fs'),crypto=process.getBuiltinModule('crypto');
    if(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(source)})).digest('hex')!==${JSON.stringify(expectedSha)})throw Error('Repair changed');
    return process.getBuiltinModule('module').createRequire(${JSON.stringify(source)})(${JSON.stringify(source)}).installGenerationGuidance();
  })()`);
  console.log(JSON.stringify({pid,cwd:identity.cwd,module:source,sha256:expectedSha,state}));
} finally {
  if(opened && verified) await evaluate("setTimeout(()=>process.getBuiltinModule('inspector').close(),250);true");
  socket.close();
  if(opened && verified) await delay(350);
}
