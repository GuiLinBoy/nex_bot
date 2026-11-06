import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Runs only an owned, windowless AppKit process. The real quit scheduling and
// delegate are compiled with a synthetic executor; no installer or user data is used.
test("updater quit lets AppKit finish asynchronous executor shutdown", {
  skip: process.platform !== "darwin", timeout: 120_000,
}, async (t) => {
  const updater = readFileSync(new URL("../NexBotMac/AppUpdater.swift", import.meta.url), "utf8");
  const application = readFileSync(new URL("../NexBotMac/NexBotMacApp.swift", import.meta.url), "utf8");
  const quit = updater.match(/try helper\.run\(\)\r?\n([\s\S]*?)\r?\n    }/)?.[1];
  const start = application.indexOf("final class ExecutorAppDelegate:");
  const end = application.indexOf("\n@main", start);
  assert.ok(quit && start >= 0 && end > start, "real updater and termination delegate must be present");
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-updater-quit-test-"));
  try {
    const source = `import AppKit
import Foundation
func record(_ text: String) { FileHandle.standardOutput.write(Data((text + "\\n").utf8)) }
@MainActor final class LocalDeviceController {
    static let shared = LocalDeviceController()
    var isRunning: Bool { ProcessInfo.processInfo.arguments.last != "idle" }
    func shutdown() async {
        record("shutdown-started")
        try? await Task.sleep(for: .milliseconds(ProcessInfo.processInfo.arguments.last == "normal" ? 80 : 60_000))
        record("shutdown-completed")
    }
}
${application.slice(start, end)}
@main struct QuitProbe {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let delegate = ExecutorAppDelegate()
        app.delegate = delegate
        DispatchQueue.global().asyncAfter(deadline: .now() + 14) { record("watchdog-timeout"); exit(70) }
        DispatchQueue.main.async {
            Task { @MainActor in
                await Task.yield()
                ${quit}
            }
        }
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
`;
    const input = path.join(dir, "probe.swift"), binary = path.join(dir, "quit-probe");
    writeFileSync(input, source);
    const compile = spawnSync("xcrun", ["swiftc", "-parse-as-library", "-swift-version", "6", input, "-o", binary], { encoding: "utf8", timeout: 60_000 });
    assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
    for (const mode of ["idle", "normal", "stuck"]) {
      await t.test(mode, () => {
        const started = Date.now();
        const result = spawnSync(binary, [mode], {
          encoding: "utf8", timeout: 20_000,
          env: { ...process.env, HOME: dir, CFFIXED_USER_HOME: dir },
        });
        assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
        assert.doesNotMatch(result.stdout, /watchdog-timeout/);
        if (mode === "idle") assert.doesNotMatch(result.stdout, /shutdown-started/);
        else {
          assert.match(result.stdout, /shutdown-started/);
          if (mode === "normal") assert.match(result.stdout, /shutdown-completed/);
          else {
            assert.doesNotMatch(result.stdout, /shutdown-completed/);
            assert.ok(Date.now() - started >= 9_000, "stuck shutdown should wait for the bounded fallback");
          }
        }
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
