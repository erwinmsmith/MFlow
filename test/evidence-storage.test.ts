import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save } from '../src/util.js';

test('controller outages, process groups and Python evidence writes', async () => {
  await promisify(execFile)('python3', ['test/search_transport_test.py']);
});

test('transparent evidence compression preserves concurrent checkpoint order and JSON content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mflow-evidence-'));
  const prior = process.env.MFLOW_COMPRESS_EVIDENCE;
  process.env.MFLOW_COMPRESS_EVIDENCE = '1';
  try {
    const path = join(directory, 'result.json');
    const first = { score: 0, toolEvidence: ['中文 schemas '.repeat(10000)] };
    const last = { ...first, score: 1, arguments: { active: false, count: 0 } };
    await Promise.all([save(path, first), save(path, last)]);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), last);
    assert.deepEqual(await readdir(directory), ['result.json']);
    if (process.platform === 'darwin') {
      const info = await stat(path);
      assert.ok(info.blocks * 512 < info.size / 2);
    }
  } finally {
    if (prior === undefined) delete process.env.MFLOW_COMPRESS_EVIDENCE;
    else process.env.MFLOW_COMPRESS_EVIDENCE = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
