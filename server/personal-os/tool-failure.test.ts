import { expect, it } from "vitest";
import { ToolFailureGuard } from "./tool-failure.ts";
import { toolArgumentError } from "./tool-fields.ts";

const error = [{ type: "text", text: "工具参数类型无效" }];
it("recognizes the same failed arguments independent of property order", () => {
  const guard = new ToolFailureGuard();
  guard.observe("broker", { action: "device.exec", deviceId: null, command: null }, true, error);
  guard.observe("broker", { command: null, action: "device.exec", deviceId: null }, true, error);
  expect(guard.reason()).toBeUndefined();
  guard.observe("broker", { deviceId: null, command: null, action: "device.exec" }, true, error);
  expect(guard.reason()).toContain("device.exec");
  expect(guard.reason()).toContain("连续失败 3 次");
});

it("allows corrections, different results and arbitrarily long successful polling", () => {
  const guard = new ToolFailureGuard();
  for (let i = 0; i < 40; i++) {
    guard.observe("broker", { action: "device.read", path: `file-${i}` }, true, error);
    expect(guard.reason()).toBeUndefined();
  }
  for (let i = 0; i < 40; i++) {
    guard.observe("broker", { action: "device.agent", operation: "status" }, false, [{ status: "running" }]);
    expect(guard.reason()).toBeUndefined();
  }
  guard.observe("broker", { action: "device.exec" }, true, error);
  guard.observe("broker", { action: "device.exec" }, true, error);
  guard.observe("broker", { action: "device.exec" }, true, [{ text: "不同错误" }]);
  expect(guard.reason()).toBeUndefined();
});

it("resets after progress and on a new user input without revealing private arguments", () => {
  const guard = new ToolFailureGuard();
  const args = { action: "device.exec", command: "synthetic-private-command" };
  guard.observe("broker", args, true, error); guard.observe("broker", args, true, error);
  guard.observe("broker", args, false, []);
  guard.observe("broker", args, true, error);
  expect(guard.reason()).toBeUndefined();
  guard.observe("broker", args, true, error); guard.observe("broker", args, true, error);
  expect(guard.reason()).not.toContain("synthetic-private");
  guard.reset();
  expect(guard.reason()).toBeUndefined();
});

it("identifies invalid field types and nulls without echoing their values", () => {
  const message = toolArgumentError({ action: "device.exec", deviceId: null, command: { secret: "synthetic-private-key" } });
  expect(message).toContain("deviceId 需要 string（收到 null）");
  expect(message).toContain("command 需要 string（收到 object）");
  expect(message).not.toContain("synthetic-private-key");
  expect(toolArgumentError({ action: "device.exec", deviceId: "synthetic-id", command: "pwd" })).toBeUndefined();
  expect(toolArgumentError({ action: "device.exec", deviceId: null, command: null })).toContain("收到 null");
  expect(toolArgumentError({ action: "device.exec", deviceId: Number.NaN, command: Number.POSITIVE_INFINITY })).toContain("收到 NaN");
  expect(toolArgumentError({ action: "device.exec", deviceId: Number.NaN, command: Number.POSITIVE_INFINITY })).toContain("非有限 number");
  expect(toolArgumentError(null)).toContain("需要对象");
  expect(toolArgumentError({})).toContain("action");
});
