/**
 * Reference desktop client. The extension connects outbound to this process.
 * Run: node native/bridge-client.mjs
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { BRIDGE_URL } from "../shared/bridge.js";

function accept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const acceptKey = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const length = buffer[1] & 127;
  const maskOffset = length === 126 ? 4 : 2;
  const start = maskOffset + 4;
  const size = length === 126 ? buffer.readUInt16BE(2) : length;
  if (buffer.length < start + size) return null;
  const mask = buffer.subarray(maskOffset, maskOffset + 4);
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) data[i] = buffer[start + i] ^ mask[i % 4];
  return { text: data.toString("utf8"), rest: buffer.subarray(start + size) };
}

export function listenBridge(port = 8766) {
  const sockets = new Set();
  const waiters = [];
  const inbox = [];
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    accept(req, socket);
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded = decodeFrame(buffer);
      while (decoded) {
        buffer = Buffer.from(decoded.rest);
        let message;
        try { message = JSON.parse(decoded.text); } catch { decoded = decodeFrame(buffer); continue; }
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else inbox.push(message);
        decoded = decodeFrame(buffer);
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `ws://127.0.0.1:${port}`,
        send(message) {
          const frame = encodeFrame(JSON.stringify(message));
          for (const socket of sockets) socket.write(frame);
        },
        next(timeoutMs = 4000) {
          if (inbox.length) return Promise.resolve(inbox.shift());
          return new Promise((resolveMessage, reject) => {
            const timer = setTimeout(() => reject(new Error("bridge timeout")), timeoutMs);
            waiters.push((message) => {
              clearTimeout(timer);
              resolveMessage(message);
            });
          });
        },
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("bridge-client.mjs")) {
  const bridge = await listenBridge();
  console.log(`Akron bridge listening on ${bridge.url} (same shape as ${BRIDGE_URL})`);
  bridge.send({ type: "pairing_request", request_id: "boot", client_type: "desktop" });
}
