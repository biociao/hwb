import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { httpProbe } from '../src/control/prober.js';

test('httpProbe: considers a token redirect alive without following it', async (t) => {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/?token=test') {
      res.writeHead(302, { location: '/entry' });
      res.end();
    } else {
      res.writeHead(503);
      res.end('The entry page is busy');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal(await httpProbe(`http://127.0.0.1:${server.address().port}/?token=test`), true);
  assert.deepEqual(paths, ['/?token=test']);
});

test('httpProbe: cancels response bodies for success, redirect, and server errors', async (t) => {
  const cancelled = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return { status, body: { cancel: async () => { cancelled.push(status); } } };
  });
  for (status of [200, 302, 503]) assert.equal(await httpProbe('http://test'), status < 500);
  assert.deepEqual(cancelled, [200, 302, 503]);
});

test('httpProbe: a failed body cleanup does not discard the received HTTP status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ status: 204, body: { cancel: async () => { throw new Error('closed'); } } }));
  assert.equal(await httpProbe('http://test'), true);
});

test('httpProbe: a nonresponsive endpoint fails within the supplied timeout', async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal(await httpProbe(`http://127.0.0.1:${server.address().port}`, 20), false);
});
