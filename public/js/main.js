import { Chess } from '/vendor/chess/chess.js';
import { BoardRenderer, loadChessSet } from './renderer3d.js';

const $ = (id) => document.getElementById(id);
const socket = io();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

let renderer = null;
let role = null; // 'w' | 'b' | 'spectator'
let roomCode = null;
let state = null;
let chess = new Chess();

$('name').value = store.get('chess25d:name') || '';
$('create').disabled = $('join').disabled = true; // until the 3D models are loaded
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) $('code').value = urlCode.toUpperCase();

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

function entered(res) {
  if (res.error) {
    $('lobby-error').textContent = res.error;
    return;
  }
  role = res.role;
  roomCode = res.code;
  if (res.token) store.set(`chess25d:token:${roomCode}`, res.token);
  history.replaceState(null, '', `?room=${roomCode}`);
  $('lobby').hidden = true;
  $('game').hidden = false;
  $('room-code').textContent = roomCode;
  renderer.flipped = role === 'b';
  renderer.resize();
}

function join(code) {
  const name = $('name').value.trim();
  store.set('chess25d:name', name);
  const token = store.get(`chess25d:token:${code.toUpperCase()}`);
  socket.emit('join', { code, name, token }, entered);
}

$('create').onclick = () => {
  const name = $('name').value.trim();
  store.set('chess25d:name', name);
  socket.emit('create', { name, preferColor: $('color').value }, entered);
};
$('join').onclick = () => join($('code').value);
$('code').addEventListener('keydown', (e) => e.key === 'Enter' && join($('code').value));

// Re-attach to the same seat after a dropped connection.
socket.on('connect', () => { if (roomCode) join(roomCode); });

socket.on('state', (s) => {
  const prev = state;
  state = s;
  chess = new Chess(s.fen);
  renderer.board = chess.board();
  renderer.lastMove = s.lastMove;
  renderer.checkSquare = s.inCheck ? findKing(s.turn) : null;
  clearSelection();
  renderPanel();
});

socket.on('role', (c) => {
  role = c;
  renderer.flipped = role === 'b';
  toast('Rematch! Colors swapped.');
});

socket.on('chat', ({ name, text }) => {
  const line = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = name + ': ';
  line.append(b, text);
  $('chat-log').append(line);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
});

function findKing(color) {
  for (const row of chess.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

const COLOR_NAME = { w: 'White', b: 'Black' };

function renderPanel() {
  const s = state;
  const bottom = role === 'b' ? 'b' : 'w';
  const top = bottom === 'w' ? 'b' : 'w';
  for (const [el, c] of [[$('player-top'), top], [$('player-bottom'), bottom]]) {
    const p = s.players[c];
    el.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'dot' + (p && p.online ? ' on' : '');
    el.append(dot, `${p ? p.name : 'Waiting for player…'} (${COLOR_NAME[c]})${c === role ? ' — you' : ''}`);
    el.classList.toggle('turn', !s.result && s.turn === c);
  }

  let status;
  if (s.result) {
    status = s.result.winner ? `${COLOR_NAME[s.result.winner]} wins by ${s.result.reason}.` : `Draw by ${s.result.reason}.`;
  } else if (!s.players.w || !s.players.b) {
    status = 'Waiting for an opponent — share the invite link.';
  } else {
    status = `${COLOR_NAME[s.turn]} to move${s.inCheck ? ' — check!' : ''}`;
    if (s.drawOffer && s.drawOffer !== role && role !== 'spectator') status += ` · ${COLOR_NAME[s.drawOffer]} offers a draw`;
  }
  if (s.spectators) status += ` · ${s.spectators} watching`;
  $('status').textContent = status;

  const playing = role === 'w' || role === 'b';
  const live = playing && !s.result && s.players.w && s.players.b;
  $('resign').hidden = !playing || !!s.result;
  $('draw').hidden = !playing || !!s.result;
  $('draw').disabled = !live || s.drawOffer === role;
  $('draw').textContent = s.drawOffer && s.drawOffer !== role ? 'Accept draw' : s.drawOffer === role ? 'Draw offered' : 'Offer draw';
  $('resign').disabled = !live;
  $('rematch').hidden = !playing || !s.result;
  $('rematch').disabled = s.rematch.includes(role);
  $('rematch').textContent = s.rematch.includes(role) ? 'Waiting for opponent…' : s.rematch.length ? 'Accept rematch' : 'Rematch';

  const moves = $('moves');
  moves.innerHTML = '';
  for (let i = 0; i < s.history.length; i += 2) {
    const li = document.createElement('li');
    for (const san of s.history.slice(i, i + 2)) {
      const span = document.createElement('span');
      span.textContent = san;
      li.append(span);
    }
    moves.append(li);
  }
  moves.scrollTop = moves.scrollHeight;
}

// --- Board interaction -------------------------------------------------------

function clearSelection() {
  renderer.selected = null;
  renderer.targets = [];
}

function canMove() {
  return state && !state.result && state.players.w && state.players.b && role === state.turn;
}

function onBoardClick(evt) {
  if (!canMove()) return;
  const sq = renderer.pick(evt);
  if (!sq) return clearSelection();
  const piece = chess.get(sq);
  if (renderer.selected && renderer.targets.includes(sq)) {
    const from = renderer.selected;
    const isPromo = chess.moves({ square: from, verbose: true }).some((m) => m.to === sq && m.promotion);
    clearSelection();
    if (isPromo) choosePromotion(role).then((promotion) => sendMove(from, sq, promotion));
    else sendMove(from, sq);
    return;
  }
  if (piece && piece.color === role) {
    renderer.selected = sq;
    renderer.targets = [...new Set(chess.moves({ square: sq, verbose: true }).map((m) => m.to))];
  } else {
    clearSelection();
  }
}

function sendMove(from, to, promotion) {
  socket.emit('move', { from, to, promotion }, (res) => res.error && toast(res.error));
}

function choosePromotion(color) {
  return new Promise((resolve) => {
    const box = $('promo-choices');
    box.innerHTML = '';
    const glyphs = color === 'w' ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
    for (const [p, g] of Object.entries(glyphs)) {
      const btn = document.createElement('button');
      btn.textContent = g;
      btn.onclick = () => { $('promo').hidden = true; resolve(p); };
      box.append(btn);
    }
    $('promo').hidden = false;
  });
}

// --- Buttons & chat ----------------------------------------------------------

const act = (name) => () => socket.emit(name, (res) => res && res.error && toast(res.error));
$('resign').onclick = () => confirm('Resign this game?') && act('resign')();
$('draw').onclick = act('offerDraw');
$('rematch').onclick = act('requestRematch');
$('flip').onclick = () => { renderer.flipped = !renderer.flipped; clearSelection(); };
$('copy-link').onclick = async () => {
  const link = `${location.origin}${location.pathname}?room=${roomCode}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { prompt('Invite link:', link); }
};
$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('chat-input');
  if (input.value.trim()) socket.emit('chat', input.value);
  input.value = '';
};

// --- Boot --------------------------------------------------------------------

const set = await loadChessSet('models/chess_set.glb', (f) => { $('loading').textContent = `Loading chess set… ${Math.round(f * 100)}%`; });
$('loading').hidden = true;
$('create').disabled = $('join').disabled = false;
renderer = new BoardRenderer($('board'), set);
renderer.board = chess.board();
window.__r = renderer; // handy for debugging / automated tests
const canvas = $('board');
// Dragging orbits the camera; only a short tap/click selects a square.
let down = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) onBoardClick(e);
  down = null;
});
canvas.addEventListener('pointermove', (e) => { renderer.hover = canMove() ? renderer.pick(e) : null; });
canvas.addEventListener('pointerleave', () => { renderer.hover = null; });
new ResizeObserver(() => renderer.resize()).observe($('board-wrap'));
if (urlCode) join(urlCode);
