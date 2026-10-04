# 2.5D Chess — online multiplayer

Isometric (2.5D) chess you play with a friend in the browser. One player creates a room and
shares the invite link; the second player joins as the opponent, and anyone after that watches.

- Server-authoritative rules (via [chess.js](https://github.com/jhlywa/chess.js)): legal moves, check,
  checkmate, stalemate, repetition, 50-move rule, promotion
- Rooms with 5-letter codes and invite links (`?room=CODE`)
- Reconnect to your seat after a refresh or dropped connection
- Resign, draw offers, rematch (colors swap), spectators, chat
- Sprite-based 2.5D renderer: drop in your asset pack, no code changes

## Run it

```bash
npm install
npm start          # http://localhost:3000  (set PORT to change)
npm test
```

Open two browser windows (or send the invite link to a friend) to play.
To play over the internet, deploy to any Node host (Render, Railway, Fly.io, a VPS…) —
it's a single process that serves the page and the Socket.IO websocket.

## Using your asset pack (fjoufold 2.5D chess)

Until sprites are added the game draws placeholder pieces. To use your art:

1. Copy the PNGs into `public/assets/` (e.g. `public/assets/pieces/`, `public/assets/tiles/`).
2. Fill in the file names in `public/assets/manifest.json` (paths are relative to `public/assets/`):

```jsonc
{
  "projection": "iso",          // "iso" = diamond board, "oblique" = straight board seen from the front
  "tileWidth": 64,              // width of one board tile's top face, in sprite pixels
  "tileHeight": 32,             // height of one tile's top face (iso: usually tileWidth / 2)
  "tileOffset": { "x": 0, "y": 0 },      // nudge tile sprites if they don't line up
  "pieceAnchor": { "x": 0.5, "y": 0.9 }, // point of the piece image (0–1) that stands on the tile centre
  "pieceOffset": { "x": 0, "y": 0 },     // extra pixel nudge for pieces
  "pieceHeadroom": 72,          // space above the board so tall back-row pieces aren't clipped
  "pixelArt": true,             // nearest-neighbour scaling for crisp pixels
  "tiles":  { "light": "tiles/light.png", "dark": "tiles/dark.png" },
  "board":  "",                 // OR one whole-board image instead of per-tile sprites
  "pieces": {
    "wK": "pieces/white_king.png", "wQ": "...", "wR": "...", "wB": "...", "wN": "...", "wP": "...",
    "bK": "pieces/black_king.png", "bQ": "...", "bR": "...", "bB": "...", "bN": "...", "bP": "..."
  }
}
```

3. Reload. Any sprite that fails to load falls back to the placeholder and logs a warning in the
   browser console, so you can fill them in one at a time.

Tuning tips:
- Tiles are placed with their **top-centre** on the cell's top corner (iso) or their **top-left**
  on the cell's top-left (oblique). Set `tileWidth`/`tileHeight` to the size of the tile's top
  face, not the full image (side faces can hang below).
- If pieces float or sink, adjust `pieceAnchor.y` (closer to 1 = the base is near the bottom of the image).
- One image per piece is enough; the board flips for the black player by rearranging squares,
  so pieces always face the camera.

## Project layout

```
server.js             Express + Socket.IO server
src/rooms.js          Room/game logic (seats, moves, draw, resign, rematch) — transport-independent
public/index.html     Lobby + game UI
public/js/main.js     Client networking and input
public/js/renderer.js 2.5D canvas renderer driven by assets/manifest.json
public/assets/        Your sprites + manifest.json
test/                 Unit tests for room logic
```
