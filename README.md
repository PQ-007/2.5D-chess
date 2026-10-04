# 3D Chess — online multiplayer

3D chess in the browser with [Three.js](https://threejs.org), using Polyfjord's chess set.
One player creates a room and shares the invite link; the second player joins as the opponent,
and anyone after that watches.

- Server-authoritative rules (via [chess.js](https://github.com/jhlywa/chess.js)): legal moves, check,
  checkmate, stalemate, repetition, 50-move rule, promotion
- Rooms with 5-letter codes and invite links (`?room=CODE`)
- Reconnect to your seat after a refresh or dropped connection
- Resign, draw offers, rematch (colors swap), spectators, chat
- Orbit (drag) and zoom (scroll / pinch) the camera; pieces slide, knights hop, captures fade
- Legal-move dots, last-move / check / selection highlights, real-time shadows
- Minimal monochrome UI with light and dark themes; works on phones

## Run it

```bash
npm install
npm start          # http://localhost:3000  (set PORT to change)
npm test
```

Open two browser windows (or send the invite link to a friend) to play.
To play over the internet, deploy to any Node host (Render, Railway, Fly.io, a VPS…) —
it's a single process that serves the page and the Socket.IO websocket.

## The 3D models

`public/models/chess_set.glb` is converted from `Polyfjord_Chess_Set.blend` by
`tools/export_chess_set.py`. The script:

- keeps one model per piece type (`wK wQ wR wB wN wP bK … bP`) plus the `Board`,
- centres each piece's base on the origin,
- rebuilds the set's legacy Diffuse + Glossy shaders as glTF-compatible PBR materials,
- applies the modifiers (edge split, auto-smooth, bevel).

To re-export after editing the `.blend`:

```bash
blender -b -P tools/export_chess_set.py -- path/to/Polyfjord_Chess_Set.blend
# or without a Blender install (Python 3.11):
pip install bpy==4.2.0 && python tools/export_chess_set.py path/to/Polyfjord_Chess_Set.blend
```

The board is 20 × 20 units (2.5-unit squares). The pieces are sculpted to be seen from the
front (their backs are hollow), so the renderer turns them to face the camera.

The chess set is Polyfjord's work. Check its license before publishing a hosted copy.

## Project layout

```
server.js               Express + Socket.IO server
src/rooms.js            Room/game logic (seats, moves, draw, resign, rematch), transport-independent
public/index.html       Lobby + game UI
public/js/main.js       Client networking and input
public/js/renderer3d.js Three.js scene: board, pieces, highlights, animation, picking
public/models/          chess_set.glb
tools/                  Blender → glTF export script
test/                   Unit tests for room logic
```
