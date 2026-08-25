import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  UPSTREAM_BUILD,
  stripJsonComments,
  parseTurboConfig,
  getDevDependsOn,
  devDependsOnUpstreamBuild,
} from './check-turbo-dev-build-dep.mjs';

const QUOTE = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);

test('stripJsonComments removes a full-line // comment', () => {
  const source = ['{', '  // explanatory note', '  "a": 1', '}'].join('\n');
  assert.deepEqual(JSON.parse(stripJsonComments(source)), { a: 1 });
});

test('stripJsonComments removes a trailing // comment', () => {
  const source = ['{', '  "a": 1 // why a is 1', '}'].join('\n');
  assert.deepEqual(JSON.parse(stripJsonComments(source)), { a: 1 });
});

test('stripJsonComments removes block comments', () => {
  const source = ['{', '  /* multi', '     line */', '  "a": 1', '}'].join('\n');
  assert.deepEqual(JSON.parse(stripJsonComments(source)), { a: 1 });
});

// turbo.json's very first line is a "$schema": "https://turbo.build/schema.json"
// entry — a naive stripper would treat that "//" as the start of a comment and
// swallow the rest of the line, corrupting the parse.
test('stripJsonComments leaves a // inside a string literal intact', () => {
  const source = '{ "$schema": "https://turbo.build/schema.json" }';
  assert.deepEqual(parseTurboConfig(source), { $schema: 'https://turbo.build/schema.json' });
});

test('stripJsonComments consumes backslash escapes so an escaped quote cannot end the string', () => {
  // JSON source for the value: a" // b   (an escaped quote, then a literal "//")
  const source = `{ "a": ${QUOTE}x${BACKSLASH}${QUOTE} // y${QUOTE} }`;
  assert.deepEqual(JSON.parse(stripJsonComments(source)), { a: 'x" // y' });
});

test('stripJsonComments preserves newlines so parse errors keep their line numbers', () => {
  const source = ['// one', '// two', '{}'].join('\n');
  assert.equal(stripJsonComments(source), ['', '', '{}'].join('\n'));
});

test('getDevDependsOn returns the dev task dependsOn array', () => {
  const config = { tasks: { dev: { dependsOn: ['db:generate', '^build'] } } };
  assert.deepEqual(getDevDependsOn(config), ['db:generate', '^build']);
});

test('getDevDependsOn returns null when there is no dev task', () => {
  assert.equal(getDevDependsOn({ tasks: { build: {} } }), null);
});

test('getDevDependsOn returns null when dev has no dependsOn array', () => {
  assert.equal(getDevDependsOn({ tasks: { dev: { persistent: true } } }), null);
});

test('getDevDependsOn returns null for an empty or malformed config', () => {
  assert.equal(getDevDependsOn({}), null);
  assert.equal(getDevDependsOn(null), null);
});

test('devDependsOnUpstreamBuild is true when ^build is present', () => {
  const config = { tasks: { dev: { dependsOn: ['db:generate', UPSTREAM_BUILD] } } };
  assert.equal(devDependsOnUpstreamBuild(config), true);
});

// The exact regression this guard exists for (#944): dev listing only db:generate
// leaves packages/*/dist unbuilt, so the dev servers serve whatever compiled output
// is already on disk — arbitrarily stale, with no signal to the developer.
test('devDependsOnUpstreamBuild is false when dev depends only on db:generate', () => {
  const config = { tasks: { dev: { dependsOn: ['db:generate'] } } };
  assert.equal(devDependsOnUpstreamBuild(config), false);
});

test('devDependsOnUpstreamBuild is false when dependsOn is absent entirely', () => {
  assert.equal(devDependsOnUpstreamBuild({ tasks: { dev: {} } }), false);
});

// A plain "build" is NOT the same as "^build": it would run the app's own build
// (next build / nest build) rather than its workspace dependencies' builds, leaving
// packages/*/dist exactly as stale as before.
test('devDependsOnUpstreamBuild rejects a non-topological "build" dependency', () => {
  const config = { tasks: { dev: { dependsOn: ['db:generate', 'build'] } } };
  assert.equal(devDependsOnUpstreamBuild(config), false);
});

test('the repo turbo.json parses and its dev task depends on ^build', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = parseTurboConfig(readFileSync(resolve(root, 'turbo.json'), 'utf8'));
  assert.equal(devDependsOnUpstreamBuild(config), true);
});
