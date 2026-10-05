import fs from 'node:fs';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

if (process.env.FAKE_CODEX_PID_FILE) fs.writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));
// FAKE_CODEX_LINGER=1 plays a proxy that outlives its stdin and its daemon, so only a tree kill ends it; it still exits after a minute.
const linger = process.env.FAKE_CODEX_LINGER === '1';
if (linger) setTimeout(() => process.exit(0), 60_000);
const exit = (code) => {
  if (!linger) process.exit(code);
};

const control = new WebSocket(process.env.FAKE_CODEX_CONTROL);
const socket = new Duplex({
  read() {},
  write(chunk, _encoding, callback) { process.stdout.write(chunk, callback); },
  final(callback) { callback(); },
});
Object.assign(socket, {
  setTimeout() { return socket; },
  setNoDelay() { return socket; },
  setKeepAlive() { return socket; },
  ref() {},
  unref() {},
  remoteAddress: '127.0.0.1',
});
process.stdin.on('data', (d) => socket.push(d));
process.stdin.on('end', () => exit(0));

const wss = new WebSocketServer({ noServer: true });
const server = http.createServer();
server.on('upgrade', (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.on('message', (d) => control.send(String(d)));
    control.on('message', (d) => ws.send(String(d)));
  });
});
control.on('open', () => server.emit('connection', socket));
control.on('close', () => exit(0));
control.on('error', () => exit(1));
