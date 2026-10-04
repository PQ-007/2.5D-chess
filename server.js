const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./src/rooms');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/chess', express.static(path.join(__dirname, 'node_modules/chess.js/dist/esm')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three')));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server);
const rooms = new RoomManager();

function broadcast(room) {
  room.updatedAt = Date.now();
  io.to(room.code).emit('state', room.state());
}

io.on('connection', (socket) => {
  let room = null;

  const reply = (ack, payload) => typeof ack === 'function' && ack(payload);

  function enter(target, opts, ack) {
    if (room) {
      room.leave(socket.id);
      socket.leave(room.code);
      broadcast(room);
    }
    room = target;
    const seat = room.join(socket.id, opts);
    socket.join(room.code);
    reply(ack, { code: room.code, ...seat });
    broadcast(room);
  }

  socket.on('create', (opts = {}, ack) => enter(rooms.create(), opts, ack));

  socket.on('join', (opts = {}, ack) => {
    const target = rooms.get(opts.code);
    if (!target) return reply(ack, { error: 'Room not found.' });
    enter(target, opts, ack);
  });

  // Room actions: each returns { ok } or { error } and re-broadcasts on success.
  for (const action of ['move', 'resign', 'offerDraw', 'declineDraw', 'requestRematch']) {
    socket.on(action, (payload, ack) => {
      if (typeof payload === 'function') [ack, payload] = [payload, {}];
      if (!room) return reply(ack, { error: 'Not in a room.' });
      const res = room[action](socket.id, payload);
      if (res.restarted) {
        // Rematch swaps colors: tell each player their new seat.
        for (const c of ['w', 'b']) {
          const seat = room.seats[c];
          if (seat && seat.socketId) io.to(seat.socketId).emit('role', c);
        }
      }
      if (!res.error) broadcast(room);
      reply(ack, res.error ? { error: res.error } : { ok: true });
    });
  }

  socket.on('chat', (text) => {
    if (!room) return;
    const msg = String(text || '').slice(0, 200).trim();
    if (!msg) return;
    const color = room.colorOf(socket.id);
    const name = color ? room.seats[color].name : 'Spectator';
    io.to(room.code).emit('chat', { name, color, text: msg });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.leave(socket.id);
    broadcast(room);
  });
});

setInterval(() => rooms.sweep(), 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`3D chess running on http://localhost:${PORT}`));
