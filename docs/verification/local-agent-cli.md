# Local Codex CLI / Claude Code on Windows and macOS

Local verification, 2026-11-06. Implemented on `codex/local-agent-cli`, based on
`97f18fd4`. No production deployment, installer publication, GitHub release or
OSS manifest update was performed. The user's existing app/profile was not used.

## Behaviour

`device.agent` uses the selected computer's desktop executor. Core remains the
orchestrator; the CLI, project, native conversation and authentication stay on
that computer. Both the Electron Windows client and native Mac client's bundled
Node executor use the same implementation. A phone can initiate the request by
selecting an online desktop from `device.inventory`.

The target CLI must already work from that computer's terminal and be signed in
or configured locally. Standard installation paths are rediscovered on demand,
including Windows npm `.cmd` launchers and macOS GUI launch paths. CLI processes
receive local config locations and network proxy/certificate settings, but not
Core/model-provider environment credentials or the parent agent's session flags.
The chosen project directory is a working directory, not an OS security sandbox.

Read the exact tool contract with `tool.search(query="device.agent")`. Example:

```json
{
  "action": "device.agent",
  "deviceId": "<inventory device ID>",
  "operation": "start",
  "parameters": {
    "agent": "codex",
    "cwd": "D:\\work\\my-project",
    "prompt": "Inspect this project's failing tests."
  }
}
```

Use `agent: "claude"` for Claude Code, and a path on the selected Mac such as
`/Users/me/work/my-project` when targeting macOS.

- `discover` detects installed CLI versions; this does not verify account access.
- `start` acknowledges a new asynchronous session. It is not proof of completion.
- `status` returns native state, incremental output and pending requests. Pass
  `after: nextCursor`; drain `hasMore` pages. `waitMs` is bounded to 10 seconds.
  `truncated` reports unread events discarded by the retention window.
- `send` adds instructions to active work or explicitly resumes the recorded
  native conversation after completion/interruption. It never silently starts a
  replacement conversation if resume fails.
- `respond` returns the complete native request and allow/deny decision. Approval
  of start/send and positive native responses uses Core's existing approval UI
  and configured approval mode. `risk=standard` cannot waive this check. Remembered
  approval is bound to exact arguments, including the native request instance.
- `stop` stops the owned process tree. Core task cancellation also stops jobs
  whose start control call has already been acknowledged. Reconnection delivers
  cancellation for recent cancelled tasks. Pause, logout and quit close the
  executor and its sessions.
- `list` is scoped to the current Bot and device/Core binding. Restart records
  interrupted work; it does not replay it.

There are at most four active sessions per device, a two-hour run deadline, 50
retained sessions, 400 retained output events per session and 40 events per page.
Individual event text is bounded to 8,000 characters. Completion comes from the
CLI's native turn/result event; a process exiting with code zero is insufficient.
Codex uses `workspace-write` with `on-request` approval; Claude Code uses its
default permission mode. Codex MCP elicitation acceptance currently requires
local handling; it can be declined or the session stopped from NexBot.

## Isolated verification

All synthetic fixtures own their temporary homes, databases, project folders,
models, devices and processes. No test mutates the installed NexBot profile or a
real project. The device fixture creates two independently paired clients with
Windows/macOS identities and checks routing for each CLI/platform combination.
Both execute on the current macOS host; this is not Windows hardware verification.

```sh
pnpm exec vitest run server/personal-os/local-agent.test.ts server/personal-os/local-agent.e2e.test.ts server/personal-os/tool-catalog.test.ts server/personal-os/approval-rules.test.ts server/personal-os/node-command.test.ts server/personal-os/risk.test.ts server/personal-os/policy-defaults.test.ts server/env-path.test.ts server/procs.test.ts

node scripts/build-personal.mjs --core
node scripts/build-client-executor.mjs
NEX_TEST_BUNDLE=dist-personal/server/core/index.js NEX_TEST_CLIENT_BUNDLE=dist-personal/client-executor/client-node/client-node.js pnpm exec vitest run server/personal-os/local-agent.e2e.test.ts server/personal-os/app.test.ts server/personal-os/client-transport.test.ts

node --test electron/nex-client-device.node-test.mjs apps/apple/Executor/executor-host.node-test.mjs
NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run src/personal/AgentDesktop.input.test.ts

node --experimental-strip-types scripts/verify-local-agent-cli.ts
node --experimental-strip-types scripts/smoke-local-agent-cli.mjs
pnpm typecheck
pnpm lint
pnpm i18n:check
```

Observed on macOS arm64 with Node 26.5.0:

- Source regression set: **68 passed, 12 skipped** across nine files.
- Source fixtures cover discovery, Unicode/quoted directories, both protocols,
  streaming, steering/queued input, exact native-session resume, approval denial,
  tampered/stale requests, Bot/binding isolation, nested Claude agent event
  isolation, process-tree cancellation,
  immediate cancellation during startup, restart without replay, bounded output,
  native errors and premature process exit. Both CLIs remain running after a
  real 21-second wait, beyond the old 20-second command deadline.
- A simulated Windows resolver check reads a CRLF npm `.cmd` shim and verifies
  direct `node.exe`/script argv with Unicode, spaces and shell metacharacters.
  Existing Windows-only process tests remain skipped on macOS.
- Built Core + built client executor: **50 passed, 1 skipped** (three files).
  After the final retention/event-isolation changes, the rebuilt artifact's
  four CLI/platform routing-and-approval cases passed again.
- Electron lifecycle and native Mac executor-host protocol: **12 passed**.
- Composer/approval UI: **15 passed**. Node 26's global Web Storage getter initially
  conflicted with Happy DOM; disabling that Node feature for this test command
  permits the fixture's isolated DOM storage. No application change was made for it.
- Installed **Codex CLI 0.167.0** and **Claude Code 2.1.318** each initialized
  successfully using fresh CLI homes. The built client executor then completed
  two native turns per CLI, resuming the same native conversation. Inference
  went only to owned loopback Responses/Messages fixtures with synthetic keys;
  this does not prove real provider availability, subscriptions or billing.
- Core/web UI and client-executor builds succeeded. TypeScript, repository lint
  and locale validation succeeded.

## Apple and remaining limits

The user explicitly approved local testing after `ssh mac-air` failed and
`mac-air.local` could not resolve. The modified NexClientKit sources were copied
to a fresh `/tmp/nex-local-agent-apple.*` directory. `swift build` passed, including
the shared macOS/iOS tool catalog, labels and presentation code. `swift test`
could not run because this machine's Command Line Tools installation has no
`XCTest` module. Full native app builds, iOS Simulator acceptance, signatures and
installers remain unverified. Temporary Apple sources/builds were removed.

Windows implementation is shared with the tested executor and explicitly handles
Windows launchers/process cleanup through the repository's existing process
adapter. A real Windows machine and Windows installer were not available in this
session; Windows hardware verification remains required before release.

Production and public downloads are unchanged. Shipping still requires the full
main/push/build/package/publication chain in the root AGENTS.md.

Protocol references: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[Claude Code programmatic use](https://code.claude.com/docs/en/headless),
[Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).
Claude's stdio permission control packet was also checked against the official
`@anthropic-ai/claude-agent-sdk` 0.3.318 distribution; no SDK dependency is bundled.
