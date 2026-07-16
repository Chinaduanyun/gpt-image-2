const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCookies, isSecureRequest, setSessionCookie, clearSessionCookie } = require('../lib/auth');

test('parseCookies falls back to the raw value on malformed percent-encoding', () => {
  // A stray '%' would make decodeURIComponent throw; it must not bubble into a 500/502.
  const cookies = parseCookies({ headers: { cookie: 'imageGenToken=abc%; other=%E4%B8%AD' } });
  assert.equal(cookies.imageGenToken, 'abc%');
  assert.equal(cookies.other, '中');
});

test('isSecureRequest detects https via forwarded proto or encrypted socket', () => {
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(isSecureRequest({ headers: {}, socket: { encrypted: true } }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(isSecureRequest(undefined), false);
});

function captureSetCookie(run) {
  let value = '';
  run({ setHeader: (name, v) => { if (name === 'Set-Cookie') value = v; } });
  return value;
}

test('session cookies append Secure only over https', () => {
  const httpsSet = captureSetCookie((res) => setSessionCookie(res, 'tok', { headers: { 'x-forwarded-proto': 'https' } }));
  assert.match(httpsSet, /; Secure$/);
  assert.match(httpsSet, /HttpOnly/);

  const httpSet = captureSetCookie((res) => setSessionCookie(res, 'tok', { headers: {} }));
  assert.doesNotMatch(httpSet, /Secure/);

  const httpsClear = captureSetCookie((res) => clearSessionCookie(res, { socket: { encrypted: true } }));
  assert.match(httpsClear, /; Secure$/);
  const httpClear = captureSetCookie((res) => clearSessionCookie(res, { headers: {} }));
  assert.doesNotMatch(httpClear, /Secure/);
});
