import { Chess } from '/vendor/chess/chess.js';
import { BoardRenderer, loadChessSet } from './renderer3d.js';

const $ = (id) => document.getElementById(id);
const socket = io();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const COLOR_NAME = { w: 'White', b: 'Black' };
const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const REASON = {
  checkmate: 'Checkmate', resignation: 'By resignation', stalemate: 'Stalemate', agreement: 'By agreement',
  'threefold repetition': 'Threefold repetition', 'insufficient material': 'Insufficient material', '50-move rule': '50-move rule',
};

let renderer = null;
let role = null; // 'w' | 'b' | 'spectator'
let roomCode = null;
let state = null;
let chess = new Chess();
let prefColor = 'random';
let resultDismissed = false;

const inviteLink = () => `${location.origin}${location.pathname}?room=${roomCode}`;
const isPlayer = () => role === 'w' || role === 'b';

// --- Lobby -------------------------------------------------------------------

$('name').value = store.get('chess:name') || '';
$('create').disabled = $('join').disabled = true; // until the 3D models are loaded
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) $('code').value = urlCode.toUpperCase();

for (const btn of $('color').children) {
  btn.onclick = () => {
    prefColor = btn.dataset.v;
    for (const b of $('color').children) {
      b.classList.toggle('on', b === btn);
      b.setAttribute('aria-checked', b === btn);
    }
  };
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = true;
  void t.offsetWidth; // restart the entry animation
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function saveName() {
  const name = $('name').value.trim();
  store.set('chess:name', name);
  return name;
}

function join(code) {
  code = code.trim().toUpperCase();
  if (!code) return $('code').focus();
  const token = store.get(`chess:token:${code}`);
  socket.emit('join', { code, name: saveName(), token }, entered);
}

$('create').onclick = () => socket.emit('create', { name: saveName(), preferColor: prefColor }, entered);
$('join-form').onsubmit = (e) => { e.preventDefault(); join($('code').value); };
$('code').oninput = () => { $('lobby-error').textContent = ''; };

function entered(res) {
  if (res.error) {
    $('lobby-error').textContent = res.error;
    return;
  }
  const first = roomCode === null;
  role = res.role;
  roomCode = res.code;
  if (res.token) store.set(`chess:token:${roomCode}`, res.token);
  history.replaceState(null, '', `?room=${roomCode}`);
  document.body.classList.replace('in-lobby', 'in-game');
  $('lobby').hidden = true;
  $('topbar').hidden = $('panel').hidden = false;
  $('room-code').textContent = roomCode;
  $('invite-code').textContent = roomCode;
  $('invite-link').value = inviteLink();
  if (first) {
    renderer.idle = false;
    renderer.flipped = role === 'b';
    renderer.resetView();
    $('hint').hidden = false;
  }
}

// Re-attach to the same seat after a dropped connection.
socket.on('connect', () => { if (roomCode) join(roomCode); });

// --- Game state --------------------------------------------------------------

socket.on('state', (s) => {
  const prev = state;
  state = s;
  chess = new Chess(s.fen);
  renderer.board = chess.board();
  renderer.lastMove = s.lastMove;
  renderer.checkSquare = s.inCheck ? findKing(s.turn) : null;
  if (!s.result || (prev && !prev.result)) resultDismissed = false;
  clearSelection();
  render();
});

socket.on('role', (c) => {
  role = c;
  renderer.flipped = role === 'b';
  toast(`New game — you play ${COLOR_NAME[c].toLowerCase()}`);
});

socket.on('chat', ({ name, color, text }) => {
  const msg = document.createElement('div');
  msg.className = 'msg' + (isPlayer() && color === role ? ' mine' : '');
  const who = document.createElement('small');
  who.textContent = name;
  msg.append(who, text);
  $('chat-log').append(msg);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  if ($('tab-chat').hidden && !msg.classList.contains('mine')) $('chat-badge').hidden = false;
});

function findKing(color) {
  for (const row of chess.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

// Pieces each side has captured, and the material balance.
function captures() {
  const left = { w: { ...START, k: 0 }, b: { ...START, k: 0 } };
  for (const row of chess.board()) for (const p of row) if (p && p.type !== 'k') left[p.color][p.type]--;
  const out = {};
  for (const c of ['w', 'b']) {
    const victim = c === 'w' ? 'b' : 'w';
    const list = [];
    let points = 0;
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const n = Math.max(left[victim][t], 0);
      for (let i = 0; i < n; i++) list.push(GLYPH[t]);
      points += n * VALUE[t];
    }
    out[c] = { list, points };
  }
  return out;
}

function renderPlayer(el, c, caps) {
  const s = state;
  const p = s.players[c];
  el.classList.toggle('turn', !s.result && !!s.players.w && !!s.players.b && s.turn === c);
  el.innerHTML = `
    <div class="avatar ${c}"><span class="dot${p && p.online ? ' on' : ''}"></span></div>
    <div class="who"><div class="name"></div><div class="caps"></div></div>
    <span class="turn-dot"></span>`;
  const name = el.querySelector('.name');
  name.textContent = p ? p.name : 'Waiting…';
  if (c === role) name.insertAdjacentHTML('beforeend', '<em>you</em>');
  else if (p && !p.online) name.insertAdjacentHTML('beforeend', '<em>offline</em>');
  const capEl = el.querySelector('.caps');
  const other = c === 'w' ? 'b' : 'w';
  capEl.textContent = caps[c].list.join('');
  const lead = caps[c].points - caps[other].points;
  if (lead > 0) capEl.insertAdjacentHTML('beforeend', `<b>+${lead}</b>`);
}

function render() {
  const s = state;
  const ready = !!(s.players.w && s.players.b);
  const caps = captures();
  const bottom = role === 'b' ? 'b' : 'w';
  renderPlayer($('player-bottom'), bottom, caps);
  renderPlayer($('player-top'), bottom === 'w' ? 'b' : 'w', caps);

  // Status pill
  const pill = $('status');
  let text;
  pill.className = 'pill';
  if (s.result) {
    text = 'Game over';
  } else if (!ready) {
    text = 'Waiting for opponent';
  } else if (role === s.turn) {
    text = s.inCheck ? 'Check — your move' : 'Your move';
    pill.classList.add(s.inCheck ? 'alert' : 'you');
  } else {
    const p = s.players[s.turn];
    text = isPlayer() ? `${p.name} is thinking…` : `${COLOR_NAME[s.turn]} to move`;
    if (s.inCheck) text = 'Check · ' + text;
  }
  if (s.spectators) text += ` · ${s.spectators} watching`;
  pill.textContent = text;
  pill.style.cursor = s.result ? 'pointer' : '';

  // Moves
  const moves = $('moves');
  moves.innerHTML = '';
  s.history.forEach((san, i) => {
    if (i % 2 === 0) moves.insertAdjacentHTML('beforeend', `<li class="n">${i / 2 + 1}.</li>`);
    const li = document.createElement('li');
    li.className = 'm' + (i === s.history.length - 1 ? ' last' : '');
    li.textContent = san;
    moves.append(li);
  });
  $('moves-empty').hidden = s.history.length > 0;
  moves.scrollTop = moves.scrollHeight;

  // Actions
  const live = isPlayer() && !s.result && ready;
  $('draw').hidden = $('resign').hidden = !isPlayer();
  $('draw').disabled = !live || s.drawOffer === role;
  $('draw').classList.toggle('pending', s.drawOffer === role);
  $('draw').title = s.drawOffer === role ? 'Draw offered' : 'Offer draw';
  $('resign').disabled = !live;
  if (!live) disarmResign();
  $('offer').hidden = !(live && s.drawOffer && s.drawOffer !== role);

  // Invite card: only while a player waits for an opponent.
  $('invite').hidden = !(isPlayer() && !ready && !s.result);

  // Result card
  $('result').hidden = !s.result || resultDismissed;
  if (s.result) {
    const { winner, reason } = s.result;
    $('result-reason').textContent = REASON[reason] || reason;
    $('result-title').textContent = !winner ? 'Draw'
      : isPlayer() ? (winner === role ? 'You won' : 'You lost')
        : `${COLOR_NAME[winner]} wins`;
    const mine = s.rematch.includes(role);
    $('rematch').hidden = !isPlayer();
    $('rematch').disabled = mine;
    $('rematch').textContent = mine ? 'Waiting…' : s.rematch.length ? 'Accept rematch' : 'Rematch';
  }
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
  if (piece && piece.color === role && sq !== renderer.selected) {
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

// --- Controls ----------------------------------------------------------------

const act = (name) => () => socket.emit(name, (res) => res && res.error && toast(res.error));

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast('Invite link copied');
  } catch {
    $('invite-link').select();
    toast('Press Ctrl+C to copy');
  }
}

function disarmResign() {
  $('resign').classList.remove('arm');
  clearTimeout(disarmResign.timer);
}
$('resign').onclick = () => {
  if ($('resign').classList.contains('arm')) {
    disarmResign();
    act('resign')();
    return;
  }
  $('resign').classList.add('arm');
  disarmResign.timer = setTimeout(disarmResign, 4000);
};

$('draw').onclick = act('offerDraw');
$('accept-draw').onclick = act('offerDraw');
$('decline-draw').onclick = act('declineDraw');
$('rematch').onclick = act('requestRematch');
$('new-game').onclick = () => { location.href = location.pathname; };
$('leave').onclick = () => { location.href = location.pathname; };
$('result-close').onclick = () => { resultDismissed = true; render(); };
$('status').onclick = () => { if (state && state.result) { resultDismissed = false; render(); } };
$('flip').onclick = () => { renderer.flipped = !renderer.flipped; clearSelection(); };
$('room').onclick = copyInvite;
$('copy-invite').onclick = copyInvite;

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.tabs button')) t.classList.toggle('on', t === tab);
    $('tab-moves').hidden = tab.dataset.tab !== 'moves';
    $('tab-chat').hidden = tab.dataset.tab !== 'chat';
    if (tab.dataset.tab === 'chat') {
      $('chat-badge').hidden = true;
      $('chat-input').focus();
    }
  };
}

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('chat-input');
  if (input.value.trim()) socket.emit('chat', input.value);
  input.value = '';
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearSelection();
    disarmResign();
  }
});

// --- Boot --------------------------------------------------------------------

const set = await loadChessSet('models/chess_set.glb', (f) => { $('loading').textContent = `Loading pieces… ${Math.round(f * 100)}%`; });
$('loading').hidden = true;
$('create').disabled = $('join').disabled = false;
renderer = new BoardRenderer($('board'), set);
renderer.board = chess.board();
renderer.idle = true;
window.__r = renderer; // handy for debugging / automated tests

const canvas = $('board');
// Dragging orbits the camera; only a short tap/click selects a square.
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
  $('hint').style.opacity = 0;
});
canvas.addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) onBoardClick(e);
  down = null;
});
canvas.addEventListener('pointermove', (e) => {
  const sq = canMove() ? renderer.pick(e) : null;
  renderer.hover = sq;
  const own = sq && chess.get(sq);
  canvas.style.cursor = sq && ((own && own.color === role) || renderer.targets.includes(sq)) ? 'pointer' : '';
});
canvas.addEventListener('pointerleave', () => { renderer.hover = null; });
new ResizeObserver(() => renderer.resize()).observe($('stage'));
if (urlCode) join(urlCode);
