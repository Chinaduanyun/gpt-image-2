const { BODY_LIMIT } = require('./constants');

function isResponseWritable(res) {
  return !res.destroyed && !res.writableEnded;
}

function attachResponseErrorHandler(res) {
  res.on('error', () => {});
}

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  if (!isResponseWritable(res)) return false;
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...headers
  });
  if (!isResponseWritable(res)) return false;
  res.end(body);
  return true;
}

function sendJson(res, statusCode, body) {
  send(res, statusCode, JSON.stringify(body), 'application/json; charset=utf-8');
}

function readRequestBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        reject(new Error('请求体过大。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

function safeParseJson(buffer) {
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString('utf8'));
}

async function readJsonBody(req, limit = BODY_LIMIT) {
  return safeParseJson(await readRequestBody(req, limit));
}

module.exports = {
  isResponseWritable,
  attachResponseErrorHandler,
  send,
  sendJson,
  readRequestBody,
  safeParseJson,
  readJsonBody
};
