# Local Agent CLI: macOS follow-up verification, 2026-11-06

Tested commit: `76a45244d8dbd2ba242f703563fd5a45ed3226e7`, branch
`codex/local-agent-cli`. This checks the shared code and fixture changes from
the [Windows follow-up](local-agent-cli-windows-20261106.md). **The macOS
regression checks passed; no additional application-code fix was needed.**

The branch was fast-forwarded from `e21ede2e` before building. The user's
separate working checkout and its uncommitted files were preserved. All task,
account, Core, device, project and CLI inference operations used disposable
fixtures. Installed CLIs used fresh homes/configuration and synthetic loopback
inference; real CLI sign-ins and projects were not used.

## Why macOS verification was needed

The change is shared by Windows and macOS. `LocalAgentSessions.finish` now
keeps stdin open while the owned process tree is stopped, and uses the process
helper's bounded five-second deadline instead of one second. On macOS this
uses POSIX process-group signalling, so the Windows success alone could not
establish that completion, cleanup and resuming a native conversation still work.

The updated scripts also wait for confirmed process termination, consume each
turn's own incremental output, retry temporary-directory cleanup, and match
shell readiness/debugging endpoints to the current child PID. Those paths were
retested on macOS as well.

## Environment and results

Host: macOS arm64, Node **26.5.0**, Codex CLI **0.167.0**, Claude Code
**2.1.318**. The development shell and its additional CLI smoke used pinned
Electron **39.8.10** / Node **22.22.1**, arm64.

| Check | Result |
| --- | --- |
| Source CLI, approval, routing, policy, PATH and process-tree regression set | **79 passed, 12 skipped; 11 files passed** |
| Built Core + built executor application, routing, transport and composer | **65 passed, 1 skipped; 4 files passed** |
| Electron device lifecycle and native Mac executor-host protocol | **12 passed** |
| Installed Codex and Claude initialize/stop contract | Both initialized and confirmed stopped |
| Installed CLIs with the built executor under Node 26.5.0 | Both completed two turns and resumed the same native conversation |
| Same installed-CLI smoke under Electron's Node 22.22.1 | Both completed two turns, resumed the same native conversation and stopped |
| Updated development-shell login, restart, device control and account-isolation fixture | **31 checks passed** |
| Core/web UI, local client executor/UI and pinned development-shell preparation | Passed |
| Frontend/server TypeScript, repository lint, locale validation and whitespace | Passed |

The source tests include real process-tree termination and both CLIs remaining
alive after a 21-second wait, beyond the old terminal deadline. The routing
fixture checks both CLI families and both advertised Windows/macOS device
identities; all executions in this record occurred on the macOS host.

The native CLI smokes used the actual built executor. Each runtime's run sent
exactly two synthetic Responses requests for Codex and two synthetic Messages
requests for Claude. The updated smoke requires output from the continued turn
and removal of the session from the live-process map before accepting success.

The updated shell fixture passed device identity across restart, restored login,
automatic local control, pause/resume lifecycle coverage, logout/session expiry,
upstream revocation and account/workspace isolation. It used an isolated profile
and synthetic identity/Core services, and reported `packaged: false`.

No test retries or application changes were used to obtain these results. The
fixture logs reported no retained-directory or cleanup errors. Platform/feature
skips remain visible in the counts above.

## Reproduction and artifacts

```sh
pnpm exec vitest run server/personal-os/local-agent.test.ts server/personal-os/local-agent.e2e.test.ts server/personal-os/tool-catalog.test.ts server/personal-os/approval-rules.test.ts server/personal-os/node-command.test.ts server/personal-os/risk.test.ts server/personal-os/policy-defaults.test.ts server/env-path.test.ts server/procs.test.ts server/kill-tree.test.ts server/kill-tree-windows.test.ts
node scripts/build-personal.mjs --core
node scripts/build-personal.mjs --shell
NEX_TEST_BUNDLE=dist-personal/server/core/index.js NEX_TEST_CLIENT_BUNDLE=dist-personal/client-executor/client-node/client-node.js NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run server/personal-os/local-agent.e2e.test.ts server/personal-os/app.test.ts server/personal-os/client-transport.test.ts src/personal/AgentDesktop.input.test.ts
node --test electron/nex-client-device.node-test.mjs apps/apple/Executor/executor-host.node-test.mjs
node --experimental-strip-types scripts/verify-local-agent-cli.ts
node --experimental-strip-types scripts/smoke-local-agent-cli.mjs
ELECTRON_RUN_AS_NODE=1 dist-personal/electron/Electron.app/Contents/MacOS/Electron --experimental-strip-types scripts/smoke-local-agent-cli.mjs
node --experimental-strip-types scripts/smoke-shell-login.mjs --account-workspaces --expect-local-ui
pnpm typecheck
pnpm lint
pnpm i18n:check
git diff --check
```

GitHub's direct Electron release download stalled. Only that owned preparation
process was stopped; the official Electron 39.8.10 arm64 archive and
`SHASUMS256.txt` were downloaded with `gh release download` instead. The archive
was checked against the official SHA-256 list and extracted to the worktree's
`dist-personal/electron`; `build-personal.mjs --shell` then completed normally.
No global Git/network configuration or installed application was changed.

Exact checked SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `dist-personal/server/core/index.js` | `9dd68e6dab6eb42896b65e204637686d9e253fc2a1b04d26dae994ea7ff43144` |
| `dist-personal/client-executor/client-node/client-node.js` | `abd53109aba7a814862e49092edfc3446744137b7b24433b70f78b1a0a033fe0` |
| Official `electron-v39.8.10-darwin-arm64.zip` (112,032,304 bytes) | `f7e3ed2cc34dd2eba3f2a95234b576fe8082d35fb133e482102c08105f298572` |

Logs and artifact metadata are retained in ignored
`release/verification-local-agent-mac-76a45244/`: `source-tests.log`,
`bundle-ui-tests.log`, `lifecycle-tests.log`, `installed-cli-contract.log`,
`installed-cli-smoke.log`, `installed-cli-electron-node.log`, `shell-login.log`,
`static-checks.log`, `build-client.log`, `build-shell.log`,
`artifact-hashes.json` and `electron-runtime.json`.

## Scope limits

This verifies the shared Node device executor and the development Electron shell.
No Swift source changed in the Windows follow-up; full native SwiftUI app/iOS
Simulator acceptance, signatures and installers were not part of this run. Real
provider access, subscriptions and billing remain unverified.

This was local verification only. No production deployment, GitHub release,
published installer or OSS manifest update was performed. Publication was skipped.
