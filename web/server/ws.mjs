import { createHash } from "node:crypto";

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.ontext = () => {};
    this.onclose = () => {};
    socket.on("data", (chunk) => this._data(chunk));
    socket.on("close", () => this._shut());
    socket.on("error", () => this._shut());
  }

  send(value) {
    this._frame(0x1, Buffer.from(JSON.stringify(value)));
  }

  close() {
    if (this.closed) return;
    try {
      this._frame(0x8, Buffer.alloc(0));
    } catch {
      /* The socket may already be gone. */
    }
    this.socket.end();
    this._shut();
  }

  _shut() {
    if (this.closed) return;
    this.closed = true;
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
      return;
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 1024 * 256) {
      this.close();
      return;
    }
    while (this.buf.length >= 2) {
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        this.close();
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (len > 65536 || this.buf.length < offset + maskLen + len) {
        if (len > 65536) this.close();
        return;
      }
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
        this._frame(0xa, Buffer.from(payload));
        continue;
      }
      if (opcode === 0x1) this.ontext(payload.toString("utf8"));
    }
  }
}
