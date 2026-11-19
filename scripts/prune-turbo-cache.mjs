#!/usr/bin/env node
/**
 * Prunes the local turbo cache (.turbo/cache) down to the entries this CI job's
 * turbo runs used, so the archive actions/cache saves next holds only what the
 * next run can hit.
 *
 * CI restores .turbo by key prefix, turbo adds the outputs of every new task hash,
 * and the whole directory is saved under a new key. Without pruning, every old
 * hash stays in the archive forever: the e2e job's archive on main reached 459 MB
 * (one ~23 MB web build per merge that changed web) before this ran. See #1095.
 *
 * Reads every run summary turbo wrote to .turbo/runs (`turbo run --summarize`),
 * keeps the cache files whose hash one of those runs' tasks used, deletes the rest,
 * then deletes .turbo/runs so summaries aren't cached either. Fails without deleting
 * anything if it finds no summary or no task hashes: under CI's wiring that means
 * the --summarize flag was dropped or turbo changed its summary format.
 *
 * Usage: node scripts/prune-turbo-cache.mjs [turboDir]   (default: .turbo)
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

// --- Pure helpers (exported for unit testing — see prune-turbo-cache.test.mjs) ---

/** The task hashes one parsed turbo run summary used. */
export function taskHashes(summary) {
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  return tasks.map((t) => t?.hash).filter((h) => typeof h === 'string' && h.length > 0);
}

/**
 * The hash a cache file belongs to. turbo 2.9 writes `<hash>.tar.zst`,
 * `<hash>-meta.json` and `<hash>-manifest.json` per cached task, and a hash is
 * hex, so the hash is the file name up to the first `.` or `-`.
 */
export function hashOfCacheFile(name) {
  return name.split(/[.-]/)[0];
}

/** Splits cache file names into those to keep and those to remove. */
export function partitionCacheFiles(names, keepHashes) {
  const keep = [];
  const remove = [];
  for (const name of names) {
    (keepHashes.has(hashOfCacheFile(name)) ? keep : remove).push(name);
  }
  return { keep, remove };
}

// --- Side-effecting entry point ---

export function pruneTurboCache(turboDir) {
  const runsDir = join(turboDir, 'runs');
  const cacheDir = join(turboDir, 'cache');

  const summaryFiles = existsSync(runsDir)
    ? readdirSync(runsDir).filter((f) => f.endsWith('.json'))
    : [];
  if (summaryFiles.length === 0) {
    throw new Error(`no turbo run summary in ${runsDir}; run turbo with --summarize first`);
  }

  const keepHashes = new Set();
  for (const file of summaryFiles) {
    const summary = JSON.parse(readFileSync(join(runsDir, file), 'utf8'));
    for (const hash of taskHashes(summary)) keepHashes.add(hash);
  }
  if (keepHashes.size === 0) {
    throw new Error(`no task hashes in ${summaryFiles.length} run summary file(s) in ${runsDir}`);
  }

  const names = existsSync(cacheDir) ? readdirSync(cacheDir) : [];
  const { keep, remove } = partitionCacheFiles(names, keepHashes);
  for (const name of remove) rmSync(join(cacheDir, name), { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });

  return { taskHashes: keepHashes.size, kept: keep.length, removed: remove.length };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const turboDir = process.argv[2] ?? '.turbo';
  try {
    const r = pruneTurboCache(turboDir);
    console.log(
      `prune-turbo-cache: ${r.taskHashes} task hashes used; kept ${r.kept} cache files, removed ${r.removed}`,
    );
  } catch (err) {
    console.error(`prune-turbo-cache: ${err.message}`);
    process.exit(1);
  }
}
