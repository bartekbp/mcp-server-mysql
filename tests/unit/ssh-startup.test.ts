import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import { mcpConfig } from "../../src/config/index.js";
import { setupSshTunnelIfConfigured } from "../../src/ssh/startup.js";
import { ActiveTunnel } from "../../src/ssh/tunnel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_OK = path.resolve(__dirname, "../fixtures/ssh/fake-ssh-ok.sh");

const VARS = ["SSH_HOST", "SSH_USER", "SSH_PORT", "SSH_KEY", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_SOCKET_PATH"] as const;

let savedEnv: Record<string, string | undefined> = {};
let savedHost: string | undefined;
let savedPort: number | undefined;
let activeTunnel: ActiveTunnel | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const k of VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  const m = mcpConfig.mysql as { host?: string; port?: number };
  savedHost = m.host;
  savedPort = m.port;
});

afterEach(async () => {
  if (activeTunnel) {
    await activeTunnel.close();
    activeTunnel = undefined;
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const m = mcpConfig.mysql as { host?: string; port?: number };
  m.host = savedHost;
  m.port = savedPort;
});

describe("setupSshTunnelIfConfigured", () => {
  it("returns undefined and leaves config untouched when SSH_HOST is absent", async () => {
    const m = mcpConfig.mysql as { host?: string; port?: number };
    const originalHost = m.host;
    const originalPort = m.port;
    const result = await setupSshTunnelIfConfigured({ spawnPath: FIXTURE_OK });
    expect(result).toBeUndefined();
    expect(m.host).toBe(originalHost);
    expect(m.port).toBe(originalPort);
  });

  it("rewrites mcpConfig.mysql.host and .port AFTER the tunnel is ready", async () => {
    process.env.SSH_HOST = "fake-bastion";
    process.env.MYSQL_HOST = "172.16.1.7";
    process.env.MYSQL_PORT = "3306";

    activeTunnel = await setupSshTunnelIfConfigured({
      spawnPath: FIXTURE_OK,
      readinessTimeoutMs: 3000,
      readinessPollIntervalMs: 50,
    });

    expect(activeTunnel).toBeDefined();
    const m = mcpConfig.mysql as { host?: string; port?: number };
    expect(m.host).toBe("127.0.0.1");
    expect(m.port).toBe(activeTunnel!.localPort);
    // Sanity check: the rewritten port must NOT be the original MYSQL_PORT —
    // otherwise we'd be connecting straight to the remote DB.
    expect(m.port).not.toBe(3306);
  });
});
