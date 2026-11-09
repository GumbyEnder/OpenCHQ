import { createHash } from "node:crypto";

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The server pings on its own. A proxy in front of the app (Railway's edge) closes a connection
// that has been quiet for a while; a browser sends nothing at all while a player thinks, so the
// server has to be the one that speaks. 15 s is under the 20 s the live build promises and well
// under any proxy's idle window.
export const PING_MS = Number(process.env.OPENCHQ_WS_PING_MS) > 0
  ? Number(process.env.OPENCHQ_WS_PING_MS)
  : 15000;

export function acceptWebSocket(req, socket, onPeer) {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "");
  if (!key || upgrade.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(String(key) + MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  const peer = new Peer(socket);
  onPeer(peer);
}

export class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.ontext = () => {};
    this.onclose = () => {};
    // A fragmented message: opcode 0x1 starts it, 0x0 continues it.
    this.fragment = null;
    this.fragmentOp = 0;
    socket.on("data", (chunk) => this._data(chunk));
    socket.on("close", () => this._shut());
    socket.on("error", () => this._shut());
    // Keepalive. Browsers answer a ping with a pong by themselves; the answer only proves the
    // peer was alive, and a missing one is not a reason to close (the TCP layer reports that).
    this.pingTimer = setInterval(() => this.ping(), PING_MS);
    if (typeof this.pingTimer.unref === "function") this.pingTimer.unref();
  }

  send(value) {
    this._frame(0x1, Buffer.from(JSON.stringify(value)));
  }

  ping() {
    if (this.closed) return;
    this._frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this._frame(0x8, payload);
    } catch {
      /* The socket may already be gone. */
    }
    this.socket.end();
    this._shut();
  }

  _shut() {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.onclose();
  }

  _frame(opcode, payload) {
    if (this.closed) return;
    const n = payload.length;
    let header;
    if (n < 126) {
      header = Buffer.from([0x80 | opcode, n]);
    } else if (n < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(n, 2);
    } else {
      // The 64-bit length form. Before this, every state message of 64 KB or more hit an
      // `else { return; }` here and vanished with no error: that is the silent drop the live
      // build showed. Writing the length is the whole fix.
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(n / 0x100000000), 2);
      header.writeUInt32BE(n >>> 0, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // A client message is an order, never a board: anything past this is a bug or an attack.
    if (this.buf.length > 1024 * 1024) {
      console.error("ws: peer buffer over 1 MB, closing");
      this.close(1009);
      return;
    }
    while (this.buf.length >= 2) {
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const high = this.buf.readUInt32BE(2);
        const low = this.buf.readUInt32BE(6);
        if (high !== 0) {
          this.close(1009);
          return;
        }
        len = low;
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4];
        payload = copy;
      }
      this.buf = this.buf.subarray(offset + maskLen + len);
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        // Answer a ping with its own payload, as the protocol says.
        this._frame(0xa, Buffer.from(payload));
        continue;
      }
      if (opcode === 0xa) continue; // a pong; nothing to do
      if (opcode === 0x0) {
        // A continuation frame. Before this it was ignored outright, so a fragmented order was
        // half-parsed and then dropped.
        if (!this.fragment) continue;
        this.fragment = Buffer.concat([this.fragment, payload]);
        if (fin) {
          const whole = this.fragment;
          const kind = this.fragmentOp;
          this.fragment = null;
          if (kind === 0x1) this.ontext(whole.toString("utf8"));
        }
        continue;
      }
      if (opcode === 0x1) {
        if (fin) this.ontext(payload.toString("utf8"));
        else {
          this.fragmentOp = opcode;
          this.fragment = Buffer.from(payload);
        }
      }
    }
  }
}
