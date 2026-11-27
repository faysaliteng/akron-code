/**
 * Optional native messaging host. Chrome starts this process when the
 * extension connects. A local client can then call browser tools.
 *
 * Protocol on 127.0.0.1:47331, one JSON object per line:
 *   {"id":"1","method":"tools/list"}
 *   {"id":"2","method":"tools/call","name":"list_tabs","input":{}}
 */
import { createServer } from "node:net";
import { checkUpdateCli, runSelfUpdate } from "../tools/update.mjs";

const pending = new Map();

export function encodeNative(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function takeNativeMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length < 0 || length > 10_000_000 || buffer.length - offset - 4 < length) break;
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString("utf8")));
    offset += 4 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

function askExtension(message, send) {
  return new Promise((resolve) => {
    pending.set(message.id, resolve);
    send(message);
  });
}

export function deliverHostMessage(message) {
  const waiter = pending.get(message?.id);
  if (!waiter) return false;
  pending.delete(message.id);
  waiter(message);
  return true;
}

export function startRelay(send, port = 47331) {
  return createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.method === "tools/list") {
          const response = await askExtension({ id: request.id, type: "list_tools" }, send);
          socket.write(`${JSON.stringify({ id: request.id, tools: response.tools || [] })}\n`);
        } else if (request.method === "tools/call") {
          const response = await askExtension(
            { id: request.id, type: "call_tool", name: request.name, input: request.input || {} },
            send
          );
          socket.write(`${JSON.stringify({ id: request.id, result: response.result })}\n`);
        } else if (request.method === "updater/check") {
          const result = await checkUpdateCli({ channel: request.channel, token: request.token, baseUrl: request.baseUrl });
          socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
        } else if (request.method === "updater/apply") {
          const result = await runSelfUpdate({ channel: request.channel, token: request.token, baseUrl: request.baseUrl });
          socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
        } else {
          socket.write(`${JSON.stringify({ id: request.id, error: "Unknown method" })}\n`);
        }
      }
    });
  }).listen(port, "127.0.0.1");
}

const direct = process.argv[1] && process.argv[1].endsWith("host.mjs");
if (direct) {
  let incoming = Buffer.alloc(0);
  const send = (message) => process.stdout.write(encodeNative(message));
  startRelay(send);
  process.stdin.on("data", async (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    const parsed = takeNativeMessages(incoming);
    incoming = Buffer.from(parsed.rest);
    for (const message of parsed.messages) {
      if (message?.type === "check_updates") {
        try {
          const result = await checkUpdateCli({ repo: message.repo, channel: message.channel, token: message.token, baseUrl: message.baseUrl });
          send({ id: message.id, kind: "update_result", ...result });
        } catch (e) {
          send({ id: message.id, kind: "update_result", ok: false, error: String(e?.message || e) });
        }
      } else if (message?.type === "apply_extension_update") {
        try {
          const result = await runSelfUpdate({ repo: message.repo, channel: message.channel, token: message.token, baseUrl: message.baseUrl });
          send({ id: message.id, kind: "update_result", ...result });
        } catch (e) {
          send({ id: message.id, kind: "update_result", ok: false, error: String(e?.message || e) });
        }
      } else {
        deliverHostMessage(message);
      }
    }
  });
}
