// Game rooms: authoritative chess state per room, independent of the transport.
const crypto = require('crypto');
const { Chess } = require('chess.js');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const COLORS = ['w', 'b'];

function randomCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

function cleanName(name, fallback) {
  const n = String(name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 20);
  return n || fallback;
}

class GameRoom {
  constructor(code) {
    this.code = code;
    this.chess = new Chess();
    this.seats = { w: null, b: null }; // { token, name, socketId }
    this.spectators = new Set(); // socket ids
    this.result = null; // { winner: 'w'|'b'|null, reason }
    this.drawOffer = null; // color that offered
    this.rematch = new Set(); // colors that want a rematch
    this.lastMove = null;
    this.updatedAt = Date.now();
  }

  // Seat a player. Reuses a seat when the token matches (reconnect),
  // otherwise takes a free seat, otherwise joins as spectator.
  join(socketId, { name, token, preferColor } = {}) {
    for (const c of COLORS) {
      const seat = this.seats[c];
      if (seat && token && seat.token === token) {
        seat.socketId = socketId;
        if (name) seat.name = cleanName(name, seat.name);
        return { role: c, token: seat.token };
      }
    }
    const order = preferColor === 'b' ? ['b', 'w'] : ['w', 'b'];
    const free = order.filter((c) => !this.seats[c]);
    if (free.length) {
      const c = preferColor === 'random' && free.length === 2 ? free[crypto.randomInt(2)] : free[0];
      const newToken = crypto.randomBytes(16).toString('hex');
      this.seats[c] = { token: newToken, name: cleanName(name, c === 'w' ? 'White' : 'Black'), socketId };
      return { role: c, token: newToken };
    }
    this.spectators.add(socketId);
    return { role: 'spectator', token: null };
  }

  // Socket left. Seats are kept so the player can reconnect.
  leave(socketId) {
    this.spectators.delete(socketId);
    for (const c of COLORS) {
      if (this.seats[c] && this.seats[c].socketId === socketId) this.seats[c].socketId = null;
    }
  }

  colorOf(socketId) {
    return COLORS.find((c) => this.seats[c] && this.seats[c].socketId === socketId) || null;
  }

  isEmpty() {
    return this.spectators.size === 0 && COLORS.every((c) => !this.seats[c] || !this.seats[c].socketId);
  }

  move(socketId, { from, to, promotion } = {}) {
    const color = this.colorOf(socketId);
    if (!color) return { error: 'You are not playing in this game.' };
    if (this.result) return { error: 'The game is over.' };
    if (!this.seats.w || !this.seats.b) return { error: 'Waiting for an opponent.' };
    if (this.chess.turn() !== color) return { error: 'Not your turn.' };
    let mv;
    try {
      mv = this.chess.move({ from, to, promotion: promotion || 'q' });
    } catch {
      return { error: 'Illegal move.' };
    }
    this.lastMove = { from: mv.from, to: mv.to, san: mv.san };
    this.drawOffer = null;
    this.updatedAt = Date.now();
    this._checkGameOver();
    return { ok: true, move: mv };
  }

  _checkGameOver() {
    const c = this.chess;
    if (!c.isGameOver()) return;
    if (c.isCheckmate()) this.result = { winner: c.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' };
    else if (c.isStalemate()) this.result = { winner: null, reason: 'stalemate' };
    else if (c.isThreefoldRepetition()) this.result = { winner: null, reason: 'threefold repetition' };
    else if (c.isInsufficientMaterial()) this.result = { winner: null, reason: 'insufficient material' };
    else this.result = { winner: null, reason: '50-move rule' };
  }

  resign(socketId) {
    const color = this.colorOf(socketId);
    if (!color || this.result) return { error: 'Cannot resign now.' };
    this.result = { winner: color === 'w' ? 'b' : 'w', reason: 'resignation' };
    return { ok: true };
  }

  offerDraw(socketId) {
    const color = this.colorOf(socketId);
    if (!color || this.result) return { error: 'Cannot offer a draw now.' };
    if (this.drawOffer && this.drawOffer !== color) {
      this.result = { winner: null, reason: 'agreement' };
      this.drawOffer = null;
    } else {
      this.drawOffer = color;
    }
    return { ok: true };
  }

  declineDraw(socketId) {
    const color = this.colorOf(socketId);
    if (!color || !this.drawOffer || this.drawOffer === color) return { error: 'No draw offer to decline.' };
    this.drawOffer = null;
    return { ok: true };
  }

  requestRematch(socketId) {
    const color = this.colorOf(socketId);
    if (!color || !this.result) return { error: 'Rematch is only available after the game.' };
    this.rematch.add(color);
    if (this.rematch.size === 2) {
      // Swap colors for the new game.
      this.seats = { w: this.seats.b, b: this.seats.w };
      this.chess = new Chess();
      this.result = null;
      this.drawOffer = null;
      this.lastMove = null;
      this.rematch.clear();
      return { ok: true, restarted: true };
    }
    return { ok: true };
  }

  state() {
    const c = this.chess;
    const seat = (s) => (s ? { name: s.name, online: !!s.socketId } : null);
    return {
      code: this.code,
      fen: c.fen(),
      turn: c.turn(),
      inCheck: c.inCheck(),
      history: c.history(),
      lastMove: this.lastMove,
      players: { w: seat(this.seats.w), b: seat(this.seats.b) },
      spectators: this.spectators.size,
      result: this.result,
      drawOffer: this.drawOffer,
      rematch: [...this.rematch],
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    let code;
    do code = randomCode(); while (this.rooms.has(code));
    const room = new GameRoom(code);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase().trim());
  }

  // Drop rooms nobody is connected to after `idleMs`.
  sweep(idleMs = 60 * 60 * 1000) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && now - room.updatedAt > idleMs) this.rooms.delete(code);
    }
  }
}

module.exports = { GameRoom, RoomManager };
