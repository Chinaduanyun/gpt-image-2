const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { forwardApiMarketResponse } = require("../routes/api-market");
const { serveStatic } = require("../routes/static");

function disconnectedResponse() {
  return Object.assign(new EventEmitter(), {
    destroyed: true,
    writableEnded: false,
    writeHeadCalls: 0,
    endCalls: 0,
    writeHead() { this.writeHeadCalls += 1; },
    end() { this.endCalls += 1; }
  });
}

test("upstream forwarding skips a response whose client disconnected", async () => {
  const res = disconnectedResponse();

  await forwardApiMarketResponse({
    status: 200,
    text: JSON.stringify({ ok: true }),
    contentType: "application/json; charset=utf-8"
  }, res);

  assert.equal(res.writeHeadCalls, 0);
  assert.equal(res.endCalls, 0);
});

test("static file callback skips a response whose client disconnects before read completion", async () => {
  const originalReadFile = fs.readFile;
  let completeRead;
  fs.readFile = (_filePath, callback) => { completeRead = callback; };

  try {
    const res = Object.assign(disconnectedResponse(), { destroyed: false });
    serveStatic({ method: "GET" }, res, "/index.html");
    res.destroyed = true;
    completeRead(null, Buffer.from("page"));

    assert.equal(res.writeHeadCalls, 0);
    assert.equal(res.endCalls, 0);
  } finally {
    fs.readFile = originalReadFile;
  }
});
