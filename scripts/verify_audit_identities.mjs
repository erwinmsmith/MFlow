// Offline verification against the same public application digest used by pass manifests.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../dist/src/util.js';
if (!process.argv[2]) throw new Error('Usage: node scripts/verify_audit_identities.mjs <private-spec.json>');
const specs=JSON.parse(readFileSync(process.argv[2],'utf8'));
const result=[];
for(const spec of specs){
 if(!spec.search || !existsSync(spec.search))continue;
 for(const name of readdirSync(spec.search).filter(n=>/^round-\d+$/.test(n))){
  const round=Number(name.slice(6));const f=join(spec.search,'round-candidates',`round-${round}.json`);
  if(!existsSync(f))continue;
  const strategy=JSON.parse(readFileSync(f,'utf8')).strategy;
  const hashes=readdirSync(join(spec.search,name)).filter(n=>/^pass-\d+$/.test(n)).flatMap(n=>{const p=join(spec.search,name,n,'manifest.json');return existsSync(p)?[JSON.parse(readFileSync(p,'utf8')).strategyHash]:[]});
  result.push({lineage:spec.id,round,bundleStrategyHash:digest(strategy),passManifests:hashes.length,allPassHashesMatch:hashes.length > 0 && hashes.every(h=>h===digest(strategy))});
 }
}
console.log(JSON.stringify(result,null,2));
