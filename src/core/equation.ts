// 第七步：参数方程。由当前保留的 M 个系数生成，项的顺序和动画一致（半径从大到小）。
import type { Term } from './fourier';

export type EqForm = 'complex' | 'phase' | 'trig';

export interface Complex {
  re: number;
  im: number;
}

export interface EqOptions {
  rDigits: number;
  phiDigits: number;
  /** 只显示前 limit 项，后面接 ⋯；复制时不传 */
  limit?: number;
  perLine?: number;
}

/** 绝对值的定点格式；小到按精度会变成 0 的数自动多给几位，避免出现「0.0 e^{…}」。 */
export function fmtAbs(v: number, digits: number): string {
  const a = Math.abs(v);
  let s = a.toFixed(digits);
  if (Number(s) === 0 && a > 1e-12) {
    const need = Math.min(12, Math.max(digits, Math.ceil(-Math.log10(a)) + 1));
    s = a.toFixed(need);
  }
  return s;
}

function roundsToZero(v: number, digits: number): boolean {
  return Number(Math.abs(v).toFixed(digits)) === 0;
}

/** 第一项：-1.2 / 1.2 */
function lead(v: number, d: number): string {
  return (v < 0 && !roundsToZero(v, d + 6) ? '-' : '') + fmtAbs(v, d);
}

/** 后续项：「+ −0.52」写成「− 0.52」 */
function signed(v: number, body: string): string {
  return v < 0 ? ` - ${body}` : ` + ${body}`;
}

export function kt(k: number): string {
  return k === 1 ? 't' : k === -1 ? '-t' : `${k}t`;
}

function phaseTail(phi: number, d: number): string {
  return ` ${phi < 0 ? '-' : '+'} ${fmtAbs(phi, d)}`;
}

function expo(k: number, phi: number, d: number): string {
  if (roundsToZero(phi, d)) return k === 1 ? 'it' : k === -1 ? '-it' : `${k}it`;
  return `i(${kt(k)}${phaseTail(phi, d)})`;
}

function trigArg(fn: 'cos' | 'sin', k: number, phi: number, d: number): string {
  if (roundsToZero(phi, d)) return k > 0 ? `\\${fn} ${kt(k)}` : `\\${fn}(${kt(k)})`;
  return `\\${fn}(${kt(k)}${phaseTail(phi, d)})`;
}

export function c0Latex(c0: Complex, d: number): string {
  return `(${lead(c0.re, d)} ${c0.im < 0 ? '-' : '+'} ${fmtAbs(c0.im, d)}i)`;
}

function wrapLines(lhs: string, items: string[], perLine: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += perLine) {
    const chunk = items.slice(i, i + perLine).join('');
    lines.push(i === 0 ? `${lhs} &= ${chunk}` : `&\\quad ${chunk.trimStart()}`);
  }
  return lines;
}

function aligned(lines: string[]): string {
  return `\\begin{aligned}\n${lines.join(' \\\\\n')}\n\\end{aligned}`;
}

function cut<T>(arr: T[], limit?: number): { list: T[]; more: boolean } {
  if (limit === undefined || arr.length <= limit) return { list: arr, more: false };
  return { list: arr.slice(0, limit), more: true };
}

export function complexLatex(c0: Complex, terms: Term[], o: EqOptions): string {
  const { list, more } = cut(terms, o.limit);
  const items = [c0Latex(c0, o.rDigits), ...list.map((t) => ` + ${fmtAbs(t.r, o.rDigits)}\\,e^{${expo(t.k, t.phi, o.phiDigits)}}`)];
  if (more) items.push(' + \\cdots');
  return aligned(wrapLines('z(t)', items, o.perLine ?? 4));
}

export function phaseLatex(c0: Complex, terms: Term[], o: EqOptions): string {
  const { list, more } = cut(terms, o.limit);
  const per = o.perLine ?? 4;
  const xs = [lead(c0.re, o.rDigits), ...list.map((t) => ` + ${fmtAbs(t.r, o.rDigits)}${trigArg('cos', t.k, t.phi, o.phiDigits)}`)];
  const ys = [lead(c0.im, o.rDigits), ...list.map((t) => ` + ${fmtAbs(t.r, o.rDigits)}${trigArg('sin', t.k, t.phi, o.phiDigits)}`)];
  if (more) { xs.push(' + \\cdots'); ys.push(' + \\cdots'); }
  return aligned([...wrapLines('x(t)', xs, per), ...wrapLines('y(t)', ys, per)]);
}

/** 标准三角级数：把 ±k 两项合并成只有正频率。 */
export function trigLatex(c0: Complex, terms: Term[], o: EqOptions): string {
  const byK = new Map<number, Term>();
  const order: number[] = [];
  for (const t of terms) {
    byK.set(t.k, t);
    const m = Math.abs(t.k);
    if (!order.includes(m)) order.push(m);
  }
  const { list, more } = cut(order, o.limit);
  const xs = [lead(c0.re, o.rDigits)];
  const ys = [lead(c0.im, o.rDigits)];
  const d = o.rDigits;
  const add = (items: string[], v: number, fn: 'cos' | 'sin', m: number) => {
    if (roundsToZero(v, d)) return;
    items.push(signed(v, `${fmtAbs(v, d)}\\${fn} ${m === 1 ? 't' : `${m}t`}`));
  };
  for (const m of list) {
    const p = byK.get(m), q = byK.get(-m);
    const a = p?.re ?? 0, b = p?.im ?? 0, g = q?.re ?? 0, dl = q?.im ?? 0;
    add(xs, a + g, 'cos', m);
    add(xs, dl - b, 'sin', m);
    add(ys, b + dl, 'cos', m);
    add(ys, a - g, 'sin', m);
  }
  if (more) { xs.push(' + \\cdots'); ys.push(' + \\cdots'); }
  const per = o.perLine ?? 4;
  return aligned([...wrapLines('x(t)', xs, per), ...wrapLines('y(t)', ys, per)]);
}

export function equationLatex(form: EqForm, c0: Complex, terms: Term[], o: EqOptions): string {
  if (form === 'phase') return phaseLatex(c0, terms, o);
  if (form === 'trig') return trigLatex(c0, terms, o);
  return complexLatex(c0, terms, o);
}

/** 纯文本参数式，粘到 Desmos 一类的绘图工具；t 的范围需设为 0 到 2π。 */
export function desmosText(c0: Complex, terms: Term[], o: EqOptions): string {
  const arg = (t: Term) =>
    roundsToZero(t.phi, o.phiDigits) ? kt(t.k) : `${kt(t.k)}${t.phi < 0 ? '-' : '+'}${fmtAbs(t.phi, o.phiDigits)}`;
  const x = lead(c0.re, o.rDigits) + terms.map((t) => `+${fmtAbs(t.r, o.rDigits)}cos(${arg(t)})`).join('');
  const y = lead(c0.im, o.rDigits) + terms.map((t) => `+${fmtAbs(t.r, o.rDigits)}sin(${arg(t)})`).join('');
  return `(${x}, ${y})`;
}

export interface CoefMeta {
  N: number;
  scale: number;
  center: { x: number; y: number };
  imageHeight: number | null;
}

/** 系数表（k、r、φ），方便在别的引擎里重放动画。 */
export function coefficientsJSON(meta: CoefMeta, c0: Complex, terms: Term[]): string {
  return JSON.stringify(
    {
      format: 'almagest/1',
      note: 'z(t) = c0 + Σ r·e^{i(k·t + phi)}, t ∈ [0, 2π)；世界坐标 = (像素 − center) × scale，y 朝上',
      ...meta,
      c0,
      coefficients: terms.map((t) => ({ k: t.k, r: t.r, phi: t.phi })),
    },
    null,
    2,
  );
}
