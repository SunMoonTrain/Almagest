// 第三步：一笔画。把所有链首尾相连成一条闭合曲线，并记住跳线在哪里。
import { polylineLength, reversePts, type Chain } from './chains';

export interface Tour {
  pts: number[];
  /** jump[i] = 1 表示从第 i 个点到第 i+1 个点（最后一个点回到起点）是跳线 */
  jump: number[];
}

interface Visit {
  c: number;
  /** 开放链：0 正着走、1 反着走；闭合链：入口顶点下标 */
  v: number;
}

class Builder {
  pts: number[] = [];
  jump: number[] = [];
  emit(x: number, y: number, isJump: boolean) {
    if (this.pts.length) this.jump.push(isJump ? 1 : 0);
    this.pts.push(x, y);
  }
  done(): Tour {
    if (this.pts.length) this.jump.push(1);
    return { pts: this.pts, jump: this.jump };
  }
}

function longest(chains: Chain[]): number {
  let best = 0, bestL = -1;
  chains.forEach((c, i) => {
    const L = polylineLength(c.pts, c.closed);
    if (L > bestL) { bestL = L; best = i; }
  });
  return best;
}

/** 贪心串联 + 二元交换改进（2-opt）。 */
export function greedyTour(chains: Chain[], timeLimitMs = 200): Tour {
  const n = chains.length;
  if (n === 0) return { pts: [], jump: [] };

  const entry = (vi: Visit): [number, number] => {
    const p = chains[vi.c].pts;
    if (chains[vi.c].closed) return [p[2 * vi.v], p[2 * vi.v + 1]];
    return vi.v === 0 ? [p[0], p[1]] : [p[p.length - 2], p[p.length - 1]];
  };
  const exit = (vi: Visit): [number, number] => {
    const p = chains[vi.c].pts;
    if (chains[vi.c].closed) return [p[2 * vi.v], p[2 * vi.v + 1]];
    return vi.v === 0 ? [p[p.length - 2], p[p.length - 1]] : [p[0], p[1]];
  };

  // 空间网格：开放链的两端、闭合链的每个顶点都可以当入口
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const c of chains) {
    for (let i = 0; i < c.pts.length; i += 2) {
      minx = Math.min(minx, c.pts[i]); maxx = Math.max(maxx, c.pts[i]);
      miny = Math.min(miny, c.pts[i + 1]); maxy = Math.max(maxy, c.pts[i + 1]);
    }
  }
  const cell = Math.max(maxx - minx, maxy - miny, 1) / 64;
  const gw = Math.floor((maxx - minx) / cell) + 1;
  const gh = Math.floor((maxy - miny) / cell) + 1;
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const entC: number[] = [], entV: number[] = [], entX: number[] = [], entY: number[] = [];
  const addEntry = (c: number, v: number, x: number, y: number) => {
    const id = entC.length;
    entC.push(c); entV.push(v); entX.push(x); entY.push(y);
    grid[Math.floor((y - miny) / cell) * gw + Math.floor((x - minx) / cell)].push(id);
  };
  chains.forEach((c, ci) => {
    const p = c.pts;
    if (c.closed) for (let i = 0; i < p.length / 2; i++) addEntry(ci, i, p[2 * i], p[2 * i + 1]);
    else {
      addEntry(ci, 0, p[0], p[1]);
      addEntry(ci, 1, p[p.length - 2], p[p.length - 1]);
    }
  });

  const used = new Uint8Array(n);
  const nearest = (x: number, y: number): number => {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor((x - minx) / cell)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor((y - miny) / cell)));
    let best = -1, bestD = Infinity;
    const maxR = gw + gh;
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const yy = gy + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const xx = gx + dx;
          if (xx < 0 || xx >= gw) continue;
          const list = grid[yy * gw + xx];
          for (let q = list.length - 1; q >= 0; q--) {
            const id = list[q];
            if (used[entC[id]]) {
              list[q] = list[list.length - 1];
              list.pop();
              continue;
            }
            const d = (entX[id] - x) ** 2 + (entY[id] - y) ** 2;
            if (d < bestD) { bestD = d; best = id; }
          }
        }
      }
      if (best >= 0 && Math.sqrt(bestD) <= r * cell) break;
    }
    return best;
  };

  const start = longest(chains);
  const visits: Visit[] = [{ c: start, v: 0 }];
  used[start] = 1;
  for (let count = 1; count < n; count++) {
    const [x, y] = exit(visits[visits.length - 1]);
    const id = nearest(x, y);
    if (id < 0) break;
    visits.push({ c: entC[id], v: entV[id] });
    used[entC[id]] = 1;
  }

  // 2-opt：把一段连续的链整体倒序、每条链方向反转，跳线变短就接受
  const m = visits.length;
  if (m > 2) {
    const flip = (vi: Visit) => { if (!chains[vi.c].closed) vi.v = 1 - vi.v; };
    const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const deadline = performance.now() + timeLimitMs;
    let improved = true;
    while (improved && performance.now() < deadline) {
      improved = false;
      for (let i = 1; i < m && performance.now() < deadline; i++) {
        for (let j = i; j < m; j++) {
          const prevB = exit(visits[i - 1]);
          const nextA = entry(visits[(j + 1) % m]);
          const ai = entry(visits[i]);
          const bj = exit(visits[j]);
          const delta = dist(prevB, bj) + dist(ai, nextA) - dist(prevB, ai) - dist(bj, nextA);
          if (delta < -1e-9) {
            for (let a = i, b = j; a < b; a++, b--) {
              const t = visits[a]; visits[a] = visits[b]; visits[b] = t;
            }
            for (let a = i; a <= j; a++) flip(visits[a]);
            improved = true;
          }
        }
      }
    }
  }

  const out = new Builder();
  for (const vi of visits) {
    const c = chains[vi.c];
    let p = c.pts;
    if (c.closed) {
      const k = p.length / 2;
      for (let q = 0; q <= k; q++) {
        const idx = (vi.v + q) % k;
        out.emit(p[2 * idx], p[2 * idx + 1], q === 0);
      }
    } else {
      if (vi.v === 1) p = reversePts(p);
      for (let q = 0; q < p.length; q += 2) out.emit(p[q], p[q + 1], q === 0);
    }
  }
  return out.done();
}

/** 备选方案：最小生成树 + 深度优先往返。跳线自身重合，曲线总长接近翻倍。 */
export function treeTour(chains: Chain[]): Tour {
  const n = chains.length;
  if (n === 0) return { pts: [], jump: [] };
  const ports = chains.map((c) => {
    const p = c.pts;
    return c.closed ? [[p[0], p[1]]] : [[p[0], p[1]], [p[p.length - 2], p[p.length - 1]]];
  });
  const root = longest(chains);
  const inTree = new Uint8Array(n);
  const bestD = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const pPort = new Int32Array(n);
  const cPort = new Int32Array(n);
  const children: { child: number; port: number }[][][] = ports.map((ps) => ps.map(() => []));

  const relax = (u: number) => {
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      for (let a = 0; a < ports[u].length; a++) {
        for (let b = 0; b < ports[v].length; b++) {
          const d = Math.hypot(ports[u][a][0] - ports[v][b][0], ports[u][a][1] - ports[v][b][1]);
          if (d < bestD[v]) { bestD[v] = d; parent[v] = u; pPort[v] = a; cPort[v] = b; }
        }
      }
    }
  };
  inTree[root] = 1;
  relax(root);
  for (let count = 1; count < n; count++) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!inTree[v] && (u < 0 || bestD[v] < bestD[u])) u = v;
    inTree[u] = 1;
    children[parent[u]][pPort[u]].push({ child: u, port: cPort[u] });
    relax(u);
  }

  const out = new Builder();
  const visitChildren = (c: number, port: number) => {
    const [px, py] = ports[c][port];
    for (const { child, port: cp } of children[c][port]) {
      dfs(child, cp, true);
      out.emit(px, py, true);
    }
  };
  const dfs = (c: number, e: number, arriveJump: boolean) => {
    const chain = chains[c];
    if (chain.closed) {
      const p = chain.pts;
      for (let q = 0; q < p.length; q += 2) out.emit(p[q], p[q + 1], q === 0 && arriveJump);
      out.emit(p[0], p[1], false);
      visitChildren(c, 0);
      return;
    }
    const seq = e === 0 ? chain.pts : reversePts(chain.pts);
    for (let q = 0; q < seq.length; q += 2) out.emit(seq[q], seq[q + 1], q === 0 && arriveJump);
    visitChildren(c, 1 - e);
    for (let q = seq.length - 4; q >= 0; q -= 2) out.emit(seq[q], seq[q + 1], false);
    visitChildren(c, e);
  };
  dfs(root, 0, false);
  return out.done();
}
