# SSH Port Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native SSH port forwarding to the MCP server — tunnel starts at server startup, auto-generated random local port, torn down cleanly at shutdown, opt-in via `SSH_HOST` env var.

**Architecture:** New `src/ssh/tunnel.ts` module spawns the system `ssh` binary with `-L`, picks a free local port, waits for TCP readiness. `src/config/index.ts` gains `getSshTunnelConfig()` to parse `SSH_*` env vars. `index.ts` calls `startTunnel` before the first `getPool()` and overrides `mcpConfig.mysql.host/port`. Shutdown closes the pool first, then the tunnel.

**Tech Stack:** TypeScript (ES Modules, NodeNext), Node `child_process.spawn`, Node `net`, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-17-ssh-tunnel-design.md`

---

## File Structure

**Create:**
- `src/ssh/tunnel.ts` — tunnel module (types, `startTunnel`, helpers)
- `tests/unit/ssh-tunnel.test.ts` — unit tests for tunnel module (fake `ssh` binary)
- `tests/unit/ssh-config.test.ts` — unit tests for `getSshTunnelConfig`
- `tests/integration/ssh-tunnel.test.ts` — gated end-to-end test via real `ssh`

**Modify:**
- `src/config/index.ts` — add `SshTunnelConfig` type + `getSshTunnelConfig()` export
- `index.ts` — wire tunnel start/stop into the server lifecycle
- `README.md` — document the new `SSH_*` env vars

---

## Background notes for the implementer

- **ES Module quirk.** `package.json` has `"type": "module"` and `tsconfig.json` uses `"module": "NodeNext"`. All cross-file imports **must** use the `.js` extension in the source even though the source is `.ts`. Example: `import { log } from "../utils/index.js";`. This is not a typo — it is required by Node's ESM resolver.
- **Test env.** Vitest is run from the project root. Existing tests live in `tests/unit/` and `tests/integration/` and use `import { describe, it, expect } from 'vitest'`. There is no separate vitest config file — the default is used. Look at `tests/unit/ssl-mtls.test.ts` as a reference.
- **`safeExit`** is defined in `src/db/index.ts:25` and skips `process.exit` when running under Vitest (checks `process.env.VITEST`). Import from `../db/index.js` if needed.
- **`log`** is defined in `src/utils/index.ts:8`. It only emits output when `ENABLE_LOGGING=true`. Logs are still useful in tests for debugging; they just won't show by default.
- **`mcpConfig.mysql` is mutable.** It's a plain object (`src/config/index.ts:102-174`). After tunnel start, mutate `mcpConfig.mysql.host` and `.port` directly — no refactor needed.
- **Platform.** This repo assumes macOS/Linux. Shell-script fixtures using `#!/usr/bin/env sh` are fine. Windows is out of scope.

---

## Task 1: Scaffold `src/ssh/tunnel.ts` with types and stub

**Files:**
- Create: `src/ssh/tunnel.ts`

Define the public types and export a stub `startTunnel` that throws. Later tasks fill in the implementation. Having the module exist early lets later tasks import from it without churn.

- [ ] **Step 1: Write the stub module**

Create `src/ssh/tunnel.ts`:

```ts
import { ChildProcess } from "child_process";

export interface TunnelConfig {
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  sshKey?: string;
  remoteHost: string;
  remotePort: number;
}

export interface TunnelOptions {
  spawnPath?: string;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  shutdownGraceMs?: number;
  onRuntimeExit?: (code: number | null, stderrTail: string) => void;
}

export interface ActiveTunnel {
  localPort: number;
  close(): Promise<void>;
}

export async function startTunnel(
  _cfg: TunnelConfig,
  _opts: TunnelOptions = {},
): Promise<ActiveTunnel> {
  throw new Error("startTunnel not yet implemented");
}
```

- [ ] **Step 2: Confirm it type-checks**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ssh/tunnel.ts
git commit -m "feat(ssh): scaffold tunnel module with public types"
```

---

## Task 2: TDD helper — `pickFreePort`

**Files:**
- Modify: `src/ssh/tunnel.ts`
- Test: `tests/unit/ssh-tunnel.test.ts`

A small helper that binds to `:0`, reads the assigned port, closes, and returns the port. This is how we pick a random local port.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ssh-tunnel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as net from "net";
import { pickFreePort } from "../../src/ssh/tunnel.js";

describe("pickFreePort", () => {
  it("returns a usable TCP port in the high range", async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  it("returns a port that is immediately bindable", async () => {
    const port = await pickFreePort();
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => {
        s.close(() => resolve());
      });
    });
  });

  it("returns distinct ports across calls", async () => {
    const p1 = await pickFreePort();
    const p2 = await pickFreePort();
    // Not strictly guaranteed but extremely likely — OS rotates ephemeral ports.
    expect(p1).not.toBe(p2);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "pickFreePort"`
Expected: FAIL — `pickFreePort` is not exported.

- [ ] **Step 3: Implement `pickFreePort`**

Add to `src/ssh/tunnel.ts`:

```ts
import * as net from "net";

export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("failed to read port")));
      }
    });
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "pickFreePort"`
Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ssh/tunnel.ts tests/unit/ssh-tunnel.test.ts
git commit -m "feat(ssh): add pickFreePort helper"
```

---

## Task 3: TDD helper — `buildSshArgv`

**Files:**
- Modify: `src/ssh/tunnel.ts`
- Modify: `tests/unit/ssh-tunnel.test.ts`

Pure function: takes `TunnelConfig` + `localPort` and returns the ssh argv array. No side effects. Keeps argv construction unit-testable without spawning anything.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
import { buildSshArgv } from "../../src/ssh/tunnel.js";

describe("buildSshArgv", () => {
  const base = {
    sshHost: "bastion.example.com",
    remoteHost: "db.internal",
    remotePort: 3306,
  };

  it("builds minimal argv with only required fields", () => {
    const argv = buildSshArgv(base, 54321);
    expect(argv).toEqual([
      "-N",
      "-T",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-L", "54321:db.internal:3306",
      "bastion.example.com",
    ]);
  });

  it("includes -l when sshUser is set", () => {
    const argv = buildSshArgv({ ...base, sshUser: "ec2-user" }, 54321);
    expect(argv).toContain("-l");
    const i = argv.indexOf("-l");
    expect(argv[i + 1]).toBe("ec2-user");
  });

  it("includes -p when sshPort is set", () => {
    const argv = buildSshArgv({ ...base, sshPort: 2222 }, 54321);
    const i = argv.indexOf("-p");
    expect(argv[i + 1]).toBe("2222");
  });

  it("includes -i with expanded tilde path when sshKey is set", () => {
    const argv = buildSshArgv({ ...base, sshKey: "~/.ssh/foo.pem" }, 54321);
    const i = argv.indexOf("-i");
    expect(argv[i + 1]).toMatch(/^\/.*\/.ssh\/foo\.pem$/);
    expect(argv[i + 1]).not.toContain("~");
  });

  it("leaves absolute sshKey paths unchanged", () => {
    const argv = buildSshArgv({ ...base, sshKey: "/tmp/foo.pem" }, 54321);
    const i = argv.indexOf("-i");
    expect(argv[i + 1]).toBe("/tmp/foo.pem");
  });

  it("places SSH_HOST as the last argument", () => {
    const argv = buildSshArgv({ ...base, sshUser: "u", sshPort: 22, sshKey: "/k" }, 1);
    expect(argv[argv.length - 1]).toBe("bastion.example.com");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "buildSshArgv"`
Expected: FAIL — `buildSshArgv` is not exported.

- [ ] **Step 3: Implement `buildSshArgv`**

Add to `src/ssh/tunnel.ts` (near the top, after imports):

```ts
import * as os from "os";
import * as path from "path";

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function buildSshArgv(cfg: TunnelConfig, localPort: number): string[] {
  const argv: string[] = [
    "-N",
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-L", `${localPort}:${cfg.remoteHost}:${cfg.remotePort}`,
  ];
  if (cfg.sshUser) argv.push("-l", cfg.sshUser);
  if (cfg.sshPort !== undefined) argv.push("-p", String(cfg.sshPort));
  if (cfg.sshKey) argv.push("-i", expandHome(cfg.sshKey));
  argv.push(cfg.sshHost);
  return argv;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "buildSshArgv"`
Expected: all six tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ssh/tunnel.ts tests/unit/ssh-tunnel.test.ts
git commit -m "feat(ssh): add buildSshArgv helper"
```

---

## Task 4: TDD helper — `waitForTcpReady`

**Files:**
- Modify: `src/ssh/tunnel.ts`
- Modify: `tests/unit/ssh-tunnel.test.ts`

Polls `127.0.0.1:<port>` with TCP connects until one succeeds or the deadline passes. Each probe must fully close its socket on failure to avoid leaking file descriptors.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
import { waitForTcpReady, pickFreePort as _pfp } from "../../src/ssh/tunnel.js";

describe("waitForTcpReady", () => {
  it("resolves once a listener is available", async () => {
    const port = await _pfp();
    // Start a listener after a short delay so the first probe fails.
    const server = net.createServer();
    const started = new Promise<void>((resolve) => {
      setTimeout(() => {
        server.listen(port, "127.0.0.1", () => resolve());
      }, 150);
    });
    try {
      await Promise.all([
        waitForTcpReady(port, { timeoutMs: 2000, intervalMs: 50 }),
        started,
      ]);
    } finally {
      server.close();
    }
  });

  it("rejects after the timeout if nothing listens", async () => {
    const port = await _pfp();
    await expect(
      waitForTcpReady(port, { timeoutMs: 200, intervalMs: 50 }),
    ).rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "waitForTcpReady"`
Expected: FAIL — `waitForTcpReady` is not exported.

- [ ] **Step 3: Implement `waitForTcpReady`**

Add to `src/ssh/tunnel.ts`:

```ts
export interface WaitForTcpOptions {
  timeoutMs: number;
  intervalMs: number;
}

export async function waitForTcpReady(
  port: number,
  opts: WaitForTcpOptions,
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const ok = await tryConnect(port);
    if (ok) return;
    await sleep(opts.intervalMs);
  }
  throw new Error(`TCP readiness timeout: 127.0.0.1:${port} did not accept within ${opts.timeoutMs}ms`);
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "waitForTcpReady"`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ssh/tunnel.ts tests/unit/ssh-tunnel.test.ts
git commit -m "feat(ssh): add waitForTcpReady helper"
```

---

## Task 5: Add fake-ssh test fixtures

**Files:**
- Create: `tests/fixtures/ssh/README.md`
- Create: `tests/fixtures/ssh/fake-ssh-ok.sh`
- Create: `tests/fixtures/ssh/fake-ssh-crash.sh`
- Create: `tests/fixtures/ssh/fake-ssh-hang.sh`
- Create: `tests/fixtures/ssh/fake-ssh-ignore-sigterm.sh`

These shell scripts stand in for the real `ssh` binary during unit tests. Each parses the `-L localPort:host:port` argument and behaves differently:

- `fake-ssh-ok.sh` — opens a TCP listener on the local port and stays running.
- `fake-ssh-crash.sh` — writes a diagnostic to stderr and exits 255 (auth failure style).
- `fake-ssh-hang.sh` — sleeps forever without binding anything (readiness-timeout scenario).
- `fake-ssh-ignore-sigterm.sh` — like `ok`, but traps SIGTERM so the SIGKILL path is exercised.

All fixtures use Node (which we know is available in CI) via `node -e` to keep them platform-consistent.

- [ ] **Step 1: Create the fixtures directory and README**

Create `tests/fixtures/ssh/README.md`:

```markdown
# Fake SSH fixtures

Shell scripts that stand in for `ssh` in unit tests. Each parses the `-L localPort:remoteHost:remotePort` arg and uses Node to simulate a specific scenario. Called by tests via the `spawnPath` option on `startTunnel`.
```

- [ ] **Step 2: Create `fake-ssh-ok.sh`**

Create `tests/fixtures/ssh/fake-ssh-ok.sh`:

```sh
#!/usr/bin/env sh
# Parse -L <localPort>:<remoteHost>:<remotePort> from args, then listen on localPort.
LOCAL_PORT=""
next_is_L=""
for arg in "$@"; do
  if [ "$next_is_L" = "1" ]; then
    LOCAL_PORT=$(echo "$arg" | cut -d: -f1)
    next_is_L=""
    break
  fi
  if [ "$arg" = "-L" ]; then
    next_is_L="1"
  fi
done
if [ -z "$LOCAL_PORT" ]; then
  echo "fake-ssh-ok: no -L arg found" >&2
  exit 2
fi
exec node -e "
  const net = require('net');
  const s = net.createServer();
  s.listen(${LOCAL_PORT}, '127.0.0.1');
  process.on('SIGTERM', () => { s.close(() => process.exit(0)); });
  process.on('SIGINT', () => { s.close(() => process.exit(0)); });
  setInterval(() => {}, 60000);
"
```

- [ ] **Step 3: Create `fake-ssh-crash.sh`**

Create `tests/fixtures/ssh/fake-ssh-crash.sh`:

```sh
#!/usr/bin/env sh
echo "Permission denied (publickey)." >&2
echo "fake-ssh-crash: simulated auth failure" >&2
exit 255
```

- [ ] **Step 4: Create `fake-ssh-hang.sh`**

Create `tests/fixtures/ssh/fake-ssh-hang.sh`:

```sh
#!/usr/bin/env sh
# Block forever without binding anything. Exercises the readiness timeout.
exec node -e "setInterval(() => {}, 60000);"
```

- [ ] **Step 5: Create `fake-ssh-ignore-sigterm.sh`**

Create `tests/fixtures/ssh/fake-ssh-ignore-sigterm.sh`:

```sh
#!/usr/bin/env sh
LOCAL_PORT=""
next_is_L=""
for arg in "$@"; do
  if [ "$next_is_L" = "1" ]; then
    LOCAL_PORT=$(echo "$arg" | cut -d: -f1)
    next_is_L=""
    break
  fi
  if [ "$arg" = "-L" ]; then
    next_is_L="1"
  fi
done
if [ -z "$LOCAL_PORT" ]; then
  echo "fake-ssh-ignore-sigterm: no -L arg found" >&2
  exit 2
fi
exec node -e "
  const net = require('net');
  const s = net.createServer();
  s.listen(${LOCAL_PORT}, '127.0.0.1');
  process.on('SIGTERM', () => { /* ignore */ });
  setInterval(() => {}, 60000);
"
```

- [ ] **Step 6: Make all fixtures executable**

Run:
```bash
chmod +x tests/fixtures/ssh/fake-ssh-ok.sh \
         tests/fixtures/ssh/fake-ssh-crash.sh \
         tests/fixtures/ssh/fake-ssh-hang.sh \
         tests/fixtures/ssh/fake-ssh-ignore-sigterm.sh
```

- [ ] **Step 7: Verify fixtures are tracked as executable by git**

Run: `git ls-files --stage tests/fixtures/ssh/`
Expected: all `.sh` entries show mode `100755`.

If any show `100644`, run `git update-index --chmod=+x <path>` for each.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/ssh/
git commit -m "test(ssh): add fake-ssh binaries for unit tests"
```

---

## Task 6: TDD `startTunnel` — happy path

**Files:**
- Modify: `src/ssh/tunnel.ts`
- Modify: `tests/unit/ssh-tunnel.test.ts`

Implement the core orchestration: pick port, spawn fake ssh, wait for readiness, return `ActiveTunnel`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
import * as path from "path";
import { fileURLToPath } from "url";
import { startTunnel } from "../../src/ssh/tunnel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_OK = path.resolve(__dirname, "../fixtures/ssh/fake-ssh-ok.sh");

describe("startTunnel (happy path)", () => {
  it("spawns the fake ssh, waits for readiness, and returns ActiveTunnel", async () => {
    const tunnel = await startTunnel(
      {
        sshHost: "fake-bastion",
        remoteHost: "fake-db",
        remotePort: 3306,
      },
      {
        spawnPath: FIXTURE_OK,
        readinessTimeoutMs: 3000,
        readinessPollIntervalMs: 50,
      },
    );
    try {
      expect(tunnel.localPort).toBeGreaterThan(1024);
      // The fake opens a listener on localPort — confirm we can connect.
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ host: "127.0.0.1", port: tunnel.localPort });
        s.once("connect", () => { s.destroy(); resolve(); });
        s.once("error", reject);
      });
    } finally {
      await tunnel.close();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "startTunnel \\(happy path\\)"`
Expected: FAIL — `startTunnel` currently throws `"not yet implemented"`.

- [ ] **Step 3: Replace the stub with the real implementation**

In `src/ssh/tunnel.ts`, replace the existing stub `startTunnel` with:

```ts
import { spawn } from "child_process";
import { log } from "../utils/index.js";

const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_POLL_MS = 50;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const STDERR_TAIL_BYTES = 500;

export async function startTunnel(
  cfg: TunnelConfig,
  opts: TunnelOptions = {},
): Promise<ActiveTunnel> {
  const spawnPath = opts.spawnPath ?? "ssh";
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const pollMs = opts.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_MS;

  const localPort = await pickFreePort();
  const argv = buildSshArgv(cfg, localPort);

  const child = spawn(spawnPath, argv, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrBuf: string[] = [];
  let stderrBytes = 0;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      log("info", `[ssh] ${line}`);
    }
    stderrBuf.push(chunk);
    stderrBytes += chunk.length;
    while (stderrBytes > STDERR_TAIL_BYTES && stderrBuf.length > 1) {
      stderrBytes -= stderrBuf.shift()!.length;
    }
  });

  const stderrTail = () => {
    const joined = stderrBuf.join("");
    return joined.slice(Math.max(0, joined.length - STDERR_TAIL_BYTES));
  };

  // Wait for either readiness or early exit.
  const earlyExit = new Promise<never>((_, reject) => {
    child.once("exit", (code) => {
      reject(new Error(`SSH tunnel failed (exit ${code}): ${stderrTail()}`));
    });
    child.once("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`SSH tunnel: '${spawnPath}' command not found on PATH. Install OpenSSH client.`));
      } else {
        reject(err);
      }
    });
  });

  try {
    await Promise.race([
      waitForTcpReady(localPort, { timeoutMs: readinessTimeoutMs, intervalMs: pollMs }),
      earlyExit,
    ]);
  } catch (err) {
    // Kill the child if it's still around so we don't orphan it.
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    throw err;
  }

  return makeActiveTunnel(child, localPort, opts, stderrTail);
}

function makeActiveTunnel(
  child: ChildProcess,
  localPort: number,
  opts: TunnelOptions,
  stderrTail: () => string,
): ActiveTunnel {
  let closing = false;
  const onRuntimeExit = opts.onRuntimeExit ?? defaultRuntimeExit;

  const runtimeExitListener = (code: number | null) => {
    if (closing) return;
    log("error", `[ssh] tunnel exited unexpectedly (code ${code}). stderr tail: ${stderrTail()}`);
    onRuntimeExit(code, stderrTail());
  };
  child.on("exit", runtimeExitListener);

  const close = async () => {
    if (closing) return;
    closing = true;
    child.removeListener("exit", runtimeExitListener);
    if (child.exitCode !== null || child.killed) return;

    const grace = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    child.kill("SIGTERM");
    const exited = await waitForExit(child, grace);
    if (!exited) {
      child.kill("SIGKILL");
      await waitForExit(child, grace);
    }
  };

  return { localPort, close };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function defaultRuntimeExit(_code: number | null, _stderrTail: string): Promise<void> {
  // Import lazily to avoid a circular dependency during module init.
  const { safeExit } = await import("../db/index.js");
  safeExit(1);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "startTunnel \\(happy path\\)"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ssh/tunnel.ts tests/unit/ssh-tunnel.test.ts
git commit -m "feat(ssh): implement startTunnel happy path with fake-ssh fixture"
```

---

## Task 7: TDD `startTunnel` — SSH key pre-flight check

**Files:**
- Modify: `src/ssh/tunnel.ts`
- Modify: `tests/unit/ssh-tunnel.test.ts`

If the user provides `SSH_KEY` and the file does not exist, fail before spawning — the error is clearer than whatever `ssh` would emit.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
describe("startTunnel (key pre-flight)", () => {
  it("rejects with a clear error when sshKey path does not exist", async () => {
    await expect(
      startTunnel(
        {
          sshHost: "fake-bastion",
          remoteHost: "fake-db",
          remotePort: 3306,
          sshKey: "/does/not/exist/key.pem",
        },
        { spawnPath: FIXTURE_OK },
      ),
    ).rejects.toThrow(/SSH key not found/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "key pre-flight"`
Expected: FAIL — the test gets a different error (probably a spawn failure or readiness timeout) instead of the expected message.

- [ ] **Step 3: Add the pre-flight check**

In `src/ssh/tunnel.ts`, update the top of `startTunnel` (after computing defaults, before `pickFreePort`):

```ts
import * as fs from "fs";

// ... inside startTunnel, after the opts defaults:
if (cfg.sshKey) {
  const expanded = expandHome(cfg.sshKey);
  if (!fs.existsSync(expanded)) {
    throw new Error(`SSH key not found: ${cfg.sshKey}`);
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "key pre-flight"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ssh/tunnel.ts tests/unit/ssh-tunnel.test.ts
git commit -m "feat(ssh): pre-flight check for SSH key path"
```

---

## Task 8: TDD `startTunnel` — ssh exits before ready

**Files:**
- Modify: `tests/unit/ssh-tunnel.test.ts`

Uses `fake-ssh-crash.sh` to simulate auth failure. Verifies startTunnel rejects and the rejection includes stderr context.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
const FIXTURE_CRASH = path.resolve(__dirname, "../fixtures/ssh/fake-ssh-crash.sh");

describe("startTunnel (ssh exits before ready)", () => {
  it("rejects with a message containing the stderr tail", async () => {
    await expect(
      startTunnel(
        { sshHost: "fake-bastion", remoteHost: "fake-db", remotePort: 3306 },
        { spawnPath: FIXTURE_CRASH, readinessTimeoutMs: 3000 },
      ),
    ).rejects.toThrow(/Permission denied/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "ssh exits before ready"`
Expected: PASS (the `earlyExit` branch in `startTunnel` already handles this — the test is there to lock in the behavior).

If the test fails: debug. The likely cause is that the stderr tail is empty because the child exited before the `data` handler fired; in that case, read stderr synchronously on exit:

```ts
// In the earlyExit promise, after child.once("exit", ...) already exists:
child.once("exit", (code) => {
  // Small defer lets any pending stderr 'data' events flush first.
  setImmediate(() => {
    reject(new Error(`SSH tunnel failed (exit ${code}): ${stderrTail()}`));
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add tests/unit/ssh-tunnel.test.ts src/ssh/tunnel.ts
git commit -m "test(ssh): lock in early-exit rejection behavior"
```

---

## Task 9: TDD `startTunnel` — readiness timeout

**Files:**
- Modify: `tests/unit/ssh-tunnel.test.ts`

Uses `fake-ssh-hang.sh` to simulate a tunnel that never binds. Verifies startTunnel rejects with a timeout message and the orphan child is killed.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
const FIXTURE_HANG = path.resolve(__dirname, "../fixtures/ssh/fake-ssh-hang.sh");

describe("startTunnel (readiness timeout)", () => {
  it("rejects with a timeout error when ssh never binds", async () => {
    await expect(
      startTunnel(
        { sshHost: "fake-bastion", remoteHost: "fake-db", remotePort: 3306 },
        {
          spawnPath: FIXTURE_HANG,
          readinessTimeoutMs: 300,
          readinessPollIntervalMs: 50,
        },
      ),
    ).rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "readiness timeout"`
Expected: PASS. The `waitForTcpReady` branch wins the race and rejects; the catch block in `startTunnel` kills the orphan child.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/ssh-tunnel.test.ts
git commit -m "test(ssh): lock in readiness timeout behavior"
```

---

## Task 10: TDD `ActiveTunnel.close` — SIGTERM graceful path

**Files:**
- Modify: `tests/unit/ssh-tunnel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
describe("ActiveTunnel.close (SIGTERM path)", () => {
  it("terminates the child process gracefully", async () => {
    const tunnel = await startTunnel(
      { sshHost: "fake-bastion", remoteHost: "fake-db", remotePort: 3306 },
      { spawnPath: FIXTURE_OK, readinessTimeoutMs: 3000 },
    );
    const port = tunnel.localPort;
    await tunnel.close();

    // The local port should no longer accept connections.
    const connectable = await new Promise<boolean>((resolve) => {
      const s = net.createConnection({ host: "127.0.0.1", port });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { resolve(false); });
    });
    expect(connectable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "SIGTERM path"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/ssh-tunnel.test.ts
git commit -m "test(ssh): lock in graceful close behavior"
```

---

## Task 11: TDD `ActiveTunnel.close` — SIGKILL fallback

**Files:**
- Modify: `tests/unit/ssh-tunnel.test.ts`

Uses `fake-ssh-ignore-sigterm.sh` to verify the SIGKILL fallback runs after the grace timeout.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
const FIXTURE_IGNORE_SIGTERM = path.resolve(
  __dirname,
  "../fixtures/ssh/fake-ssh-ignore-sigterm.sh",
);

describe("ActiveTunnel.close (SIGKILL fallback)", () => {
  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const tunnel = await startTunnel(
      { sshHost: "fake-bastion", remoteHost: "fake-db", remotePort: 3306 },
      {
        spawnPath: FIXTURE_IGNORE_SIGTERM,
        readinessTimeoutMs: 3000,
        shutdownGraceMs: 200,
      },
    );
    const start = Date.now();
    await tunnel.close();
    const elapsed = Date.now() - start;
    // Should have waited ~200ms on SIGTERM before SIGKILL. Generous upper bound for CI jitter.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "SIGKILL fallback"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/ssh-tunnel.test.ts
git commit -m "test(ssh): lock in SIGKILL fallback behavior"
```

---

## Task 12: TDD runtime-exit callback

**Files:**
- Modify: `tests/unit/ssh-tunnel.test.ts`

Verify that if the ssh child dies *after* the tunnel is ready (runtime failure), the configured `onRuntimeExit` callback fires. The production default would call `safeExit(1)`; in tests we inject a capturing hook.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/ssh-tunnel.test.ts`:

```ts
describe("runtime exit callback", () => {
  it("invokes onRuntimeExit when ssh dies after readiness", async () => {
    const events: Array<{ code: number | null; tail: string }> = [];
    const tunnel = await startTunnel(
      { sshHost: "fake-bastion", remoteHost: "fake-db", remotePort: 3306 },
      {
        spawnPath: FIXTURE_OK,
        readinessTimeoutMs: 3000,
        onRuntimeExit: (code, tail) => { events.push({ code, tail }); },
      },
    );
    // Simulate the tunnel dying on its own by killing the child directly.
    // We reach into the fake via the local port: closing a connection isn't
    // enough, so we kill the process via its PID. The test relies on the
    // fake's own PID being discoverable — simplest is to look up what's
    // bound to the local port and SIGKILL it.
    const pid = await pidBoundTo(tunnel.localPort);
    process.kill(pid, "SIGKILL");
    // Wait briefly for the exit event to propagate.
    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

async function pidBoundTo(port: number): Promise<number> {
  const { execSync } = await import("child_process");
  const out = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN`).toString().trim();
  const pid = Number(out.split(/\s+/)[0]);
  if (!Number.isFinite(pid)) throw new Error(`no pid on port ${port}`);
  return pid;
}
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/unit/ssh-tunnel.test.ts -t "runtime exit callback"`
Expected: PASS.

If `lsof` is unavailable on the runner, replace `pidBoundTo` with a fallback that uses `ss -tlnp` on Linux. Document at the top of the test file if you had to change it.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/ssh-tunnel.test.ts
git commit -m "test(ssh): runtime exit callback fires after readiness"
```

---

## Task 13: TDD `getSshTunnelConfig` in `src/config/index.ts`

**Files:**
- Modify: `src/config/index.ts`
- Create: `tests/unit/ssh-config.test.ts`

Parses `SSH_HOST` / `SSH_USER` / `SSH_PORT` / `SSH_KEY` from env, pulls `remoteHost` / `remotePort` from the existing MySQL config, and applies the "socket path wins" rule.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/ssh-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSshTunnelConfig } from "../../src/config/index.js";

// Reset SSH/MySQL env vars between tests so each test starts clean.
// getSshTunnelConfig reads process.env on every call, so no module reload needed.
const VARS = [
  "SSH_HOST", "SSH_USER", "SSH_PORT", "SSH_KEY",
  "MYSQL_HOST", "MYSQL_PORT", "MYSQL_SOCKET_PATH",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("getSshTunnelConfig", () => {
  it("returns undefined when SSH_HOST is absent", () => {
    expect(getSshTunnelConfig()).toBeUndefined();
  });

  it("returns config with defaults when only SSH_HOST is set", () => {
    process.env.SSH_HOST = "bastion.example.com";
    process.env.MYSQL_HOST = "db.internal";
    process.env.MYSQL_PORT = "3306";
    expect(getSshTunnelConfig()).toEqual({
      sshHost: "bastion.example.com",
      remoteHost: "db.internal",
      remotePort: 3306,
    });
  });

  it("carries optional SSH_USER/SSH_PORT/SSH_KEY through", () => {
    process.env.SSH_HOST = "bastion";
    process.env.SSH_USER = "ec2-user";
    process.env.SSH_PORT = "2222";
    process.env.SSH_KEY = "~/.ssh/mykey.pem";
    process.env.MYSQL_HOST = "db";
    process.env.MYSQL_PORT = "3306";
    expect(getSshTunnelConfig()).toEqual({
      sshHost: "bastion",
      sshUser: "ec2-user",
      sshPort: 2222,
      sshKey: "~/.ssh/mykey.pem",
      remoteHost: "db",
      remotePort: 3306,
    });
  });

  it("returns undefined when MYSQL_SOCKET_PATH is also set (socket wins)", () => {
    process.env.SSH_HOST = "bastion";
    process.env.MYSQL_SOCKET_PATH = "/tmp/mysql.sock";
    expect(getSshTunnelConfig()).toBeUndefined();
  });

  it("throws on non-numeric SSH_PORT", () => {
    process.env.SSH_HOST = "bastion";
    process.env.SSH_PORT = "not-a-number";
    expect(() => getSshTunnelConfig()).toThrow(/SSH_PORT/);
  });
});
```

**Caveat:** `connectionStringConfig` is computed at module load from `MYSQL_CONNECTION_STRING`. These tests do not cover the "SSH_HOST + connection-string-with-socketPath" branch — that would require module reload. Direct `MYSQL_SOCKET_PATH` coverage is sufficient for v1.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec vitest run tests/unit/ssh-config.test.ts`
Expected: FAIL — `getSshTunnelConfig` is not exported.

- [ ] **Step 3: Implement `getSshTunnelConfig`**

Append to the bottom of `src/config/index.ts` (just before the final `export` lines):

```ts
export interface SshTunnelConfig {
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  sshKey?: string;
  remoteHost: string;
  remotePort: number;
}

export function getSshTunnelConfig(): SshTunnelConfig | undefined {
  const sshHost = process.env.SSH_HOST?.trim();
  if (!sshHost) return undefined;

  const socketPath =
    connectionStringConfig.socketPath || process.env.MYSQL_SOCKET_PATH;
  if (socketPath) {
    console.info(
      "[ssh] SSH_HOST is set but MYSQL_SOCKET_PATH takes precedence; SSH tunnel will not be started.",
    );
    return undefined;
  }

  const remoteHost =
    connectionStringConfig.host || process.env.MYSQL_HOST || "127.0.0.1";
  const remotePort =
    connectionStringConfig.port || Number(process.env.MYSQL_PORT || "3306");

  const cfg: SshTunnelConfig = { sshHost, remoteHost, remotePort };

  if (process.env.SSH_USER) cfg.sshUser = process.env.SSH_USER;
  if (process.env.SSH_PORT) {
    const parsed = Number(process.env.SSH_PORT);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid SSH_PORT: ${process.env.SSH_PORT}`);
    }
    cfg.sshPort = parsed;
  }
  if (process.env.SSH_KEY) cfg.sshKey = process.env.SSH_KEY;

  return cfg;
}
```

Note: `console.info` is used deliberately here rather than `log` — this message should always surface to help users diagnose config mistakes, and avoids importing `log` into a module that `log` itself can import (no circular risk here, but keeping config self-contained is nice).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run tests/unit/ssh-config.test.ts`
Expected: all five tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts tests/unit/ssh-config.test.ts
git commit -m "feat(config): add getSshTunnelConfig env var parsing"
```

---

## Task 14: Wire tunnel startup into `index.ts`

**Files:**
- Modify: `index.ts`

Start the tunnel (if configured) before the existing DB connection test, and mutate `mcpConfig.mysql.host/port` so the pool connects through the tunnel.

- [ ] **Step 1: Read the current startup block**

The block to replace is in `index.ts:348-360`:

```ts
  // Initialize database connection and set up shutdown handlers
  (async () => {
    try {
      log("info", "Attempting to test database connection...");
      // Test the connection before fully starting the server
      const pool = await getPool();
      const connection = await pool.getConnection();
      log("info", "Database connection test successful");
      connection.release();
    } catch (error) {
      log("error", "Fatal error during server startup:", error);
      safeExit(1);
    }
  })();
```

- [ ] **Step 2: Add the import and module-scoped tunnel handle**

Near the top of `index.ts`, alongside the other config imports, add:

```ts
import { getSshTunnelConfig } from "./src/config/index.js";
import { startTunnel, ActiveTunnel } from "./src/ssh/tunnel.js";
```

Inside `createMcpServer`, above the `(async () => { ... })()` startup block, add:

```ts
  let activeTunnel: ActiveTunnel | undefined;
```

- [ ] **Step 3: Replace the startup block**

Replace the block from Step 1 with:

```ts
  // Initialize SSH tunnel (if configured) and test the database connection.
  (async () => {
    try {
      const sshCfg = getSshTunnelConfig();
      if (sshCfg) {
        log("info", `Starting SSH tunnel via ${sshCfg.sshHost} -> ${sshCfg.remoteHost}:${sshCfg.remotePort}...`);
        activeTunnel = await startTunnel(sshCfg);
        log("info", `SSH tunnel ready on 127.0.0.1:${activeTunnel.localPort}`);
        // Point the MySQL pool at the local tunnel endpoint.
        (config.mysql as { host?: string; port?: number }).host = "127.0.0.1";
        (config.mysql as { host?: string; port?: number }).port = activeTunnel.localPort;
      }
      log("info", "Attempting to test database connection...");
      const pool = await getPool();
      const connection = await pool.getConnection();
      log("info", "Database connection test successful");
      connection.release();
    } catch (error) {
      log("error", "Fatal error during server startup:", error);
      safeExit(1);
    }
  })();
```

- [ ] **Step 4: Confirm it type-checks and builds**

Run: `pnpm build`
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add index.ts
git commit -m "feat(mcp): start SSH tunnel before pool init when configured"
```

---

## Task 15: Wire tunnel shutdown into `index.ts`

**Files:**
- Modify: `index.ts`

Extend the existing shutdown handler (`index.ts:363-375`) to close the tunnel **after** the pool is drained.

- [ ] **Step 1: Read the current shutdown block**

In `index.ts`:

```ts
  const shutdown = async (signal: string): Promise<void> => {
    log("error", `Received ${signal}. Shutting down...`);
    try {
      // Only attempt to close the pool if it was created
      if (poolPromise) {
        const pool = await poolPromise;
        await pool.end();
      }
    } catch (err) {
      log("error", "Error closing pool:", err);
      throw err;
    }
  };
```

- [ ] **Step 2: Replace it with a version that also closes the tunnel**

```ts
  const shutdown = async (signal: string): Promise<void> => {
    log("error", `Received ${signal}. Shutting down...`);
    try {
      if (poolPromise) {
        const pool = await poolPromise;
        await pool.end();
      }
    } catch (err) {
      log("error", "Error closing pool:", err);
    }
    try {
      if (activeTunnel) {
        await activeTunnel.close();
        activeTunnel = undefined;
      }
    } catch (err) {
      log("error", "Error closing SSH tunnel:", err);
    }
  };
```

Note: we removed the `throw err` on pool errors so tunnel cleanup still runs. The signal handlers that call `shutdown` already log errors and call `safeExit`, so swallowing here is fine.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat(mcp): close SSH tunnel during shutdown after pool.end"
```

---

## Task 16: Document `SSH_*` env vars in README

**Files:**
- Modify: `README.md`

Find the section that documents `MYSQL_SSL_CA` and similar vars (commit `8e47288` added that) and add a new subsection right after.

- [ ] **Step 1: Locate the environment variables section**

Run: `grep -n "MYSQL_SSL_CA" README.md | head -5`

- [ ] **Step 2: Add the SSH section**

Insert the following block in the environment variables section, after the SSL vars:

```markdown
### SSH Tunnel (optional)

The server can establish an SSH port-forward at startup and route MySQL traffic through it. This is useful for databases behind a bastion (e.g. AWS RDS in a private VPC). The tunnel is opened before the first database query and closed at shutdown.

Set `SSH_HOST` to enable. The local port is auto-generated; the MCP server rewrites `MYSQL_HOST` and `MYSQL_PORT` internally — **do not** change your MySQL env vars to point at `127.0.0.1`.

| Variable | Purpose | Default |
|---|---|---|
| `SSH_HOST` | Bastion hostname, IP, or `~/.ssh/config` Host alias. Presence enables the tunnel. | — |
| `SSH_USER` | SSH user. Passed as `-l <user>`. | Resolved from `~/.ssh/config` or current user |
| `SSH_PORT` | SSH port. Passed as `-p <port>`. | Resolved from `~/.ssh/config`, usually 22 |
| `SSH_KEY` | Path to the private key. Passed as `-i <path>`. Supports `~` expansion. | Resolved from `~/.ssh/config` / agent |

Requirements: the system `ssh` binary must be on PATH (ships with macOS and most Linux distros). `BatchMode=yes` is used, so interactive password or passphrase prompts are disabled — use an agent or a passphrase-less key for automation.

If both `SSH_HOST` and `MYSQL_SOCKET_PATH` are set, the Unix socket takes precedence and the tunnel is ignored (with a log line). If the `ssh` process exits unexpectedly at runtime, the MCP server exits and lets the MCP client relaunch it — there is no auto-reconnect.

For an interactive / non-MCP workflow, the `scripts/start-tunnel-rds.sh` and `scripts/stop-tunnel-rds.sh` scripts remain available.
```

- [ ] **Step 3: Verify the markdown lints**

Run: `pnpm lint:markdown`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document SSH tunnel env vars"
```

---

## Task 17: Gated integration test against real `ssh`

**Files:**
- Create: `tests/integration/ssh-tunnel.test.ts`

Opt-in test (gated by `SSH_TUNNEL_INTEGRATION=true`) that verifies the end-to-end path with a real `ssh` binary tunneling to `localhost`. Requires the developer to have passwordless SSH to `localhost` set up (or a loaded agent). Skipped in CI by default.

- [ ] **Step 1: Create the test file**

Create `tests/integration/ssh-tunnel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as mysql from "mysql2/promise";
import { startTunnel } from "../../src/ssh/tunnel.js";

const gated = process.env.SSH_TUNNEL_INTEGRATION === "true"
  ? describe
  : describe.skip;

gated("SSH tunnel integration (real ssh to localhost)", () => {
  it("forwards a real MySQL query through an ssh -L tunnel", async () => {
    const tunnel = await startTunnel({
      sshHost: "localhost",
      remoteHost: process.env.MYSQL_HOST || "127.0.0.1",
      remotePort: Number(process.env.MYSQL_PORT || "3306"),
    });

    try {
      const conn = await mysql.createConnection({
        host: "127.0.0.1",
        port: tunnel.localPort,
        user: process.env.MYSQL_USER || "mcp_test",
        password: process.env.MYSQL_PASS || "mcp_test_password",
        database: process.env.MYSQL_DB || "mcp_test",
      });
      try {
        const [rows] = await conn.query("SELECT 1 AS one");
        expect(rows).toEqual([{ one: 1 }]);
      } finally {
        await conn.end();
      }
    } finally {
      await tunnel.close();
    }
  });
});
```

- [ ] **Step 2: Confirm the test is skipped by default**

Run: `pnpm exec vitest run tests/integration/ssh-tunnel.test.ts`
Expected: 0 tests run (all skipped because `SSH_TUNNEL_INTEGRATION` is unset).

- [ ] **Step 3: (Optional) Run with gate enabled locally**

Only if you have passwordless SSH to localhost configured:
```bash
SSH_TUNNEL_INTEGRATION=true pnpm exec vitest run tests/integration/ssh-tunnel.test.ts
```

If you don't have the setup, skip this step — the gate is the point.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/ssh-tunnel.test.ts
git commit -m "test(ssh): add gated integration test against real ssh"
```

---

## Task 18: Final full-suite sanity check

**Files:** (none)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass. Integration tests that require a MySQL server still run as they do today — this task is a regression check, not a new test.

If SSH-related tests fail on CI because a MySQL server isn't reachable, that's pre-existing project behavior — not introduced by this PR.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: builds cleanly.

- [ ] **Step 4: If any failure, fix and recommit**

Diagnose the specific failure. Do not mark this task complete until `pnpm test`, `pnpm lint`, and `pnpm build` all succeed.

- [ ] **Step 5: Final verification summary**

Write a short summary of what was verified (commands run + their outputs). No commit needed.
