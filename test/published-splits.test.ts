import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('published split metadata and content verification reject drift without model calls', () => {
  execFileSync('python3', ['test/published_splits_test.py'], { stdio: 'pipe' });
});
