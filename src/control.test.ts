import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Server } from "node:net";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-ctl-"));
const { Registry } = await import("./registry.js");
const { startControlServer, CONTROL_SOCKET } = await import("./control.js");

type Host = import("./sessions.js").SessionServiceHost;

function makeHost(): Host {
  const registry = new Registry();
  return {
    registry,
    runtimeInfo: () => undefined,
    dropRuntime: async () => {},
    archiveSession: async () => {},
  };
}

function request(payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(CONTROL_SOCKET);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        sock.end();
        resolve(JSON.parse(buf.trim()));
      }
    });
    sock.on("error", reject);
  });
}

let server: Server;
let host: Host;
beforeEach(() => {
  process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-ctl-"));
  host = makeHost();
  server = startControlServer(host);
});
afterEach(() => server.close());

test("list returns session summaries", async () => {
  host.registry.create("t-a", "alpha");
  const res = await request({ cmd: "list" });
  expect(res.ok).toBe(true);
  expect(res.data[0]).toMatchObject({ title: "alpha", status: "active" });
});

test("end marks a session ended", async () => {
  const a = host.registry.create("t-a", "alpha");
  const res = await request({ cmd: "end", args: { num: a.sessionNum } });
  expect(res).toMatchObject({ ok: true, data: { ended: true } });
  expect(host.registry.get("t-a")?.status).toBe("ended");
});

test("unknown command returns a structured error", async () => {
  const res = await request({ cmd: "bogus" });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("unknown command");
});

test("malformed JSON returns a structured error, not a crash", async () => {
  const res = await new Promise<any>((resolve, reject) => {
    const sock = createConnection(CONTROL_SOCKET);
    let buf = "";
    sock.on("connect", () => sock.write("not json\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        sock.end();
        resolve(JSON.parse(buf.trim()));
      }
    });
    sock.on("error", reject);
  });
  expect(res.ok).toBe(false);
});
