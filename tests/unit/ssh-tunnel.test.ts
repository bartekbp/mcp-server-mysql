import { describe, it, expect } from "vitest";
import * as net from "net";
import { pickFreePort, buildSshArgv, waitForTcpReady } from "../../src/ssh/tunnel.js";

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
    expect(p1).not.toBe(p2);
  });
});

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

describe("waitForTcpReady", () => {
  it("resolves once a listener is available", async () => {
    const port = await pickFreePort();
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
    const port = await pickFreePort();
    await expect(
      waitForTcpReady(port, { timeoutMs: 200, intervalMs: 50 }),
    ).rejects.toThrow(/timeout/i);
  });
});
