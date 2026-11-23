import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  taskHashes,
  hashOfCacheFile,
  partitionCacheFiles,
  pruneTurboCache,
} from './prune-turbo-cache.mjs';

/** Builds a throwaway .turbo dir with the given cache files and run summaries. */
function makeTurboDir({ cacheFiles = [], summaries = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'prune-turbo-cache-'));
  mkdirSync(join(dir, 'cache'));
  for (const name of cacheFiles) writeFileSync(join(dir, 'cache', name), 'x');
  if (summaries.length > 0) {
    mkdirSync(join(dir, 'runs'));
    summaries.forEach((s, i) => writeFileSync(join(dir, 'runs', `run${i}.json`), JSON.stringify(s)));
  }
  return dir;
}

// The three files turbo 2.9 writes per cached task.
const cacheFilesFor = (...hashes) =>
  hashes.flatMap((h) => [`${h}.tar.zst`, `${h}-meta.json`, `${h}-manifest.json`]);

test('taskHashes reads the hash of every task', () => {
  assert.deepEqual(taskHashes({ tasks: [{ hash: 'aaa' }, { hash: 'bbb' }] }), ['aaa', 'bbb']);
});

test('taskHashes returns nothing for a summary without tasks', () => {
  assert.deepEqual(taskHashes({}), []);
  assert.deepEqual(taskHashes({ tasks: [{ taskId: 'web#build' }] }), []);
});

test('hashOfCacheFile strips every turbo cache file suffix', () => {
  assert.equal(hashOfCacheFile('c078f060d75aa84f.tar.zst'), 'c078f060d75aa84f');
  assert.equal(hashOfCacheFile('c078f060d75aa84f-meta.json'), 'c078f060d75aa84f');
  assert.equal(hashOfCacheFile('c078f060d75aa84f-manifest.json'), 'c078f060d75aa84f');
});

test('partitionCacheFiles keeps only files of a kept hash', () => {
  const { keep, remove } = partitionCacheFiles(cacheFilesFor('aaa', 'bbb'), new Set(['aaa']));
  assert.deepEqual(keep, cacheFilesFor('aaa'));
  assert.deepEqual(remove, cacheFilesFor('bbb'));
});

test('pruneTurboCache removes stale entries, keeps every run\'s own, and drops the summaries', () => {
  const dir = makeTurboDir({
    cacheFiles: cacheFilesFor('aaa', 'bbb', 'stale1', 'stale2'),
    summaries: [{ tasks: [{ hash: 'aaa' }] }, { tasks: [{ hash: 'bbb' }, { hash: 'nocache' }] }],
  });
  try {
    const result = pruneTurboCache(dir);
    assert.deepEqual(readdirSync(join(dir, 'cache')).sort(), cacheFilesFor('aaa', 'bbb').sort());
    assert.deepEqual(result, { taskHashes: 3, kept: 6, removed: 6 });
    assert.equal(existsSync(join(dir, 'runs')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneTurboCache fails and deletes nothing when there is no run summary', () => {
  const dir = makeTurboDir({ cacheFiles: cacheFilesFor('aaa') });
  try {
    assert.throws(() => pruneTurboCache(dir), /no turbo run summary/);
    assert.deepEqual(readdirSync(join(dir, 'cache')).sort(), cacheFilesFor('aaa').sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneTurboCache fails and deletes nothing when the summaries name no task hashes', () => {
  const dir = makeTurboDir({ cacheFiles: cacheFilesFor('aaa'), summaries: [{ tasks: [] }] });
  try {
    assert.throws(() => pruneTurboCache(dir), /no task hashes/);
    assert.deepEqual(readdirSync(join(dir, 'cache')).sort(), cacheFilesFor('aaa').sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
