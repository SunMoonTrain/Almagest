// 第二步：把边缘像素串成有方向的折线链；清理、简化。

/** pts 为扁平的 [x0, y0, x1, y1, …]，像素坐标 */
export interface Chain {
  pts: number[];
  closed: boolean;
}

interface RawChain extends Chain {
  startJ: boolean;
  endJ: boolean;
}

export interface CleanParams {
  minLen: number;
  tol: number;
  maxChains: number;
  spurLen: number;
  joinDist: number;
}

const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 1, 0, -1, 1, 1, -1, -1];

export function traceChains(edge: Uint8Array, w: number, h: number): RawChain[] {
  const nb = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!edge[i]) continue;
      let c = 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && edge[ny * w + nx]) c++;
      }
      nb[i] = c;
    }
  }
  const isJ = (i: number) => nb[i] >= 3;
  const vis = new Uint8Array(w * h);
  const out: RawChain[] = [];

  const walk = (path: number[], startJ: boolean, allowClose: boolean) => {
    let endJ = false;
    for (;;) {
      const cur = path[path.length - 1];
      const prev = path.length > 1 ? path[path.length - 2] : -1;
      const cx = cur % w, cy = (cur - cx) / w;
      let next = -1, junc = -1;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!edge[ni] || ni === prev) continue;
        if (isJ(ni)) {
          if (junc < 0) junc = ni;
          continue;
        }
        if (!vis[ni]) {
          next = ni;
          break;
        }
      }
      if (next >= 0) {
        vis[next] = 1;
        path.push(next);
        continue;
      }
      if (junc >= 0) {
        path.push(junc);
        endJ = true;
      }
      break;
    }
    const first = path[0], last = path[path.length - 1];
    const closed =
      allowClose && !endJ && path.length > 3 &&
      Math.abs((first % w) - (last % w)) <= 1 && Math.abs(Math.floor(first / w) - Math.floor(last / w)) <= 1;
    const pts: number[] = [];
    for (const p of path) pts.push(p % w, Math.floor(p / w));
    out.push({ pts, closed, startJ, endJ });
  };

  // 1. 从端点出发
  for (let i = 0; i < w * h; i++) {
    if (edge[i] && !vis[i] && nb[i] === 1) {
      vis[i] = 1;
      walk([i], false, false);
    }
  }
  // 2. 从交叉点的每个分支出发
  for (let i = 0; i < w * h; i++) {
    if (!edge[i] || !isJ(i)) continue;
    const x = i % w, y = (i - x) / w;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (edge[n] && !isJ(n) && !vis[n]) {
        vis[n] = 1;
        walk([i, n], true, false);
      }
    }
  }
  // 3. 剩下的一定是闭环
  for (let i = 0; i < w * h; i++) {
    if (edge[i] && !isJ(i) && !vis[i] && nb[i] >= 1) {
      vis[i] = 1;
      walk([i], false, true);
    }
  }
  return out;
}

export function polylineLength(pts: number[], closed: boolean): number {
  const n = pts.length / 2;
  let L = 0;
  for (let i = 0; i + 1 < n; i++) L += Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
  if (closed && n > 1) L += Math.hypot(pts[0] - pts[2 * n - 2], pts[1] - pts[2 * n - 1]);
  return L;
}

export function reversePts(pts: number[]): number[] {
  const out: number[] = new Array(pts.length);
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    out[2 * i] = pts[2 * (n - 1 - i)];
    out[2 * i + 1] = pts[2 * (n - 1 - i) + 1];
  }
  return out;
}

/** 端点距离不到 d 的链直接接起来，减少一笔画的跳线。 */
export function joinChains(chains: Chain[], d: number): Chain[] {
  const alive = chains.map(() => true);
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number) => Math.floor(y / d) * 65536 + Math.floor(x / d);
  const add = (x: number, y: number, id: number) => {
    const k = key(x, y);
    const list = grid.get(k);
    if (list) list.push(id);
    else grid.set(k, [id]);
  };
  chains.forEach((c, id) => {
    if (c.closed) return;
    add(c.pts[0], c.pts[1], id);
    add(c.pts[c.pts.length - 2], c.pts[c.pts.length - 1], id);
  });
  const d2 = d * d;
  const near = (x: number, y: number, self: number): { id: number; atHead: boolean } | null => {
    const gx = Math.floor(x / d), gy = Math.floor(y / d);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = grid.get((gy + dy) * 65536 + gx + dx);
        if (!list) continue;
        for (const id of list) {
          if (id === self || !alive[id] || chains[id].closed) continue;
          const p = chains[id].pts;
          if ((p[0] - x) ** 2 + (p[1] - y) ** 2 <= d2) return { id, atHead: true };
          const n = p.length;
          if ((p[n - 2] - x) ** 2 + (p[n - 1] - y) ** 2 <= d2) return { id, atHead: false };
        }
      }
    }
    return null;
  };

  for (let i = 0; i < chains.length; i++) {
    if (!alive[i] || chains[i].closed) continue;
    const c = chains[i];
    for (;;) {
      let n = c.pts.length;
      let hit = near(c.pts[n - 2], c.pts[n - 1], i);
      if (!hit) {
        c.pts = reversePts(c.pts);
        hit = near(c.pts[n - 2], c.pts[n - 1], i);
        if (!hit) break;
      }
      const tx = c.pts[n - 2], ty = c.pts[n - 1];
      let op = chains[hit.id].pts;
      if (!hit.atHead) op = reversePts(op);
      const start = op[0] === tx && op[1] === ty ? 2 : 0;
      for (let k = start; k < op.length; k++) c.pts.push(op[k]);
      alive[hit.id] = false;
      n = c.pts.length;
      add(c.pts[n - 2], c.pts[n - 1], i);
    }
    const n = c.pts.length;
    if (n >= 6 && (c.pts[0] - c.pts[n - 2]) ** 2 + (c.pts[1] - c.pts[n - 1]) ** 2 <= d2 && polylineLength(c.pts, false) > 3 * d) {
      c.closed = true;
    }
  }
  return chains.filter((_, i) => alive[i]);
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const L = vx * vx + vy * vy;
  let t = L > 0 ? ((px - ax) * vx + (py - ay) * vy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + t * vx - px, dy = ay + t * vy - py;
  return dx * dx + dy * dy;
}

/** 道格拉斯-普克简化，把像素台阶拉成斜线。 */
export function simplify(pts: number[], tol: number, closed: boolean): number[] {
  const n0 = pts.length / 2;
  if (n0 <= 2 || tol <= 0) return pts.slice();
  const p = closed ? pts.concat(pts[0], pts[1]) : pts;
  const n = p.length / 2;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [];
  if (closed) {
    let f = 1, best = -1;
    for (let i = 1; i < n - 1; i++) {
      const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2;
      if (d > best) { best = d; f = i; }
    }
    keep[f] = 1;
    stack.push([0, f], [f, n - 1]);
  } else {
    stack.push([0, n - 1]);
  }
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let idx = -1, max = tol2;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(p[2 * i], p[2 * i + 1], p[2 * a], p[2 * a + 1], p[2 * b], p[2 * b + 1]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  const end = closed ? n - 1 : n;
  for (let i = 0; i < end; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

/** 按最短链长过滤、简化、只保留最长的 K 条。 */
export function finalizeChains(chains: Chain[], minLen: number, tol: number, maxChains: number): Chain[] {
  const withLen = chains
    .map((c) => ({ c, L: polylineLength(c.pts, c.closed) }))
    .filter((e) => e.L >= minLen && e.c.pts.length >= 4);
  withLen.sort((a, b) => b.L - a.L);
  return withLen.slice(0, maxChains).map(({ c }) => ({ pts: simplify(c.pts, tol, c.closed), closed: c.closed }));
}

export function cleanChains(raw: RawChain[], p: CleanParams): Chain[] {
  // 剪毛刺：一端连交叉点、一端悬空的短枝
  const kept: Chain[] = raw
    .filter((c) => c.closed || !(c.startJ !== c.endJ && polylineLength(c.pts, false) < p.spurLen))
    .map((c) => ({ pts: c.pts, closed: c.closed }));
  const joined = joinChains(kept, p.joinDist);
  return finalizeChains(joined, p.minLen, p.tol, p.maxChains);
}

/** 剪影模式：行进方块法取所有黑白区域的边界，输出闭合折线。 */
export function marchingSquares(mask: Uint8Array, w: number, h: number): Chain[] {
  const v = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  // 坐标乘 2 后都是整数；偏移 2 保证非负
  const stride = 2 * w + 8;
  const key = (x2: number, y2: number) => (y2 + 2) * stride + (x2 + 2);
  const segA: number[] = [];
  const segB: number[] = [];
  const coords = new Map<number, [number, number]>();
  const pt = (x2: number, y2: number) => {
    const k = key(x2, y2);
    if (!coords.has(k)) coords.set(k, [x2 / 2, y2 / 2]);
    return k;
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const c = v(x, y) * 8 + v(x + 1, y) * 4 + v(x + 1, y + 1) * 2 + v(x, y + 1);
      if (c === 0 || c === 15) continue;
      const T = () => pt(2 * x + 1, 2 * y);
      const R = () => pt(2 * x + 2, 2 * y + 1);
      const B = () => pt(2 * x + 1, 2 * y + 2);
      const L = () => pt(2 * x, 2 * y + 1);
      const seg = (a: number, b: number) => { segA.push(a); segB.push(b); };
      switch (c) {
        case 1: case 14: seg(L(), B()); break;
        case 2: case 13: seg(B(), R()); break;
        case 3: case 12: seg(L(), R()); break;
        case 4: case 11: seg(T(), R()); break;
        case 6: case 9: seg(T(), B()); break;
        case 7: case 8: seg(L(), T()); break;
        case 5: seg(L(), T()); seg(B(), R()); break;
        case 10: seg(T(), R()); seg(L(), B()); break;
      }
    }
  }
  const adj = new Map<number, number[]>();
  for (let s = 0; s < segA.length; s++) {
    for (const k of [segA[s], segB[s]]) {
      const l = adj.get(k);
      if (l) l.push(s);
      else adj.set(k, [s]);
    }
  }
  const used = new Uint8Array(segA.length);
  const out: Chain[] = [];
  for (let s0 = 0; s0 < segA.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const start = segA[s0];
    let cur = segB[s0];
    const pts: number[] = [...coords.get(start)!];
    while (cur !== start) {
      pts.push(...coords.get(cur)!);
      const next = adj.get(cur)!.find((s) => !used[s]);
      if (next === undefined) break;
      used[next] = 1;
      cur = segA[next] === cur ? segB[next] : segA[next];
    }
    out.push({ pts, closed: true });
  }
  return out;
}
