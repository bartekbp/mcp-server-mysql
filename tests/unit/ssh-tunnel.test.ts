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
    expect(p1).not.toBe(p2);
  });
});
