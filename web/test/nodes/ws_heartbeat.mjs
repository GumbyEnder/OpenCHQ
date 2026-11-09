// The socket stays open on its own. A proxy closes a quiet connection; the server must be the
// one that speaks. This test holds a socket idle for three ping intervals, proves the server
// sent ping frames of its own, and pins the production interval under the 20 s promise.
import { connect } from "node:net";
import { Peer, PING_MS } from "../../server/ws.mjs";

export const name = "ws_heartbeat";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A raw upgrade so the ping frames are visible as bytes, not hidden by the browser API.
function rawPing(port, token, waitMs) {
  return new Promise((resolve, reject) => {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const client = connect(port, "127.0.0.1", () => {
      client.write(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n" +
          "Cookie: openchq_session=" + token + "\r\n\r\n"
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      client.destroy();
      resolve({ ping: false, upgraded });
    }, waitMs);
    client.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded && buf.includes("\r\n\r\n")) {
        upgraded = true;
        buf = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
      }
      // Walk frames: [fin|opcode, len(masked?), ...]
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = buf.readUInt32BE(6);
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return;
        buf = buf.subarray(offset + maskLen + len);
        if (opcode === 0x9) {
          clearTimeout(timer);
          client.end();
          resolve({ ping: true, upgraded });
          return;
        }
      }
    });
    client.on("error", reject);
  });
}

export async function run(ctx) {
  const { fail } = ctx;
  if (!(PING_MS > 0 && PING_MS <= 20000)) fail("the server ping interval is " + PING_MS + " ms, over 20 s");

  // The silent drop itself: a 70 KB payload used to hit `else { return; }` and vanish. It must
  // now leave with the 64-bit length header.
  const writes = [];
  const fake = { on() {}, write(chunk) { writes.push(chunk); }, end() {} };
  const peer = new Peer(fake);
  const big = Buffer.alloc(70000, 0x61);
  peer._frame(0x1, big);
  if (writes.length !== 1) fail("a 70 KB frame produced " + writes.length + " writes, expected 1");
  const frame = writes[0];
  if (frame.length !== 10 + big.length) fail("a 70 KB frame is " + frame.length + " bytes, expected " + (10 + big.length));
  if (frame[1] !== 127) fail("a 70 KB frame used length code " + frame[1] + ", expected 127");
  if (frame.readUInt32BE(6) !== big.length) fail("the 64-bit length is " + frame.readUInt32BE(6) + ", expected " + big.length);
  peer.close();

  const user = await ctx.register();
  const sock = ctx.socket(user.token);
  await sock.wait((m) => m.op === "welcome", "welcome");

  // Three ping intervals with no application traffic. A connection the server or a proxy had
  // dropped would be closed here.
  await sleep(PING_MS * 3 + 200);
  if (sock.ws.readyState !== 1) {
    fail("an idle socket closed after " + (PING_MS * 3) + " ms (readyState " + sock.ws.readyState + ")");
  }

  const seen = await rawPing(ctx.port, user.token, Math.max(1500, PING_MS * 3));
  if (!seen.upgraded) fail("the raw socket was not upgraded");
  if (!seen.ping) fail("the server sent no ping frame of its own within " + Math.max(1500, PING_MS * 3) + " ms");

  sock.close();
  console.log("ws_heartbeat: idle " + (PING_MS * 3) + " ms, server ping frames seen, production cap <= 20 s");
}
