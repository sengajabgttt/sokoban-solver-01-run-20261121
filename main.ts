// Sokoban solver: push-optimal A* per room.
//
// A level is a hallway with one to four rooms off it, each room holding 3 or 4
// boxes on as many goals, and no box can ever leave its room (a box pushed out
// of a door into the hallway is lost). So the level splits into independent
// rooms, and the level's push-optimal count is the sum of its rooms' optima.
// This program finds each room, solves it push-optimally on its own, and joins
// the rooms' moves with walks through the hallway.
//
// Each room is searched over pushes, not steps: a state is the boxes' squares
// plus the player's reachable region (named by its lowest square), so two
// states that differ only in where the player stands inside one region are
// one state. The search is A* whose estimate is the cheapest matching of
// boxes to goals over walking distances, which never overestimates the pushes
// still needed, so the first solved state it pops is push-optimal. It prunes
// two dead ends a box can never leave: a dead square (no pull path back to a
// goal) and a frozen 2 x 2 block of walls and boxes with a box off its goal.
// When A* gives up on a room, a plain push BFS tries (same guarantee as the
// reference search), then a greedy best-first search for any solution at all,
// so a hard room still earns what it can instead of nothing.
//
// Budgets are counted in state expansions, never the wall clock, so two runs
// of the program write the same bytes. No randomness, no clock reads.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four moves: [dx, dy, step letter, push letter].
const DIRS: Array<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work budgets in state expansions. A* first, then BFS, then greedy per room;
// the global budget keeps the whole set inside the wall budget.
const ASTAR_CAP = 250000;
const BFS_CAP = 250000;
const GREEDY_CAP = 250000;
const GLOBAL_CAP = 4000000;
let workUsed = 0;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = {
  cells: number[];
  goals: number[];
  boxes: number[];
  door: number;
  entry: number;
};

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The level's rooms: cut the player's row (the hallway) out of the floor and
 * each part left that holds boxes is a room. Its door is the one square of it
 * touching the hallway, and its entry is the hallway square outside that door.
 * Null when the level is no set of rooms (a box in the hallway, or a part
 * whose boxes and goals do not match), and the caller falls back to solving
 * the whole level as one room.
 */
function roomsOfLevel(lv: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const size = w * lv.h;
  const hallRow = Math.floor(player / w);
  if (boxes.some((b) => Math.floor(b / w) === hallRow)) return null;
  if (goals.some((g) => Math.floor(g / w) === hallRow)) return null;
  const comp = new Int32Array(size).fill(-1);
  const parts: number[][] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || Math.floor(s / w) === hallRow || comp[s] >= 0) continue;
    const cells = [s];
    comp[s] = parts.length;
    for (let i = 0; i < cells.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = cells[i] + dy * w + dx;
        if (q < 0 || q >= size || wall[q] || Math.floor(q / w) === hallRow || comp[q] >= 0) continue;
        comp[q] = parts.length;
        cells.push(q);
      }
    }
    parts.push(cells);
  }
  const rooms: Room[] = [];
  for (let id = 0; id < parts.length; id++) {
    const cells = parts[id];
    const rb = boxes.filter((b) => comp[b] === id);
    if (rb.length === 0) continue;
    const rg = goals.filter((g) => comp[g] === id);
    if (rb.length !== rg.length) return null;
    const touching = cells.filter((c) => {
      const r = Math.floor(c / w);
      const n = r < hallRow ? c + w : c - w;
      return Math.floor(n / w) === hallRow && !wall[n];
    });
    if (touching.length !== 1) return null;
    const door = touching[0];
    const entry = Math.floor(door / w) < hallRow ? door + w : door - w;
    rooms.push({ cells, goals: rg, boxes: rb, door, entry });
  }
  if (rooms.length === 0) return null;
  return rooms;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters, or null. */
function walkTo(
  lv: Level,
  from: number,
  to: number,
  occupied: Uint8Array,
  prev: Int32Array,
  how: Int8Array,
): string | null {
  if (from === to) return '';
  const { w, wall } = lv;
  const size = wall.length;
  prev.fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const [dx, dy] = DIRS[k];
      const q = p + dy * w + dx;
      if (q < 0 || q >= size || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = DIRS[how[p]][2] + s;
  return s;
}

/** The player's square after `moves` (LURD, either case) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/** A tiny binary heap of [f, g, state], lowest f first, deeper g first on ties. */
class Heap {
  a: Array<[number, number, number]> = [];
  get size(): number {
    return this.a.length;
  }
  private less(x: [number, number, number], y: [number, number, number]): boolean {
    return x[0] < y[0] || (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] < y[2])));
  }
  push(e: [number, number, number]): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      const t = a[i];
      a[i] = a[p];
      a[p] = t;
      i = p;
    }
  }
  pop(): [number, number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && this.less(a[c + 1], a[c])) c++;
        if (!this.less(a[c], a[i])) break;
        const t = a[i];
        a[i] = a[c];
        a[c] = t;
        i = c;
      }
    }
    return top;
  }
}

/**
 * One room solved over pushes, in `mode`: 'astar' (matching estimate), 'bfs'
 * (no estimate) or 'greedy' (estimate only). Returns the push-optimal
 * solution for 'astar' and 'bfs', any solution for 'greedy', or null when the
 * search gives up inside `cap` expansions.
 */
function searchRoom(
  lv: Level,
  room: Room,
  mode: 'astar' | 'bfs' | 'greedy',
  cap: number,
): { pushes: number; moves: string } | null {
  const { w, wall } = lv;
  const size = wall.length;
  const n = room.boxes.length;
  const goals = room.goals;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;

  // The walkable squares: the room's cells plus the entry (the hallway square
  // outside the door, where the player starts and can step back out to).
  const walkable = new Uint8Array(size);
  for (const c of room.cells) walkable[c] = 1;
  walkable[room.entry] = 1;

  // Dead squares: pull every box back from the goals over open floor; a square
  // no pull reaches is one no push can ever leave towards a goal.
  const live = new Uint8Array(size);
  {
    const queue = [...goals];
    for (const g of goals) live[g] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        if (y < 0 || y >= size || y - d < 0 || y - d >= size) continue;
        if (walkable[y] && walkable[y - d] && !live[y]) {
          live[y] = 1;
          queue.push(y);
        }
      }
    }
  }
  if (room.boxes.some((b) => !live[b])) return null;

  // Walking distances from each goal over the room's floor, for the matching estimate.
  const dist: Int32Array[] = [];
  for (const g of goals) {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= size || !walkable[q] || d[q] >= 0) continue;
        d[q] = d[p] + 1;
        queue.push(q);
      }
    }
    dist.push(d);
  }

  // Cheapest matching of boxes to goals over walking distances (bitmask DP),
  // Infinity when no box can reach every goal it would need.
  const matchCost = (boxes: number[]): number => {
    const INF = 1e9;
    const dp = new Array(1 << n).fill(INF);
    dp[0] = 0;
    for (let mask = 0; mask < 1 << n; mask++) {
      let i = 0;
      for (let m = mask; m > 0; m &= m - 1) i++;
      if (i >= n || dp[mask] >= INF) continue;
      for (let g = 0; g < n; g++) {
        if (mask & (1 << g)) continue;
        const d = dist[g][boxes[i]];
        if (d < 0) continue;
        const nm = mask | (1 << g);
        const c = dp[mask] + d;
        if (c < dp[nm]) dp[nm] = c;
      }
    }
    const total = dp[(1 << n) - 1];
    return total >= INF ? Infinity : total;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  // A state's key: the region's lowest square and the boxes' squares, as
  // digits in base size + 1 (exact well under 2 ** 53 for these rooms).
  const base = size + 1;
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * base + b;
    return k;
  };

  // Scratch for region floods and walks, reused, never allocated per state.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const occupied = new Uint8Array(size);
  const prev = new Int32Array(size);
  const how = new Int8Array(size);

  /** The lowest square the player reaches from `from` with `occ` in the way. */
  const regionLow = (occ: Uint8Array, from: number, seenArr: Int32Array, st: number): number => {
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    seenArr[from] = st;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k];
        const q = p + dy * w + dx;
        if (q < 0 || q >= size || !walkable[q] || occ[q] || seenArr[q] === st) continue;
        seenArr[q] = st;
        stack[sp++] = q;
      }
    }
    return low;
  };

  /** Whether the box just pushed to `t` sits in a frozen 2 x 2 block. */
  const frozenBlock = (occ: Uint8Array, t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (a < 0 || d >= size) continue;
      if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
      if ((occ[a] && !goalSet[a]) || (occ[b] && !goalSet[b]) || (occ[c] && !goalSet[c]) || (occ[d] && !goalSet[d])) {
        return true;
      }
    }
    return false;
  };

  // The states: their boxes, the player's square, and the push that made them.
  const sBoxes: number[][] = [room.boxes.slice()];
  const sPlayer: number[] = [room.entry];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const best = new Map<number, number>();
  for (const b of room.boxes) occupied[b] = 1;
  best.set(keyOf(room.boxes, regionLow(occupied, room.entry, seen, ++stamp)), 0);
  for (const b of room.boxes) occupied[b] = 0;

  if (solved(room.boxes)) return { pushes: 0, moves: '' };

  const heap = new Heap();
  const h0 = mode === 'bfs' ? 0 : matchCost(room.boxes);
  if (h0 === Infinity) return null;
  heap.push([h0, 0, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.size > 0) {
    const [, g, id] = heap.pop();
    const boxes = sBoxes[id];
    if (workUsed >= GLOBAL_CAP || expanded >= cap) return null;
    // The player's reachable region from this state's square.
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    const low = regionLow(occupied, sPlayer[id], seen, here);
    if (best.get(keyOf(boxes, low)) !== g) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    expanded++;
    workUsed++;
    if (solved(boxes)) {
      found = id;
      for (const b of boxes) occupied[b] = 0;
      break;
    }
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k];
        const d = dy * w + dx;
        const t = b + d;
        const s = b - d;
        if (t < 0 || t >= size || s < 0 || s >= size) continue;
        if (seen[s] !== here || !walkable[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(occupied, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, regionLow(occupied, b, mark, ++stamp));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        if (best.has(key) && best.get(key)! <= g + 1) continue;
        const h = mode === 'bfs' ? 0 : matchCost(next);
        if (h === Infinity) continue;
        best.set(key, g + 1);
        const nid = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(id);
        sFrom.push(b);
        sDir.push(k);
        heap.push([mode === 'greedy' ? h : g + 1 + h, g + 1, nid]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = room.entry;
  let boxes = room.boxes.slice();
  for (const s of path) {
    const nextBoxes = sBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const k = sDir[s];
    const [dx, dy, , pushLetter] = DIRS[k];
    const d = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(lv, player, from - d, occupied, prev, how);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk + pushLetter;
    player = from;
    boxes = nextBoxes.slice();
  }
  return { pushes: path.length, moves };
}

/** A room solved, A* first, then BFS, then greedy for any solution at all. */
function solveRoom(lv: Level, room: Room): { pushes: number; moves: string } | null {
  return (
    searchRoom(lv, room, 'astar', ASTAR_CAP) ??
    searchRoom(lv, room, 'bfs', BFS_CAP) ??
    searchRoom(lv, room, 'greedy', GREEDY_CAP)
  );
}

/** A whole level solved room by room, the player walking on between rooms. */
function solveLevel(lv: Level): string {
  const { w, wall } = lv;
  const size = wall.length;
  let rooms = roomsOfLevel(lv);
  if (rooms === null) {
    // No set of rooms: the whole level as one room, every floor square walkable.
    const floor: number[] = [];
    for (let i = 0; i < size; i++) if (!wall[i]) floor.push(i);
    rooms = [{ cells: floor, goals: lv.goals, boxes: lv.boxes, door: -1, entry: lv.player }];
  }
  const occupied = new Uint8Array(size);
  for (const b of lv.boxes) occupied[b] = 1;
  const prev = new Int32Array(size);
  const how = new Int8Array(size);
  let player = lv.player;
  let moves = '';
  for (const room of rooms) {
    const walk = walkTo(lv, player, room.entry, occupied, prev, how);
    if (walk === null) return '';
    moves += walk;
    player = room.entry;
    const sol = solveRoom(lv, room);
    if (sol === null) return '';
    moves += sol.moves;
    player = endOf(w, player, sol.moves);
    for (const b of room.boxes) occupied[b] = 0;
    for (const g of room.goals) occupied[g] = 1;
  }
  return moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
