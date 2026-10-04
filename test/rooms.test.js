const test = require('node:test');
const assert = require('node:assert');
const { RoomManager } = require('../src/rooms');

function setup() {
  const room = new RoomManager().create();
  const a = room.join('A', { name: 'Alice' });
  const b = room.join('B', { name: 'Bob' });
  return { room, a, b };
}

test('seats two players then spectators', () => {
  const { room, a, b } = setup();
  assert.equal(a.role, 'w');
  assert.equal(b.role, 'b');
  assert.equal(room.join('C').role, 'spectator');
});

test('enforces turns and legality', () => {
  const { room } = setup();
  assert.match(room.move('B', { from: 'e7', to: 'e5' }).error, /turn/);
  assert.match(room.move('A', { from: 'e2', to: 'e5' }).error, /Illegal/);
  assert.ok(room.move('A', { from: 'e2', to: 'e4' }).ok);
  assert.equal(room.state().turn, 'b');
});

test('detects checkmate', () => {
  const { room } = setup();
  for (const [s, f, t] of [['A', 'f2', 'f3'], ['B', 'e7', 'e5'], ['A', 'g2', 'g4'], ['B', 'd8', 'h4']]) {
    assert.ok(room.move(s, { from: f, to: t }).ok);
  }
  assert.deepEqual(room.result, { winner: 'b', reason: 'checkmate' });
});

test('reconnect with token reclaims seat', () => {
  const { room, a } = setup();
  room.leave('A');
  assert.equal(room.join('A2', { token: a.token }).role, 'w');
  assert.equal(room.colorOf('A2'), 'w');
});

test('draw agreement and rematch swaps colors', () => {
  const { room } = setup();
  room.offerDraw('A');
  room.offerDraw('B');
  assert.deepEqual(room.result, { winner: null, reason: 'agreement' });
  room.requestRematch('A');
  assert.ok(room.requestRematch('B').restarted);
  assert.equal(room.colorOf('A'), 'b');
  assert.equal(room.result, null);
});
