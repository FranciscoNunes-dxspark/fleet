import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pasteFor, routeHandoff } from '../src/handoff.js';

test('a hand-off goes to its app, or to the first of several that runs', () => {
  assert.deepEqual(routeHandoff({ handoff: 'trawl', line: '/azure-sql srv db' }, { from: 'sonar' }), { to: 'trawl', line: '/azure-sql srv db' });
  assert.deepEqual(routeHandoff({ handoff: 'Trawl', line: 'x' }), { to: 'trawl', line: 'x' });
  const running = (id) => id === 'bosun';
  assert.deepEqual(routeHandoff({ handoff: ['sonar', 'hail', 'bosun'], line: 'family:v1:logline:e30' }, { from: 'hail', running }), { to: 'bosun', line: 'family:v1:logline:e30' });
  assert.equal(routeHandoff({ handoff: ['sonar', 'hail'], line: 'x' }, { running }).to, null);
});

test("Keel's hand-offs, and the family's to Keel, route like any app's", async () => {
  const { TAKEN_BY } = await import('@fleet/kit/family.js');
  assert.deepEqual(routeHandoff({ handoff: 'splice', line: '/take family:v1:pullrequest:e30' }, { from: 'keel' }), { to: 'splice', line: '/take family:v1:pullrequest:e30' });
  // Splice's commit is for Sonar or Keel: whichever runs.
  const others = TAKEN_BY.commit.filter((a) => a !== 'splice');
  assert.deepEqual(others, ['sonar', 'keel']);
  assert.deepEqual(routeHandoff({ handoff: others, line: 'x' }, { from: 'splice', running: (id) => id === 'keel' }), { to: 'keel', line: 'x' });
});

test("nothing to route: no line, an app the host hasn't, or the app itself", () => {
  assert.equal(routeHandoff({ handoff: 'trawl', line: '  ' }).to, null);
  assert.equal(routeHandoff({ handoff: 'notepad', line: 'x' }).to, null);
  assert.equal(routeHandoff({ handoff: 'splice', line: 'x' }, { from: 'splice' }).to, null);
  assert.equal(routeHandoff({ line: 'x' }).to, null);
  assert.equal(routeHandoff({ handoff: 'one', line: 'x' }, { ids: ['one', 'two'] }).to, 'one');
});

test('the line is typed as one paste, without line breaks that would run it', () => {
  assert.equal(pasteFor('/take abc\r\n'), '/take abc');
  assert.equal(pasteFor('a\nb'), 'a b');
});
