import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { save } from '../src/util.js';

test('parallel checkpoint saves preserve invocation order, snapshot values, and recover after write errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mflow-save-')), path = join(root, 'usage.json');
  try {
    const records: number[] = [], writes = [];
    for (let n = 0; n < 100; n++) {
      records.push(n); writes.push(save(n % 2 ? relative(process.cwd(), path) : path, records));
    }
    records.push(100);
    await Promise.all(writes);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), records.slice(0, 100));
    const blocked = join(root, 'blocked'); await writeFile(blocked, 'not a directory');
    await assert.rejects(save(join(blocked, 'usage.json'), {}));
    await rm(blocked); await save(join(blocked, 'usage.json'), { recovered: true });
    assert.deepEqual(JSON.parse(await readFile(join(blocked, 'usage.json'), 'utf8')), { recovered: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
