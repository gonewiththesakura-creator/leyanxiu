import assert from "node:assert/strict";
import test from "node:test";

const { validateTasksOssKey } = await import("../tasks-store.js");

test("task ledger OSS key keeps the legacy default and accepts isolated prefixes", () => {
  assert.equal(validateTasksOssKey("server/tasks.json"), "server/tasks.json");
  assert.equal(validateTasksOssKey("server/stage/tasks.json"), "server/stage/tasks.json");
  assert.equal(validateTasksOssKey("services/leyanxiu-stage/tasks.v2.json"), "services/leyanxiu-stage/tasks.v2.json");
});

test("task ledger OSS key rejects unsafe or ambiguous paths", () => {
  for (const value of [
    "",
    "   ",
    "/server/tasks.json",
    "server/tasks.json/",
    "server\\tasks.json",
    "server/../tasks.json",
    "server/./tasks.json",
    "server//tasks.json",
    "server/tasks..json",
    "server/tasks json",
    "server/tasks.json?x=1",
    "server/tasks.json#fragment",
  ]) {
    assert.throws(() => validateTasksOssKey(value), /TASKS_OSS_KEY|invalid path segment/);
  }
});
