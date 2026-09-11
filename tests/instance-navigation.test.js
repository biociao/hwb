import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPaneNavigation, planPaneRecovery, updatePaneSession } from '../src/web/instance-navigation.js';

const entry = 'http://localhost:5555/?token=old';
const mounted = (extra = {}) => ({ url: entry, _iframed: true, _cookieReady: true, deeplink: true, sessionId: 'session-one', ...extra });

test('changing the iframe entry navigates again and authenticates before restoring the same session', () => {
  for (const nextEntry of ['http://localhost:6666/?token=old', 'http://localhost:5555/?token=new']) {
    const plan = planPaneNavigation(mounted(), nextEntry, 'session-one');
    assert.equal(plan.firstTarget, nextEntry, 'the new port or token must receive the authentication request');
    const sessionUrl = new URL(nextEntry);
    sessionUrl.searchParams.delete('token');
    sessionUrl.searchParams.set('session', 'session-one');
    assert.equal(plan.finalTarget, sessionUrl.href);
    assert.equal(plan.cookieReady, false, 'the old entry cannot authorize a new entry');
    assert.equal(plan.sessionId, 'session-one');
  }
});

test('a new entry without a requested session clears stale session navigation', () => {
  const nextEntry = 'http://localhost:6666/?token=new';
  const plan = planPaneNavigation(mounted(), nextEntry);
  assert.deepEqual(plan, { firstTarget: nextEntry, finalTarget: nextEntry, cookieReady: false, sessionId: null });
});

test('ordinary tab selection and selecting the same session retain the mounted iframe', () => {
  assert.equal(planPaneNavigation(mounted(), entry), null);
  assert.equal(planPaneNavigation(mounted(), entry, 'session-one'), null);
  assert.equal(planPaneNavigation(mounted({ deeplink: false }), entry, 'session-two'), null);
});

test('session switches reuse authentication, while the first deep link authenticates first', () => {
  const expected = 'http://localhost:5555/?session=session-two';
  const switched = planPaneNavigation(mounted(), entry, 'session-two');
  assert.equal(switched.firstTarget, expected);
  assert.equal(switched.finalTarget, expected);
  assert.equal(switched.cookieReady, true);
  const first = planPaneNavigation({ deeplink: true }, entry, 'session-two');
  assert.equal(first.firstTarget, entry);
  assert.equal(first.finalTarget, expected);
  assert.equal(first.cookieReady, false);
});

test('session URLs preserve existing query parameters and encode the session ID', () => {
  const plan = planPaneNavigation({ deeplink: true }, `${entry}&lang=zh#chat`, 'a/b?c');
  const target = new URL(plan.finalTarget);
  assert.equal(target.searchParams.has('token'), false);
  assert.equal(target.searchParams.get('lang'), 'zh');
  assert.equal(target.searchParams.get('session'), 'a/b?c');
  assert.equal(target.hash, '#chat');
});

test('background recovery adopts the new iframe entry once and preserves the latest SPA session', () => {
  const pane = mounted();
  updatePaneSession(pane, 'selected-in-dsh');
  const runtime = { runtime: 'running', url: 'http://localhost:6666/?token=new', iframeUrl: 'http://localhost:7777/?token=new', deeplink: true };
  const recovery = planPaneRecovery(pane, runtime);
  assert.deepEqual(recovery, { url: runtime.iframeUrl, externalUrl: runtime.url, deeplink: true, sessionId: 'selected-in-dsh' });
  const navigation = planPaneNavigation(pane, recovery.url, recovery.sessionId);
  assert.equal(navigation.firstTarget, runtime.iframeUrl);
  assert.equal(new URL(navigation.finalTarget).searchParams.get('session'), 'selected-in-dsh');
  pane.url = recovery.url; // mountPane adopts the entry synchronously before another status update.
  assert.equal(planPaneRecovery(pane, runtime), null);
  assert.equal(planPaneRecovery(pane, runtime), null, 'repeated SSE updates do not reload the frame');
});

test('background recovery waits for a usable connection and does not race a user-initiated open', () => {
  const runtime = { runtime: 'running', url: 'http://localhost:6666/?token=new', iframeUrl: 'http://localhost:7777/?token=new' };
  assert.equal(planPaneRecovery(null, runtime), null, 'status changes never open an unvisited instance');
  assert.equal(planPaneRecovery({ _iframed: false }, runtime), null);
  assert.equal(planPaneRecovery(mounted({ _opening: Symbol('open') }), runtime), null);
  for (const state of ['unreachable', 'stopped', 'gone']) {
    assert.equal(planPaneRecovery(mounted(), { ...runtime, runtime: state }), null);
  }
});

test('older status responses retain the preview entry until the external connection changes', () => {
  const pane = mounted({ url: 'http://localhost:7777/?token=old', externalUrl: entry });
  assert.equal(planPaneRecovery(pane, { runtime: 'running', url: entry, deeplink: true }), null);
  const nextEntry = 'http://localhost:6666/?token=new';
  const recovery = planPaneRecovery(pane, { runtime: 'running', url: nextEntry, deeplink: true });
  assert.deepEqual(recovery, { url: nextEntry, externalUrl: nextEntry, deeplink: true, sessionId: 'session-one' });
});

test('authentication context cannot erase a pending session, but selecting a new session can clear it', () => {
  const pane = mounted({ _navTarget: 'http://localhost:6666/?session=session-one' });
  assert.equal(updatePaneSession(pane, null), false);
  assert.equal(pane.sessionId, 'session-one');
  pane._navTarget = null;
  pane._opening = Symbol('open');
  assert.equal(updatePaneSession(pane, null), false);
  pane._opening = null;
  assert.equal(updatePaneSession(pane, null), true);
  const recovery = planPaneRecovery(pane, { runtime: 'running', url: 'http://localhost:6666/?token=new' });
  assert.equal(recovery.sessionId, null, 'recovery must not reopen the conversation left by the user');
});
