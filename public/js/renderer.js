// 2.5D board renderer. Draws tiles and pieces from the sprite manifest
// (public/assets/manifest.json) and falls back to drawn shapes for any
// sprite that is missing, so the game is playable before assets are added.

const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const HEIGHTS = { k: 1.0, q: 0.95, r: 0.7, b: 0.85, n: 0.8, p: 0.6 };

const DEFAULTS = {
  projection: 'iso', // 'iso' (diamond) or 'oblique' (front-facing, squashed)
  tileWidth: 64,
  tileHeight: 32,
  tileThickness: 8, // fallback board side depth in sprite px
  tileOffset: { x: 0, y: 0 },
  pieceAnchor: { x: 0.5, y: 0.9 }, // point in the piece image that sits on the tile centre
  pieceOffset: { x: 0, y: 0 },
  pieceHeadroom: 72, // space above the top row for tall pieces
  pixelArt: true,
  colors: {
    light: '#e8d2a6', dark: '#9b6b45', side: '#5a3a26',
    highlight: 'rgba(255,214,90,0.55)', lastMove: 'rgba(120,200,255,0.40)',
    target: 'rgba(40,40,40,0.45)', check: 'rgba(230,60,60,0.65)',
  },
};

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn(`[2.5D chess] sprite not found, using fallback: ${src}`);
      resolve(null);
    };
    img.src = src;
  });
}

export async function loadAssets(url = 'assets/manifest.json') {
  let manifest = {};
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) manifest = await res.json();
  } catch { /* no manifest: all fallbacks */ }
  const cfg = {
    ...DEFAULTS, ...manifest,
    tileOffset: { ...DEFAULTS.tileOffset, ...manifest.tileOffset },
    pieceAnchor: { ...DEFAULTS.pieceAnchor, ...manifest.pieceAnchor },
    pieceOffset: { ...DEFAULTS.pieceOffset, ...manifest.pieceOffset },
    colors: { ...DEFAULTS.colors, ...manifest.colors },
  };
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const load = async (map = {}) => {
    const out = {};
    await Promise.all(Object.entries(map).map(async ([k, file]) => {
      if (file) out[k] = await loadImage(base + file);
    }));
    return out;
  };
  const [tiles, pieces] = await Promise.all([load(manifest.tiles), load(manifest.pieces)]);
  cfg.images = { tiles, pieces, board: manifest.board ? await loadImage(base + manifest.board) : null };
  return cfg;
}

export class BoardRenderer {
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.flipped = false;
    this.board = null; // chess.js board() array
    this.selected = null;
    this.targets = [];
    this.lastMove = null;
    this.checkSquare = null;
    this.anim = null; // { piece, from, to, start, dur }
    this.hover = null;

    const tw = cfg.tileWidth, th = cfg.tileHeight;
    if (cfg.projection === 'oblique') {
      this.u = { x: tw, y: 0 };
      this.v = { x: 0, y: th };
      this.size = { w: 8 * tw, h: 8 * th };
      this.origin = { x: 0, y: cfg.pieceHeadroom };
    } else {
      this.u = { x: tw / 2, y: th / 2 };
      this.v = { x: -tw / 2, y: th / 2 };
      this.size = { w: 8 * tw, h: 8 * th };
      this.origin = { x: 4 * tw, y: cfg.pieceHeadroom };
    }
    this.size.h += cfg.pieceHeadroom + cfg.tileThickness + 4;
    const det = this.u.x * this.v.y - this.v.x * this.u.y;
    this.inv = { a: this.v.y / det, b: -this.v.x / det, c: -this.u.y / det, d: this.u.x / det };
    this.resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // Grid cell (col,row) for a square; row 0 is the far side of the board.
  cell(square) {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    return this.flipped ? { col: 7 - file, row: rank } : { col: file, row: 7 - rank };
  }

  squareAt(col, row) {
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    const file = this.flipped ? 7 - col : col;
    const rank = this.flipped ? row : 7 - row;
    return String.fromCharCode(97 + file) + (rank + 1);
  }

  // Top-left corner of a cell (in sprite px) / centre of a cell.
  corner(col, row) {
    return { x: this.origin.x + col * this.u.x + row * this.v.x, y: this.origin.y + col * this.u.y + row * this.v.y };
  }
  center(col, row) { return this.corner(col + 0.5, row + 0.5); }

  resize() {
    const wrap = this.canvas.parentElement;
    const availW = wrap.clientWidth, availH = wrap.clientHeight;
    let scale = Math.min(availW / this.size.w, availH / this.size.h);
    if (this.cfg.pixelArt && scale >= 2) scale = Math.floor(scale); // crisp integer scaling when there is room
    this.scale = Math.max(scale, 0.25);
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.round(this.size.w * this.scale), cssH = Math.round(this.size.h * this.scale);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.pxScale = this.scale * dpr;
  }

  // Map a pointer event to a square name (or null).
  pick(evt) {
    const r = this.canvas.getBoundingClientRect();
    const x = (evt.clientX - r.left) / this.scale - this.origin.x;
    const y = (evt.clientY - r.top) / this.scale - this.origin.y;
    const col = Math.floor(this.inv.a * x + this.inv.b * y);
    const row = Math.floor(this.inv.c * x + this.inv.d * y);
    return this.squareAt(col, row);
  }

  animateMove(piece, from, to) {
    this.anim = { piece, from, to, start: performance.now(), dur: 220 };
  }

  _loop(now) {
    this.draw(now);
    requestAnimationFrame(this._loop);
  }

  draw(now = performance.now()) {
    const { ctx, cfg } = this;
    ctx.setTransform(this.pxScale, 0, 0, this.pxScale, 0, 0);
    ctx.imageSmoothingEnabled = !cfg.pixelArt;
    ctx.clearRect(0, 0, this.size.w, this.size.h);

    this._drawBoard();
    if (this.lastMove) { this._fillCell(this.lastMove.from, cfg.colors.lastMove); this._fillCell(this.lastMove.to, cfg.colors.lastMove); }
    if (this.checkSquare) this._fillCell(this.checkSquare, cfg.colors.check);
    if (this.selected) this._fillCell(this.selected, cfg.colors.highlight);
    if (this.hover && this.hover !== this.selected) this._fillCell(this.hover, 'rgba(255,255,255,0.15)');
    for (const t of this.targets) this._drawTarget(t);

    if (!this.board) return;
    const anim = this.anim && now - this.anim.start < this.anim.dur ? this.anim : null;
    if (!anim) this.anim = null;
    const items = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = this.board[r][f];
        if (!p) continue;
        if (anim && p.square === anim.to) continue;
        const { col, row } = this.cell(p.square);
        items.push({ p, pos: this.center(col, row) });
      }
    }
    if (anim) {
      const t = (now - anim.start) / anim.dur;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const a = this.cell(anim.from), b = this.cell(anim.to);
      const pos = this.center(a.col + (b.col - a.col) * e, a.row + (b.row - a.row) * e);
      pos.y -= Math.sin(Math.PI * e) * cfg.tileHeight * 0.6; // little hop
      items.push({ p: anim.piece, pos, lift: true });
    }
    items.sort((i, j) => i.pos.y - j.pos.y);
    for (const it of items) this._drawPiece(it.p, it.pos);
  }

  _cellPath(col, row) {
    const { ctx } = this;
    const a = this.corner(col, row), b = this.corner(col + 1, row);
    const c = this.corner(col + 1, row + 1), d = this.corner(col, row + 1);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }

  _drawBoard() {
    const { ctx, cfg } = this;
    const imgs = cfg.images;
    if (imgs.board) {
      ctx.drawImage(imgs.board, cfg.tileOffset.x, cfg.tileOffset.y);
      return;
    }
    // Side faces (fallback thickness) along the near edges.
    if (!imgs.tiles.light && cfg.tileThickness > 0) {
      const t = cfg.tileThickness;
      const p = [this.corner(0, 8), this.corner(8, 8), this.corner(8, 0)];
      ctx.fillStyle = cfg.colors.side;
      ctx.beginPath();
      if (cfg.projection === 'oblique') {
        ctx.moveTo(p[0].x, p[0].y); ctx.lineTo(p[1].x, p[1].y); ctx.lineTo(p[1].x, p[1].y + t); ctx.lineTo(p[0].x, p[0].y + t);
      } else {
        ctx.moveTo(p[0].x, p[0].y); ctx.lineTo(p[1].x, p[1].y); ctx.lineTo(p[2].x, p[2].y);
        ctx.lineTo(p[2].x, p[2].y + t); ctx.lineTo(p[1].x, p[1].y + t); ctx.lineTo(p[0].x, p[0].y + t);
      }
      ctx.closePath();
      ctx.fill();
    }
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this.squareAt(col, row);
        const light = (sq.charCodeAt(0) - 97 + Number(sq[1])) % 2 === 1;
        const img = imgs.tiles[light ? 'light' : 'dark'];
        if (img) {
          // Tile sprite: top-centre (iso) / top-left (oblique) sits on the cell's top corner.
          const top = this.corner(col, row);
          const x = cfg.projection === 'oblique' ? top.x : top.x - img.width / 2;
          ctx.drawImage(img, Math.round(x + cfg.tileOffset.x), Math.round(top.y + cfg.tileOffset.y));
        } else {
          this._cellPath(col, row);
          ctx.fillStyle = light ? cfg.colors.light : cfg.colors.dark;
          ctx.fill();
        }
      }
    }
  }

  _fillCell(square, color) {
    const { col, row } = this.cell(square);
    this._cellPath(col, row);
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  _drawTarget(square) {
    const { ctx, cfg } = this;
    const { col, row } = this.cell(square);
    const c = this.center(col, row);
    const occupied = this.board && this.board.flat().some((p) => p && p.square === square);
    ctx.fillStyle = cfg.colors.target;
    ctx.strokeStyle = cfg.colors.target;
    ctx.lineWidth = 3;
    ctx.beginPath();
    const rx = Math.abs(this.u.x) * (occupied ? 0.75 : 0.3);
    const ry = (cfg.projection === 'oblique' ? cfg.tileHeight / 2 : cfg.tileHeight / 2) * (occupied ? 0.75 : 0.3);
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    occupied ? ctx.stroke() : ctx.fill();
  }

  _drawPiece(p, pos) {
    const { ctx, cfg } = this;
    const img = cfg.images.pieces[p.color + p.type.toUpperCase()];
    if (img) {
      const x = pos.x - img.width * cfg.pieceAnchor.x + cfg.pieceOffset.x;
      const y = pos.y - img.height * cfg.pieceAnchor.y + cfg.pieceOffset.y;
      ctx.drawImage(img, Math.round(x), Math.round(y));
      return;
    }
    // Fallback: shadow + extruded token + glyph.
    const th = cfg.tileHeight, w = Math.min(cfg.tileWidth * 0.22, th * 0.5);
    const h = th * 1.6 * HEIGHTS[p.type];
    const white = p.color === 'w';
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(pos.x, pos.y + 2, w * 1.1, w * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = white ? '#d9d4c7' : '#2b2731';
    ctx.fillRect(pos.x - w, pos.y - h, w * 2, h);
    ctx.beginPath(); ctx.ellipse(pos.x, pos.y, w, w * 0.45, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = white ? '#fbf8f0' : '#47404f';
    ctx.beginPath(); ctx.ellipse(pos.x, pos.y - h, w, w * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = white ? '#3a3340' : '#efe9dc';
    ctx.font = `${Math.round(w * 1.7)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPHS[p.type], pos.x, pos.y - h * 0.5);
  }
}
