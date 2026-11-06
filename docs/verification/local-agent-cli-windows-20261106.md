# Local Agent CLI: Windows verification, 2026-11-06

Base commit: `e21ede2e1eac134a3bb6c088372a35a0a6ccc56b`, branch
`codex/local-agent-cli`. **The follow-up Windows fixes passed local verification.**
Results below distinguish the corrections accompanying this record from the
original commit. The corrections are committed on `codex/local-agent-cli` for
macOS follow-up verification; they have not been merged, deployed or published.

Environment: Windows 11 Home China x64, Node 24.13.0, Vitest 4.1.10,
Codex CLI 0.164.0 and Claude Code 2.1.310. The prepared Windows shell uses
Electron 39.8.10 / Node 22.22.1.

All account, Core, device, project and CLI inference checks used disposable
fixtures. Installed CLIs used fresh homes/configuration; inference was directed
to synthetic loopback Responses/Messages endpoints. The installed NexBot profile,
real projects, CLI sign-ins and production service were not used.

## Follow-up fixes and Windows verification

The corrected working tree changes:

- `LocalAgentSessions.finish` keeps stdin open while stopping the process tree,
  so an npm launcher cannot disappear on EOF before `taskkill /T` finds its
  descendants. It uses the shared bounded five-second stop deadline instead of
  one second. A direct diagnostic measured real Codex tree termination at about
  0.9 seconds even without load, making a one-second deadline unreliable.
- The installed-CLI initialize probe follows the same stop ordering/deadline.
- The nested Claude test reads a fresh snapshot after receiving parent output,
  rather than asserting against an earlier pre-initialization snapshot.
- The shell fixture verifies the current child's readiness PID and uses the
  debugging endpoint announced on that child's stderr. It waits for a page
  target instead of trusting a stale `DevToolsActivePort` file after restart.
  Startup failure reporting also tolerates an instance without `evaluate`.
- Native CLI smoke checks now consume each turn's incremental output separately
  and await owned-process termination before accepting completion. Both CLI
  scripts use asynchronous, bounded fixture cleanup so transient Windows file
  locks cannot mask the original test failure.

Final results on the same Windows host and installed CLI versions:

| Check | Corrected working-tree result |
| --- | --- |
| Source regression plus Windows stop-event and real process-tree suites | **77 passed, 14 skipped; 11 files passed** |
| Built Core + built client executor routing, application, transport and composer | **65 passed, 1 skipped; 4 files passed** |
| Electron lifecycle and executor-host protocol | **12 passed** |
| Nested Claude regression, independent runs without retries | **3/3 passed** |
| Installed Codex and Claude initialize/stop contract | Both initialized and confirmed stopped |
| Installed Codex and Claude, built executor under Node 24.13.0 | Both completed two turns, resumed the same native conversation and stopped |
| Same installed-CLI smoke under Electron 39.8.10 / Node 22.22.1 | Both completed two turns, resumed the same native conversation and stopped |
| Development Electron shell login, restart, pause/resume, logout and account isolation | **31 checks passed**, including a final run against the rebuilt artifacts |
| Rebuilt Core/web UI and Windows client executor/UI | Passed |
| Frontend/server TypeScript, repository lint, locale validation and diff whitespace | Passed |

The source and artifact suites ran without retries. Platform/feature skips
remain visible in their totals; these results do not claim that skipped tests
ran. Both native smoke runs submitted exactly two synthetic Responses requests
for Codex and two synthetic Messages requests for Claude. No live account or
provider was used.

Follow-up logs are in ignored `release/verification-local-agent-win-fix/`, including
`source-tests.log`, `bundle-ui-tests.log`, `installed-cli-contract.log`,
`installed-cli-smoke.log`, `installed-cli-electron-node.log`,
`shell-login-final.log`, `nested-session-1.log` through `nested-session-3.log`,
and `artifact-hashes.json`. The source command adds `server/kill-tree.test.ts`
and `server/kill-tree-windows.test.ts` to the original regression command below.

Exact rebuilt artifact SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `dist-personal/server/core/index.js` | `e0334d9e276fc08fd2b8d0f75786bc6cdc17736ece75c871a5474e946ff5241f` |
| `dist-personal/client-executor/client-node/client-node.js` | `ae5d6e931b8a43e22e0785ae332f6f77d627e486998759a63842c518e08deab6` |

Follow-up fixtures reported no retained directories or cleanup errors, and the
process audit found no fixture CLI/shell processes. The two historical
directories whose deletion was rejected in the initial run below were not
retried. No installer or production update was shipped; GitHub and OSS
publication were skipped. macOS, Android, real-provider inference, subscriptions
and billing remain outside this Windows verification.

## Initial results before fixes

| Check | Result |
| --- | --- |
| Source CLI, routing, approval, policy, PATH and process regression set | 70 passed, 1 failed, 9 skipped across 9 files |
| Built Core + built client executor routing, application, transport and composer | 65 passed, 1 skipped across 4 files |
| Electron lifecycle and executor-host protocol | 12 passed |
| Core/web UI, Windows client executor/UI and development shell preparation | Passed |
| Frontend and server TypeScript, repository lint and locale validation | Passed |
| Installed CLI initialize-only contract | Both initialized; Codex stop confirmation failed, Claude passed |
| Installed Claude, built executor, two turns in the same native conversation | Passed under Node 24.13.0 and Electron's Node 22.22.1 |
| Installed Codex, built executor, two turns in the same native conversation | Failed under both Node runtimes |
| Development Electron shell login workflow | First 11 checks passed; restart verification blocked by fixture debugging-port failure |

The source and built routing fixtures include Core approvals, two independently
paired device identities, Unicode/quoted working directories and cancellation
of acknowledged work. Both device identities execute on this Windows host;
this run does not establish macOS hardware support. The source regression also
exercises process-tree cancellation and both CLIs remaining alive beyond the
old 20-second terminal deadline.

## Initial findings before fixes

### Codex completion/stop confirmation breaks conversation continuation

`node --experimental-strip-types scripts/smoke-local-agent-cli.mjs` fails in
the second wait, after the first native turn completed and `send` requested
continuation of that conversation:

```text
codex: interrupted: 未能确认 CLI 进程树停止，请在本机核实
```

The same error was reproduced using the actual built executor under the shell's
Electron/Node runtime. Its cleanup can additionally throw `EBUSY` for the
fixture's `.codex` directory, masking the original failure. A diagnostic copy
printed the original error before cleanup, confirming the same interrupted state.

`server/personal-os/local-agent.ts:328` allows 1,000 ms for `killCliTree`, and
line 333 changes the session to `interrupted` when confirmation fails. Three
independent initialize-only Codex shutdown probes all returned `stopped: false`
after approximately 1,000 ms. The immediate npm launcher process emitted `exit`
after 35–82 ms, but `close` arrived after 8.1–9.8 seconds. The launcher PID was
gone at the end of each probe. These observations establish a Windows shutdown
confirmation/timing problem; they do not establish that every native descendant
was terminated at the time `finish` settled.

The Windows helper at `server/procs.ts:188–225` initially listens for `close`,
then conditionally listens for `exit` after successful `taskkill`. Together with
ending stdin before stopping the tree, this is a candidate for the early-exit
race. No process-helper fix was applied in this verification. Successful
synthetic-CLI tests do not substitute for this failing installed-Codex workflow.

### Nested Claude test reads a stale pre-initialization snapshot

`server/personal-os/local-agent.test.ts:110–112` saves a `running` snapshot,
waits for a newer output event, then checks the older snapshot's native session
ID. On Windows that snapshot can still have `nativeSessionId: null`: the
executor reports `running` after sending the initial user packet, before
Claude's native init event has necessarily arrived.

The initial regression run failed on this assertion. A targeted run with
`--retry=2` passed after one retry, reproducing its timing dependence. The test
needs to wait for/read the initialized snapshot to provide reliable evidence;
its failure alone does not establish nested output leaking into the parent.

### Desktop shell restart remains unverified

The unchanged `scripts/smoke-shell-login.mjs --account-workspaces
--expect-local-ui` passed 11 initial checks, including mandatory login,
unauthenticated device isolation, automatic authenticated device connection,
local UI with remote API, About/update bridge and model settings.

After the first quit, the second launch could not connect to the port read from
`DevToolsActivePort` (`ECONNREFUSED`). The script's error reporter then masked
that error with `instances.at(...)?.evaluate is not a function`, because the
new instance had not yet acquired that method. A diagnostic copy that retried
the debugging endpoint timed out instead. Restart, subsequent pause/resume,
logout and account switching therefore cannot be claimed as verified by this
shell run. No product changes were made to work around the fixture.

## Reproduction and evidence

The regression/build commands are listed in [the original recipe](local-agent-cli.md).
This machine's pnpm 11.25.0 tried to reinstall the existing dependency tree
before `pnpm exec`, then stopped because no TTY was available. Checks were run
directly through the already installed binaries instead:

```powershell
node node_modules/vitest/vitest.mjs run server/personal-os/local-agent.test.ts server/personal-os/local-agent.e2e.test.ts server/personal-os/tool-catalog.test.ts server/personal-os/approval-rules.test.ts server/personal-os/node-command.test.ts server/personal-os/risk.test.ts server/personal-os/policy-defaults.test.ts server/env-path.test.ts server/procs.test.ts
node scripts/build-personal.mjs --core
node scripts/build-client-executor.mjs
$env:NEX_TEST_BUNDLE = 'dist-personal/server/core/index.js'
$env:NEX_TEST_CLIENT_BUNDLE = 'dist-personal/client-executor/client-node/client-node.js'
node node_modules/vitest/vitest.mjs run server/personal-os/local-agent.e2e.test.ts server/personal-os/app.test.ts server/personal-os/client-transport.test.ts src/personal/AgentDesktop.input.test.ts
node --test electron/nex-client-device.node-test.mjs apps/apple/Executor/executor-host.node-test.mjs
node --experimental-strip-types scripts/verify-local-agent-cli.ts
node --experimental-strip-types scripts/smoke-local-agent-cli.mjs
node node_modules/typescript/bin/tsc -b
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/oxlint/bin/oxlint --deny-warnings .
node scripts/generate-locale.mjs --check
```

Windows shell preparation used `node scripts/build-personal.mjs --shell`.
GitHub's Electron asset redirect stalled, so the successful invocation used
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` for that command only.
No global configuration was changed. The generated Apple HTML resource was
restored after the build; no Apple source change is part of this record.

Logs and diagnostic copies are kept locally in the ignored directory
`release/verification-local-agent-win-e21ede2e/`. Diagnostic copies only add
error reporting, isolate the Claude case, retry fixture readiness/cleanup, or
measure owned-process shutdown; they do not modify application code.

Exact tested artifact SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `dist-personal/server/core/index.js` | `9422a5abbc2b3f99d3c574b734478b48a04f5e023aad08120a3c7796a1eb717b` |
| `dist-personal/client-executor/client-node/client-node.js` | `5aa8c6d5fbd2ef239cc3b20d88838bd490a464536817a79cf35dd3c232064dbe` |

No published installer was built or installed; GitHub and OSS publication were
skipped. Real provider access, subscriptions and billing were not tested.

Fixture cleanup normally ran in each script's `finally` block. The Electron
Codex failures left two owned directories under this user's Windows temp root:
`nex-installed-agent-JgMnXx` and `nex-installed-agent-z9E4oU`. Automatic approval
review rejected explicit cleanup with `blocked by policy`; those directories
were retained. The final process audit found no fixture CLI/shell processes
with the recorded fixture arguments, and no additional `codex.exe` processes
created during this verification remained.
