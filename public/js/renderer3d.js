// Three.js board renderer for the Polyfjord chess set (public/models/chess_set.glb).
// main.js drives it by setting plain fields (board, selected, targets, lastMove,
// checkSquare, hover, flipped); the render loop notices changes and updates the scene.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const SQ = 2.5; // square size in model units (board is 20 x 20)
const PIECE_KEYS = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
const COLORS = {
  selected: 0xf2c46d,
  lastMove: 0xe9d38f,
  check: 0xef4444,
  target: 0x18181b,
  hover: 0x000000,
};

export function squareToXZ(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return { x: (file - 3.5) * SQ, z: (3.5 - rank) * SQ };
}

function xzToSquare(x, z) {
  const file = Math.floor(x / SQ + 4);
  const rank = Math.floor(4 - z / SQ);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return String.fromCharCode(97 + file) + (rank + 1);
}

export async function loadChessSet(url = 'models/chess_set.glb', onProgress) {
  const gltf = await new GLTFLoader().loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
  const set = { board: gltf.scene.getObjectByName('Board'), pieces: {} };
  for (const key of PIECE_KEYS) set.pieces[key] = gltf.scene.getObjectByName(key);
  set.board.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  for (const key of PIECE_KEYS) {
    const model = set.pieces[key];
    model.position.set(0, 0, 0);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // Wrap the (scaled, sometimes rotated) model in a plain group: the group turns to
    // face the camera and holds an invisible cylinder that is easier to click than the
    // sculpted mesh.
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const hit = new THREE.Mesh(
      new THREE.CylinderGeometry(SQ * 0.38, SQ * 0.38, size.y, 12).translate(0, size.y / 2, 0),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.name = 'hitbox';
    const group = new THREE.Group();
    group.add(model, hit);
    set.pieces[key] = group;
  }
  return set;
}

export class BoardRenderer {
  constructor(canvas, set) {
    this.canvas = canvas;
    this.set = set;
    this.board = null;
    this.selected = null;
    this.targets = [];
    this.lastMove = null;
    this.checkSquare = null;
    this.hover = null;
    this.flipped = false;

    const r = (this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;

    const scene = (this.scene = new THREE.Scene());
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.6;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-8, 22, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);

    scene.add(set.board);
    const box = new THREE.Box3().setFromObject(set.board);
    this.boardTop = box.max.y;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 200);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {
      enablePan: false, enableDamping: true, minDistance: 18, maxDistance: 60,
      minPolarAngle: 0.05, maxPolarAngle: 1.3, autoRotateSpeed: 0.6,
    });
    this._placeCamera(false);

    this.pieceGroup = new THREE.Group();
    this.markGroup = new THREE.Group();
    scene.add(this.pieceGroup, this.markGroup);
    this.meshes = new Map(); // square -> piece object
    this.yaw = 0;
    this.anims = [];

    this.raycaster = new THREE.Raycaster();
    this.boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.boardTop);
    this._squareGeo = new THREE.PlaneGeometry(SQ, SQ).rotateX(-Math.PI / 2);
    this._dotGeo = new THREE.CircleGeometry(SQ * 0.16, 32).rotateX(-Math.PI / 2);
    this._ringGeo = new THREE.RingGeometry(SQ * 0.38, SQ * 0.47, 48).rotateX(-Math.PI / 2);
    this._mats = {};

    this._seen = {};
    this.resize();
    this.gl.setAnimationLoop((t) => this._frame(t));
  }

  // Camera behind the current player's pieces; animates when `animate` is true.
  _placeCamera(animate) {
    const side = this.flipped ? -1 : 1;
    const to = new THREE.Vector3(0, 30, 17 * side);
    this.controls.target.set(0, 0, 0);
    if (!animate) {
      this.camera.position.copy(to);
      this.controls.update();
      return;
    }
    // Swing around the board on the Y axis.
    const from = this.camera.position.clone();
    const a0 = Math.atan2(from.x, from.z), a1 = side > 0 ? 0 : Math.PI;
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const r0 = Math.hypot(from.x, from.z), r1 = Math.hypot(to.x, to.z);
    this.anims.push({
      camera: true, start: performance.now(), dur: 700,
      step: (e) => {
        const a = a0 + da * e, rr = r0 + (r1 - r0) * e;
        this.camera.position.set(Math.sin(a) * rr, from.y + (to.y - from.y) * e, Math.cos(a) * rr);
      },
    });
  }

  // Slowly circle the board (lobby backdrop).
  set idle(on) {
    this.controls.autoRotate = on;
    this.controls.enabled = !on;
  }

  // Swing the camera back behind the current player's pieces.
  resetView() {
    this._placeCamera(true);
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const w = Math.max(wrap.clientWidth, 1), h = Math.max(wrap.clientHeight, 1);
    this.gl.setSize(w, h, true);
    this.camera.aspect = w / h;
    // Keep the whole board in view on narrow screens.
    this.camera.fov = w / h < 1 ? 40 / Math.max(w / h, 0.55) : 40;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // Square under the pointer. A legal target on the board wins (so a tall piece in
  // front doesn't block it); otherwise the piece hit, otherwise the board square.
  pick(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((evt.clientX - rect.left) / rect.width) * 2 - 1,
      -((evt.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.scene.updateMatrixWorld(); // pieces may have moved since the last render
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    const boardSq = this.raycaster.ray.intersectPlane(this.boardPlane, p) ? xzToSquare(p.x, p.z) : null;
    if (boardSq && this.targets.includes(boardSq)) return boardSq;
    for (const hit of this.raycaster.intersectObjects(this.pieceGroup.children, true)) {
      if (hit.object.name !== 'hitbox') continue;
      const sq = hit.object.parent.userData.square;
      if (sq) return sq; // null while a captured piece fades out
    }
    return boardSq;
  }

  _frame(now) {
    if (this._seen.flipped !== undefined && this._seen.flipped !== this.flipped) this._placeCamera(true);
    this._seen.flipped = this.flipped;
    if (this._seen.board !== this.board) {
      this._syncPieces(this._seen.board, this.board);
      this.dirty = true;
      this._seen.board = this.board;
    }
    const marks = JSON.stringify([this.selected, this.targets, this.lastMove, this.checkSquare, this.hover]);
    if (marks !== this._seen.marks) {
      this._rebuildMarks();
      this._seen.marks = marks;
      this.dirty = true;
    }

    if (this.anims.length) this.dirty = true; // includes each animation's final frame
    this.anims = this.anims.filter((a) => {
      const t = Math.min((now - a.start) / a.dur, 1);
      a.step(t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2, t);
      if (t >= 1) a.done?.();
      return t < 1;
    });
    // Render only when something changed (saves battery when idle).
    if (!this.anims.some((a) => a.camera) && this.controls.update()) this.dirty = true;
    // The Polyfjord pieces are sculpted to be seen from the front (their backs are
    // hollow), so turn every piece to face the camera as it orbits.
    const yaw = Math.atan2(this.camera.position.x, this.camera.position.z);
    if (yaw !== this.yaw) {
      this.yaw = yaw;
      for (const o of this.pieceGroup.children) o.rotation.y = yaw;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.gl.render(this.scene, this.camera);
  }

  _makePiece(p) {
    const proto = this.set.pieces[p.color + p.type.toUpperCase()];
    const obj = proto.clone();
    const { x, z } = squareToXZ(p.square);
    obj.position.set(x, this.boardTop, z);
    obj.userData.square = p.square;
    obj.rotation.y = this.yaw;
    this.pieceGroup.add(obj);
    this.meshes.set(p.square, obj);
    return obj;
  }

  // Update piece objects from the old board to the new one, sliding pieces that moved
  // (normal moves, castling rook, en passant) and fading out captured ones.
  _syncPieces(oldBoard, newBoard) {
    const key = (p) => p && p.color + p.type;
    const oldMap = new Map(), newMap = new Map();
    for (const row of oldBoard || []) for (const p of row) if (p) oldMap.set(p.square, key(p));
    for (const row of newBoard || []) for (const p of row) if (p) newMap.set(p.square, p);

    // Too different (new game, rematch, first state): rebuild without animation.
    let changed = 0;
    for (const [sq, k] of oldMap) if (key(newMap.get(sq)) !== k) changed++;
    for (const [sq, p] of newMap) if (oldMap.get(sq) !== key(p)) changed++;
    if (!oldBoard || changed > 6) {
      this.pieceGroup.clear();
      this.meshes.clear();
      for (const p of newMap.values()) this._makePiece(p);
      return;
    }

    const vanished = [...oldMap].filter(([sq, k]) => key(newMap.get(sq)) !== k).map(([sq, k]) => ({ sq, k }));
    const appeared = [...newMap.values()].filter((p) => oldMap.get(p.square) !== key(p));
    const moves = [];
    for (const p of appeared) {
      const i = vanished.findIndex((v) => v.k === key(p));
      if (i >= 0) moves.push({ from: vanished.splice(i, 1)[0].sq, to: p.square, p });
      else moves.push({ from: null, to: p.square, p }); // promotion
    }
    // Remove captured / promoted-away pieces.
    for (const v of vanished) {
      const obj = this.meshes.get(v.sq);
      if (!obj) continue;
      this.meshes.delete(v.sq);
      this._fadeOut(obj, 150);
    }
    const objs = moves.map((m) => ({ m, obj: m.from ? this.meshes.get(m.from) : null }));
    for (const { m } of objs) if (m.from) this.meshes.delete(m.from);
    for (const { m, obj } of objs) {
      if (!obj) { this._makePiece(m.p); continue; }
      obj.userData.square = m.to;
      this.meshes.set(m.to, obj);
      const a = obj.position.clone(), b = new THREE.Vector3(squareToXZ(m.to).x, this.boardTop, squareToXZ(m.to).z);
      const hop = m.p.type === 'n' ? 2.2 : 0.6;
      this.anims.push({
        start: performance.now(), dur: 380,
        step: (e) => { obj.position.lerpVectors(a, b, e); obj.position.y = this.boardTop + Math.sin(Math.PI * e) * hop; },
      });
    }
  }

  _fadeOut(obj, delay) {
    obj.traverse((o) => {
      if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.castShadow = false; }
    });
    obj.userData.square = null;
    this.anims.push({
      start: performance.now() + delay, dur: 300,
      step: (e, t) => {
        if (t < 0) return;
        obj.traverse((o) => { if (o.isMesh) o.material.opacity = 1 - e; });
        obj.position.y = this.boardTop - e * 0.6;
      },
      done: () => this.pieceGroup.remove(obj),
    });
  }

  _mat(color, opacity) {
    const k = color + ':' + opacity;
    return (this._mats[k] ||= new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
  }

  _mark(square, geo, color, opacity, lift = 0.01) {
    const { x, z } = squareToXZ(square);
    const m = new THREE.Mesh(geo, this._mat(color, opacity));
    m.position.set(x, this.boardTop + lift, z);
    m.renderOrder = 1;
    this.markGroup.add(m);
  }

  _rebuildMarks() {
    this.markGroup.clear();
    if (this.lastMove) {
      this._mark(this.lastMove.from, this._squareGeo, COLORS.lastMove, 0.32);
      this._mark(this.lastMove.to, this._squareGeo, COLORS.lastMove, 0.32);
    }
    if (this.checkSquare) this._mark(this.checkSquare, this._squareGeo, COLORS.check, 0.5);
    if (this.selected) this._mark(this.selected, this._squareGeo, COLORS.selected, 0.5, 0.012);
    if (this.hover && this.hover !== this.selected) this._mark(this.hover, this._squareGeo, COLORS.hover, 0.07, 0.012);
    for (const t of this.targets) {
      const occupied = this.meshes.has(t);
      this._mark(t, occupied ? this._ringGeo : this._dotGeo, COLORS.target, occupied ? 0.4 : 0.32, 0.015);
    }
  }
}
