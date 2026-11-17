import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

test("close waits for an admitted open response before sending close to the real child", {
  timeout: 10_000,
}, async (t) => {
  const fixture = createCodexIntegrationFixture();
  const held = Promise.withResolvers();
  const fork = childProcess.fork;
  let closeSent = false;
  let release = () => {};
  t.mock.method(childProcess, "fork", (...args) => {
    const child = fork(...args);
    const requests = new Map();
    const send = child.send.bind(child);
    child.send = (message, ...rest) => {
      requests.set(message.id, message.type);
      if (message.type === "close") closeSent = true;
      return send(message, ...rest);
    };
    const emit = child.emit.bind(child);
    child.emit = (name, message, ...rest) => {
      if (name === "message" && message?.type === "response" && requests.get(message.id) === "open") {
        release = () => emit(name, message, ...rest);
        held.resolve();
        return true;
      }
      return emit(name, message, ...rest);
    };
    return child;
  });
  syncBuiltinESMExports();
  const executor = createUsageExecutor(fixture.serverOptions);
  const opened = executor.open();
  void opened.catch(() => {});
  const closing = executor.close();
  try {
    await held.promise;
    assert.equal(closeSent, false, "dispatch is not completion: close must wait for the open response");
    release();
    await opened;
    await closing;
    assert.equal(closeSent, true);
    assert.equal(executor.alive, false);
  } finally {
    release();
    await closing;
    fixture.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
