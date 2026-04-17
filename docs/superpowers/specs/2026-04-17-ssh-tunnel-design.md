# SSH Port Forwarding — Design

Date: 2026-04-17
Branch: `improve-ssh-handling`

## Summary

Add native SSH port forwarding to the MCP server. When `SSH_HOST` is set, the server starts an SSH tunnel at startup (spawning the system `ssh` binary with `-L`), binds to a random local port, and transparently rewrites the MySQL pool to connect through the tunnel. The tunnel is torn down at shutdown. Users continue to configure `MYSQL_HOST`/`MYSQL_PORT` as the real target — the tunnel layer is invisible to the MySQL code path.

This replaces the manual workflow currently documented in `scripts/start-tunnel-rds.sh` / `scripts/stop-tunnel-rds.sh`: users no longer run a side-car shell script and manually set `MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307`.

## Goals

- One-env-var opt-in (`SSH_HOST`) that works out of the box with existing `~/.ssh/config` aliases, ProxyJump chains, hardware keys, and agent forwarding.
- Tunnel lifecycle bound to the MCP server lifecycle — no orphan ssh processes, no shared mutable local port.
- Clean failure semantics: any tunnel problem causes a fast, loud startup failure or process exit. No silent degradation.
- Zero changes to the existing MySQL code path when the tunnel is disabled.

## Non-goals

- Auto-reconnect / retry on tunnel drop. On runtime failure, the MCP process exits and the MCP client relaunches it.
- Password-based SSH auth. `BatchMode=yes` disables all interactive prompts.
- Pure-JS SSH (e.g. `ssh2` library). We shell out to the system `ssh` binary.
- Support for tunneling when `MYSQL_SOCKET_PATH` is set (socket path is local-only; tunneling is a no-op in that mode).

## Configuration

New environment variables (all optional; presence of `SSH_HOST` enables tunneling):

| Var | Purpose | Default |
|---|---|---|
| `SSH_HOST` | Bastion hostname or `~/.ssh/config` alias. Presence enables the tunnel. | — |
| `SSH_USER` | SSH user. Passed as `-l <user>`. | OpenSSH resolves from config / current user |
| `SSH_PORT` | SSH port. Passed as `-p <port>`. | OpenSSH resolves from config (usually 22) |
| `SSH_KEY` | Path to private key. Passed as `-i <path>`. Supports `~` expansion. | OpenSSH resolves via IdentityFile / agent |

Remote target is reused from `MYSQL_HOST` / `MYSQL_PORT` — users do not change their MySQL vars. The local port is chosen by the OS (bind to port 0, read back) and is not user-configurable.

### Conflict rules

- `SSH_HOST` + `MYSQL_SOCKET_PATH`: socket path wins; log a warning that the tunnel is ignored.
- `SSH_HOST` set but no `ssh` binary on PATH: startup errors with `SSH tunnel: 'ssh' command not found on PATH. Install OpenSSH client.`
- `SSH_KEY` set but file does not exist: startup errors with `SSH key not found: <path>`.

### Parity with existing scripts

The current `scripts/start-tunnel-rds.sh` uses the same `-L localPort:remoteHost:remotePort -p sshPort -i key user@host` shape. Users migrating from the scripts map env vars as:

| Script env var | New env var |
|---|---|
| `BASTION_HOST` | `SSH_HOST` |
| `BASTION_USER` | `SSH_USER` |
| `BASTION_PORT` | `SSH_PORT` |
| `SSH_KEY` | `SSH_KEY` (unchanged) |
| `RDS_ENDPOINT` | `MYSQL_HOST` (unchanged — reused) |
| `RDS_PORT` | `MYSQL_PORT` (unchanged — reused) |
| `LOCAL_PORT` | — (auto-generated) |

## Architecture

New module `src/ssh/tunnel.ts` owns the `ssh` child-process lifecycle and exposes the chosen local port. It has no knowledge of MySQL; `src/db/` has no knowledge of SSH.

```ts
// src/ssh/tunnel.ts
export interface TunnelConfig {
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  sshKey?: string;
  remoteHost: string;   // from MYSQL_HOST
  remotePort: number;   // from MYSQL_PORT
}

export interface TunnelOptions {
  // Test-only seams; production callers leave these at defaults.
  spawnPath?: string;         // default: 'ssh'
  readinessTimeoutMs?: number; // default: 10_000
  onRuntimeExit?: (code: number | null, stderrTail: string) => void; // default: log + safeExit(1)
}

export interface ActiveTunnel {
  localPort: number;
  close(): Promise<void>;
}

export async function startTunnel(
  cfg: TunnelConfig,
  opts?: TunnelOptions,
): Promise<ActiveTunnel>;
```

`TunnelOptions` are deliberately separate from `TunnelConfig` so production env-var parsing cannot accidentally populate them.

### Wiring

1. **`src/config/index.ts`** parses the new `SSH_*` vars into an optional `sshTunnelConfig` export. It does **not** resolve the local port — that happens at startup. The existing `mcpConfig.mysql.host` / `.port` remain as the user configured them.
2. **`index.ts`** startup sequence:
   - Read config.
   - If `sshTunnelConfig` present (and no `MYSQL_SOCKET_PATH`): `const tunnel = await startTunnel(sshTunnelConfig)`.
   - Override the mysql pool's `host` → `127.0.0.1`, `port` → `tunnel.localPort` **before** the first `getPool()` call.
   - Register `tunnel.close()` in the existing `shutdown()` handler, invoked **after** `pool.end()`.
3. **`src/db/index.ts`** is untouched — it reads pool config as it does today.

### Local port selection

`net.createServer().listen(0)` → read `.address().port` → close the server → pass that number to `ssh -L <port>:...`. There is a tiny race window between close and ssh binding, but `ExitOnForwardFailure=yes` (see below) turns any collision into a clean startup failure rather than a hang.

## Lifecycle

### Startup

Inside `createMcpServer` before `getPool()`:

1. If `SSH_HOST` set and no socket path → call `startTunnel(cfg)`.
2. Inside `startTunnel`:
   - Pick a free local port.
   - Build the ssh argv (see below).
   - Spawn `ssh` with `stdio: ['ignore', 'pipe', 'pipe']`.
   - Wait for readiness: TCP-connect to `127.0.0.1:<localPort>` in a retry loop (50ms interval, 10s total timeout).
   - If `ssh` exits during the wait → reject with stderr tail.
   - Once ready → attach a permanent `exit` listener that logs stderr and calls `safeExit(1)`.
   - Return `{ localPort, close }`.
3. Override `mcpConfig.mysql.host`/`port`; continue normal startup.

### SSH argv

```
ssh
  -N                                       # no remote command
  -T                                       # no PTY
  -o ExitOnForwardFailure=yes              # fast-fail on bind error
  -o ServerAliveInterval=30                # dead peer detection
  -o ServerAliveCountMax=3
  -o BatchMode=yes                         # never prompt — fail instead
  -o StrictHostKeyChecking=accept-new      # don't block on unknown hosts
  -L <localPort>:<MYSQL_HOST>:<MYSQL_PORT>
  [-l <SSH_USER>]                          # only if set
  [-p <SSH_PORT>]                          # only if set
  [-i <SSH_KEY>]                           # only if set, with ~ expansion
  <SSH_HOST>
```

`BatchMode=yes` is important: without it, `ssh` can silently block on a password/passphrase prompt and the readiness check just times out with no useful error. With it, missing auth fails fast and stderr tells the user why.

### Shutdown

- `shutdown(signal)` in `index.ts` (already exists at lines 363-375) is extended to call `await tunnel?.close()` **after** `pool.end()` — the pool closes first so MySQL connections issue a clean `COM_QUIT` through the still-live tunnel, then the tunnel is torn down.
- `tunnel.close()`:
  - Removes the permanent `exit` listener (so closing the tunnel does not trigger `safeExit`).
  - Sends `SIGTERM` to the ssh child.
  - Awaits exit with a 3s timeout.
  - Sends `SIGKILL` on timeout.

### Logging

ssh stderr is piped through `log("info", "[ssh] ...")` line-buffered, so tunnel messages appear in the MCP log alongside everything else.

## Error handling

### Startup failures (before `ActiveTunnel` is returned)

| Failure | Detection | User-facing message |
|---|---|---|
| `ssh` binary not on PATH | `spawn` ENOENT | `SSH tunnel: 'ssh' command not found on PATH. Install OpenSSH client.` |
| SSH auth/network failure | ssh exits before readiness check succeeds | `SSH tunnel failed: <last ~500 chars of stderr>` |
| Local port bind conflict | ssh exits (via `ExitOnForwardFailure=yes`) | Same as above — stderr includes `bind: Address already in use` |
| Readiness timeout (10s) with ssh still alive | poll loop exhausts, ssh still running | `SSH tunnel not ready after 10s. ssh stderr: <tail>` — also kill the orphan ssh |
| `SSH_KEY` path does not exist | `fs.existsSync` check before spawning | `SSH key not found: <path>` |

All startup failures are thrown from `startTunnel`. Caller in `index.ts` catches and calls `safeExit(1)` — the MCP server does not start. Matches the existing SSL-file failure pattern in `src/config/index.ts:17-39`.

### Runtime failures (after tunnel is up)

- `ssh` process `exit` event → log the exit code + last stderr → `safeExit(1)`.
- MySQL pool errors caused by a dead tunnel surface as normal query errors; the next-arriving `exit` event triggers `safeExit`. No special coupling between pool and tunnel.

### Shutdown failures

- `tunnel.close()` errors are caught and logged; they do not block `pool.end()`. Matches the existing shutdown handler pattern.

### Deliberately out of scope

- Reconnect / retry loop.
- Graceful degradation where queries return "tunnel down" errors.
- Password auth / interactive prompts (`BatchMode=yes` forbids them).

## Testing

### Unit tests (`tests/unit/ssh-tunnel.test.ts`)

Inject a fake `ssh` binary — a short shell script on a tmp path, invoked via a `spawnPath` option on `startTunnel` (production default: `'ssh'`). Covers:

- **Argv construction** — fake binary writes its argv to a file; tests assert flags appear in the expected order, that `-l` / `-p` / `-i` are omitted when the corresponding config fields are absent, and that `~` in `SSH_KEY` is expanded.
- **Local port picked & passed in `-L`** — assert the local port in argv matches the one returned in `ActiveTunnel`.
- **Readiness success** — fake binary opens a TCP listener on the local port → `startTunnel` resolves; `ActiveTunnel.localPort` matches.
- **Readiness timeout** — fake binary sleeps without listening → rejects with "not ready after 10s" (test with short override, e.g. 500ms).
- **ssh exits before ready** — fake binary writes to stderr and exits 1 → rejects with stderr tail in message.
- **Missing key file** — pre-flight check rejects without spawning.
- **Shutdown kills child** — after `close()`, fake binary's PID is gone; SIGKILL path exercised by a fake that ignores SIGTERM.
- **Runtime exit triggers callback** — inject a hook in place of `safeExit` and assert it fires when the fake exits post-readiness.

### Config parsing tests (`tests/unit/config-ssh.test.ts`)

- `SSH_HOST` absent → no SSH config emitted.
- `SSH_HOST` + `MYSQL_SOCKET_PATH` → warning logged, socket path wins, tunnel config is not emitted.
- `SSH_PORT` is coerced to a number; non-numeric values reject at parse time.

### Integration test (`tests/integration/ssh-tunnel.test.ts`, gated)

One end-to-end test against a real `ssh` binary tunneling to `localhost` (`SSH_HOST=localhost`, key via `~/.ssh/id_rsa` or `SSH_AUTH_SOCK`, remote = the test MySQL). Verifies a real `mysql2` query succeeds through the tunnel. Gated on `SSH_TUNNEL_INTEGRATION=true` and skipped by default; developers opt in when validating real SSH paths. Keeps the default test suite hermetic.

## Migration

The existing `scripts/start-tunnel-rds.sh` and `scripts/stop-tunnel-rds.sh` remain in the repo and continue to work unchanged — they are useful for non-MCP workflows (e.g. interactive `mysql` clients). README should gain a new section describing the native tunnel mode and pointing users who prefer manual tunnels at the scripts.

## Open decisions

None. All five clarifying questions resolved:

1. Implementation: spawn system `ssh` (not `ssh2` library).
2. Configuration: reuse `MYSQL_HOST`/`MYSQL_PORT`; auto-generate local port; support `~/.ssh/config` aliases via `SSH_HOST`.
3. Readiness: TCP poll + `ExitOnForwardFailure=yes`.
4. Runtime failure: crash the server (`safeExit(1)`), no auto-reconnect.
5. Opt-in: presence of `SSH_HOST` enables; socket path wins on conflict with a warning.
