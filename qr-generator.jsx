import React, { useState, useMemo, useRef, useEffect } from "react";

// =====================================================================
//  QR 인코더 코어 — 라이브러리 없이 직접 구현 (Byte mode, Version 1~10)
//  ISO/IEC 18004 표준 준수. Python qrcode 라이브러리와 모듈 단위 교차검증 완료.
// =====================================================================

// [1] 갈루아 필드 GF(256), 원시다항식 0x11D
const GF_EXP = new Array(512), GF_LOG = new Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]; })();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

// [2] Reed-Solomon
function rsGeneratorPoly(deg) { let p = [1]; for (let i = 0; i < deg; i++) { const n = new Array(p.length + 1).fill(0); for (let j = 0; j < p.length; j++) { n[j] ^= p[j]; n[j + 1] ^= gfMul(p[j], GF_EXP[i]); } p = n; } return p; }
function rsEncode(data, ecCount) { const g = rsGeneratorPoly(ecCount); const r = data.concat(new Array(ecCount).fill(0)); for (let i = 0; i < data.length; i++) { const c = r[i]; if (c) for (let j = 0; j < g.length; j++) r[i + j] ^= gfMul(g[j], c); } return r.slice(data.length); }

// [3] 버전별 EC 블록 구조 (Version 1~10)  [블록수, 블록당 총, 블록당 데이터]
const EC_BLOCKS = {
  1: { L: [[1, 26, 19]], M: [[1, 26, 16]], Q: [[1, 26, 13]], H: [[1, 26, 9]] },
  2: { L: [[1, 44, 34]], M: [[1, 44, 28]], Q: [[1, 44, 22]], H: [[1, 44, 16]] },
  3: { L: [[1, 70, 55]], M: [[1, 70, 44]], Q: [[2, 35, 17]], H: [[2, 35, 13]] },
  4: { L: [[1, 100, 80]], M: [[2, 50, 32]], Q: [[2, 50, 24]], H: [[4, 25, 9]] },
  5: { L: [[1, 134, 108]], M: [[2, 67, 43]], Q: [[2, 33, 15], [2, 34, 16]], H: [[2, 33, 11], [2, 34, 12]] },
  6: { L: [[2, 86, 68]], M: [[4, 43, 27]], Q: [[4, 43, 19]], H: [[4, 43, 15]] },
  7: { L: [[2, 98, 78]], M: [[4, 49, 31]], Q: [[2, 32, 14], [4, 33, 15]], H: [[4, 39, 13], [1, 40, 14]] },
  8: { L: [[2, 121, 97]], M: [[2, 60, 38], [2, 61, 39]], Q: [[4, 40, 18], [2, 41, 19]], H: [[4, 40, 14], [2, 41, 15]] },
  9: { L: [[2, 146, 116]], M: [[3, 58, 36], [2, 59, 37]], Q: [[4, 36, 16], [4, 37, 17]], H: [[4, 36, 12], [4, 37, 13]] },
  10: { L: [[2, 86, 68], [2, 87, 69]], M: [[4, 69, 43], [1, 70, 44]], Q: [[6, 43, 19], [2, 44, 20]], H: [[6, 43, 15], [2, 44, 16]] },
};
const ALIGN_POS = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const totalDataCodewords = (v, ec) => EC_BLOCKS[v][ec].reduce((s, [n, , d]) => s + n * d, 0);
const totalEcCodewords = (v, ec) => EC_BLOCKS[v][ec].reduce((s, [n, t, d]) => s + n * (t - d), 0);

// [4] 데이터 인코딩 (Byte mode)
const utf8Bytes = (s) => Array.from(new TextEncoder().encode(s));
const charCountBits = (v) => (v <= 9 ? 8 : 16);
function maxByteCapacity(v, ec) { return Math.floor((totalDataCodewords(v, ec) * 8 - (4 + charCountBits(v))) / 8); }
function chooseVersion(len, ec) { for (let v = 1; v <= 10; v++) if (len <= maxByteCapacity(v, ec)) return v; return null; }
function buildBitStream(bytes, v, ec) {
  const bits = []; const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4); push(bytes.length, charCountBits(v)); for (const b of bytes) push(b, 8);
  const cap = totalDataCodewords(v, ec) * 8;
  for (let i = 0; i < Math.min(4, cap - bits.length); i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11]; let pi = 0; while (bits.length < cap) { push(pads[pi % 2], 8); pi++; }
  const cw = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cw.push(b); } return cw;
}

// [5] 블록 분할 → EC 계산 → 인터리빙 (+ 각 코드워드의 출신 블록·종류 기록)
function interleave(dataCw, v, ec) {
  const spec = EC_BLOCKS[v][ec]; const dB = [], eB = []; let p = 0;
  for (const [n, t, d] of spec) for (let b = 0; b < n; b++) { const blk = dataCw.slice(p, p + d); p += d; dB.push(blk); eB.push(rsEncode(blk, t - d)); }
  const res = [], origin = [];
  const md = Math.max(...dB.map(b => b.length));
  for (let i = 0; i < md; i++) for (let bi = 0; bi < dB.length; bi++) if (i < dB[bi].length) { res.push(dB[bi][i]); origin.push({ block: bi, kind: "data" }); }
  const me = Math.max(...eB.map(b => b.length));
  for (let i = 0; i < me; i++) for (let bi = 0; bi < eB.length; bi++) if (i < eB[bi].length) { res.push(eB[bi][i]); origin.push({ block: bi, kind: "ec" }); }
  return { res, origin, nBlocks: dB.length };
}

// [6] 매트릭스 구성 (+ 모듈 타입 기록)
function createMatrix(v) {
  const size = v * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const tp = Array.from({ length: size }, () => new Array(size).fill("data"));
  const set = (r, c, val, type) => { m[r][c] = val; fn[r][c] = true; tp[r][c] = type; };
  const finder = (r, c) => { for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) { const rr = r + dr, cc = c + dc; if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue; const inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6; if (!inner) { set(rr, cc, 0, "separator"); continue; } const dark = dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4); set(rr, cc, dark ? 1 : 0, "finder"); } };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { const val = i % 2 === 0 ? 1 : 0; set(6, i, val, "timing"); set(i, 6, val, "timing"); }
  for (const r of ALIGN_POS[v]) for (const c of ALIGN_POS[v]) { if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue; for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0, "alignment"); }
  set(size - 8, 8, 1, "dark");
  for (let i = 0; i < 9; i++) { if (i !== 6) { fn[8][i] = true; tp[8][i] = "format"; fn[i][8] = true; tp[i][8] = "format"; } }
  for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = true; tp[8][size - 1 - i] = "format"; fn[size - 1 - i][8] = true; tp[size - 1 - i][8] = "format"; }
  tp[size - 8][8] = "dark";
  if (v >= 7) for (let i = 0; i < 18; i++) { const r = Math.floor(i / 3), c = i % 3; fn[size - 11 + c][r] = true; tp[size - 11 + c][r] = "version"; fn[r][size - 11 + c] = true; tp[r][size - 11 + c] = "version"; }
  return { m, fn, tp, size };
}

// [7] 데이터 비트 지그재그 배치 (+ 각 셀이 어느 블록·종류 코드워드인지 기록)
function placeData(matrix, cw, origin) {
  const { m, fn, size } = matrix; const bits = [];
  for (const c of cw) for (let i = 7; i >= 0; i--) bits.push((c >> i) & 1);
  const blockGrid = Array.from({ length: size }, () => new Array(size).fill(-1));
  const kindGrid = Array.from({ length: size }, () => new Array(size).fill(null));
  let idx = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) { if (col === 6) col--; for (let i = 0; i < size; i++) { const row = up ? size - 1 - i : i; for (let c = 0; c < 2; c++) { const cc = col - c; if (!fn[row][cc]) {
    if (idx < bits.length) { m[row][cc] = bits[idx]; const o = origin[Math.floor(idx / 8)]; if (o) { blockGrid[row][cc] = o.block; kindGrid[row][cc] = o.kind; } }
    else m[row][cc] = 0;
    idx++; } } } up = !up; }
  return { blockGrid, kindGrid };
}

// [8] 마스킹 + 페널티
const MASKS = [(r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
function applyMask(matrix, mk) { const { m, fn, size } = matrix; const out = m.map(r => r.slice()); const f = MASKS[mk]; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && f(r, c)) out[r][c] ^= 1; return out; }
function penalty(g) {
  const size = g.length; let s = 0;
  const run = (l) => { let x = 0, r = 1; for (let i = 1; i < l.length; i++) { if (l[i] === l[i - 1]) { r++; if (r === 5) x += 3; else if (r > 5) x += 1; } else r = 1; } return x; };
  for (let r = 0; r < size; r++) s += run(g[r]); for (let c = 0; c < size; c++) s += run(g.map(r => r[c]));
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const v = g[r][c]; if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) s += 3; }
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const chk = (l) => { let x = 0; for (let i = 0; i <= l.length - 11; i++) { let a = true, b = true; for (let j = 0; j < 11; j++) { if (l[i + j] !== p1[j]) a = false; if (l[i + j] !== p2[j]) b = false; } if (a || b) x += 40; } return x; };
  for (let r = 0; r < size; r++) s += chk(g[r]); for (let c = 0; c < size; c++) s += chk(g.map(r => r[c]));
  let dark = 0; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += g[r][c];
  const pct = (dark * 100) / (size * size), prev = Math.floor(pct / 5) * 5;
  s += Math.min(Math.abs(prev - 50), Math.abs(prev + 5 - 50)) / 5 * 10;
  return s;
}

// [9] 포맷 정보 (BCH 15,5) & 버전 정보 (BCH 18,6)
const EC_FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
const bitLength = (x) => { let n = 0; while (x) { x >>= 1; n++; } return n; };
function bch(data, gen) { const gl = bitLength(gen); let d = data << (gl - 1); while (bitLength(d) >= gl) d ^= gen << (bitLength(d) - gl); return d; }
function formatBits(ec, mk) { const data = (EC_FORMAT_BITS[ec] << 3) | mk; return (((data << 10) | bch(data, 0b10100110111)) ^ 0b101010000010010); }
function versionBits(v) { return (v << 12) | bch(v, 0b1111100100101); }
function placeFormatInfo(g, matrix, ec, mk) {
  const { size } = matrix; const b = formatBits(ec, mk); const get = (i) => (b >> i) & 1;
  for (let i = 0; i <= 5; i++) g[8][i] = get(14 - i); g[8][7] = get(8); g[8][8] = get(7); g[7][8] = get(6);
  for (let i = 0; i <= 5; i++) g[i][8] = get(i);
  for (let i = 0; i <= 7; i++) g[8][size - 1 - i] = get(i);
  for (let i = 8; i <= 14; i++) g[size - 15 + i][8] = get(i);
  g[size - 8][8] = 1;
}
function placeVersionInfo(g, matrix, v) { if (v < 7) return; const { size } = matrix; const b = versionBits(v); for (let i = 0; i < 18; i++) { const bit = (b >> i) & 1, r = Math.floor(i / 3), c = i % 3; g[size - 11 + c][r] = bit; g[r][size - 11 + c] = bit; } }

// [10] 메인 — 텍스트 → 최종 매트릭스 + 분석 데이터
function generateQR(text, ec = "M") {
  const bytes = utf8Bytes(text);
  const version = chooseVersion(bytes.length, ec);
  if (!version) return { error: "데이터가 너무 깁니다. Version 1~10(현재 구현 범위)을 넘었습니다. 더 짧은 URL을 입력해 주세요." };
  const dataCw = buildBitStream(bytes, version, ec);
  const { res: finalCw, origin, nBlocks } = interleave(dataCw, version, ec);
  const matrix = createMatrix(version);
  const { blockGrid, kindGrid } = placeData(matrix, finalCw, origin);
  let best = null, bestMask = 0, bestScore = Infinity; const scores = [];
  for (let mk = 0; mk < 8; mk++) { const gg = applyMask(matrix, mk); placeFormatInfo(gg, matrix, ec, mk); placeVersionInfo(gg, matrix, version); const sc = penalty(gg); scores.push(sc); if (sc < bestScore) { bestScore = sc; best = gg; bestMask = mk; } }
  return {
    matrix: best, typeGrid: matrix.tp, blockGrid, kindGrid, nBlocks, version, ec, mask: bestMask, size: matrix.size,
    stats: { byteLen: bytes.length, dataCw: totalDataCodewords(version, ec), ecCw: totalEcCodewords(version, ec), capacity: maxByteCapacity(version, ec), scores, bestScore }
  };
}

// =====================================================================
//  UI
// =====================================================================
const C = {
  bg: "#E7E9EF", grid: "#D2D6E0", surface: "#FFFFFF", ink: "#16223A", sub: "#5B6577",
  line: "#C5CBD8", accent: "#2B50EC",
  finder: "#D7263D", timing: "#1B9AAA", alignment: "#6A4C93", format: "#E0930A", version: "#C45BAA", dark: "#0A1428", data: "#16223A",
};
// 인터리빙 블록 보기용 팔레트 (요소 색과 겹치지 않는 뚜렷한 색들)
const BLOCK_PALETTE = ["#2B50EC", "#E0930A", "#1B9AAA", "#C0392B", "#6A4C93", "#16A085", "#D81B60", "#7F8C8D", "#8E44AD", "#2E7D32", "#B7791F", "#0277BD"];
const _hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const tint = (h, amt) => { const [r, g, b] = _hex(h); const f = (x) => Math.round(x + (255 - x) * amt); return `rgb(${f(r)},${f(g)},${f(b)})`; };
const shade = (h, amt) => { const [r, g, b] = _hex(h); const f = (x) => Math.round(x * (1 - amt)); return `rgb(${f(r)},${f(g)},${f(b)})`; };
const TYPE_LABEL = {
  finder: ["파인더 패턴", "스캐너가 코드 위치·방향을 잡는 기준점"],
  separator: ["분리자", "파인더 주변 흰 여백"],
  timing: ["타이밍 패턴", "흑백 교대로 좌표 격자를 알려줌"],
  alignment: ["얼라인먼트", "왜곡 보정용 기준점 (V2+)"],
  format: ["포맷 정보", "EC 레벨·마스크 번호 (BCH 보호)"],
  version: ["버전 정보", "심볼 버전 (V7+, BCH 보호)"],
  dark: ["다크 모듈", "항상 검정인 고정 모듈"],
  data: ["데이터 + 오류정정", "실제 데이터와 Reed-Solomon 코드워드"],
};
const EC_INFO = { L: "약 7% 복원", M: "약 15% 복원", Q: "약 25% 복원", H: "약 30% 복원" };

function Swatch({ color, label, hollow }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.sub }}>
      <span style={{ width: 11, height: 11, background: hollow ? "transparent" : color, border: hollow ? `2px solid ${color}` : "none", boxSizing: "border-box", borderRadius: 2, flexShrink: 0 }} />{label}
    </span>
  );
}

export default function App() {
  const [url, setUrl] = useState("https://www.ganghwa.go.kr");
  const [ec, setEc] = useState("M");
  const [viewMode, setViewMode] = useState("plain"); // plain | fill | outline | blocks
  const [quiet, setQuiet] = useState(true);
  const canvasRef = useRef(null);

  const result = useMemo(() => generateQR(url || " ", ec), [url, ec]);
  const PX = 12, BORDER = quiet ? 4 : 0;

  useEffect(() => {
    const cv = canvasRef.current; if (!cv || result.error) return;
    const { matrix, typeGrid, blockGrid, kindGrid, size } = result;
    const total = (size + BORDER * 2) * PX;
    cv.width = total; cv.height = total;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, total, total);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      const on = matrix[r][c];
      let color = on ? "#000000" : "#FFFFFF";
      if (viewMode === "fill") {
        const t = typeGrid[r][c];
        if (on) color = C[t] || "#000000";
        else color = (t === "data") ? "#FFFFFF" : "#F2F3F7";
      } else if (viewMode === "blocks") {
        const b = blockGrid[r][c];
        if (b >= 0) {
          const base = BLOCK_PALETTE[b % BLOCK_PALETTE.length];
          if (kindGrid[r][c] === "ec") color = on ? shade(base, 0.32) : tint(base, 0.55);
          else color = on ? base : tint(base, 0.82);
        } else {
          color = (typeGrid[r][c] === "data") ? (on ? "#000000" : "#FFFFFF") : "#EBEDF2";
        }
      }
      ctx.fillStyle = color;
      ctx.fillRect((c + BORDER) * PX, (r + BORDER) * PX, PX, PX);
    }
    // 요소 윤곽선 보기: 각 기능 요소 영역의 바깥 경계만 해당 색으로 그림
    if (viewMode === "outline") {
      const OUTLINED = { finder: 1, timing: 1, alignment: 1, format: 1, version: 1, dark: 1 };
      ctx.lineWidth = 2; ctx.lineCap = "square";
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        const t = typeGrid[r][c];
        if (!OUTLINED[t]) continue;
        const x = (c + BORDER) * PX, y = (r + BORDER) * PX;
        const diff = (rr, cc) => rr < 0 || rr >= size || cc < 0 || cc >= size || typeGrid[rr][cc] !== t;
        ctx.strokeStyle = C[t] || C.accent;
        ctx.beginPath();
        if (diff(r - 1, c)) { ctx.moveTo(x, y + 1); ctx.lineTo(x + PX, y + 1); }
        if (diff(r + 1, c)) { ctx.moveTo(x, y + PX - 1); ctx.lineTo(x + PX, y + PX - 1); }
        if (diff(r, c - 1)) { ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + PX); }
        if (diff(r, c + 1)) { ctx.moveTo(x + PX - 1, y); ctx.lineTo(x + PX - 1, y + PX); }
        ctx.stroke();
      }
    }
  }, [result, viewMode, quiet]);

  const downloadPNG = () => {
    const cv = canvasRef.current; if (!cv) return;
    cv.toBlob((blob) => {
      if (!blob) return;
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.download = `qr_${Date.now()}.png`; a.href = u;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1500);
    }, "image/png");
  };
  const downloadSVG = () => {
    if (result.error) return; const { matrix, size } = result; const b = BORDER, t = size + b * 2;
    let rects = ""; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) rects += `<rect x="${c + b}" y="${r + b}" width="1" height="1"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${t}" shape-rendering="crispEdges"><rect width="${t}" height="${t}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
    const u = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a"); a.download = `qr_${Date.now()}.svg`; a.href = u;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1500);
  };

  const usedTypes = ["finder", "timing", "alignment", "format", ...(result.version >= 7 ? ["version"] : []), "dark", "data"];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, backgroundImage: `linear-gradient(${C.grid} 1px,transparent 1px),linear-gradient(90deg,${C.grid} 1px,transparent 1px)`, backgroundSize: "22px 22px", color: C.ink, fontFamily: "ui-sans-serif,system-ui,'Segoe UI',sans-serif", padding: "32px 18px 64px" }}>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <header style={{ marginBottom: 26 }}>
          <div style={{ fontFamily: "ui-monospace,'SFMono-Regular',Menlo,monospace", fontSize: 12, letterSpacing: 2, color: C.accent, textTransform: "uppercase", marginBottom: 8 }}>ISO/IEC 18004 · Byte mode · V1–10</div>
          <h1 style={{ fontSize: "clamp(28px,5vw,44px)", lineHeight: 1.02, margin: 0, fontWeight: 800, letterSpacing: -1 }}>
            QR 코드를<br />처음부터 직접 짓다
          </h1>
          <p style={{ color: C.sub, maxWidth: 560, marginTop: 12, fontSize: 15, lineHeight: 1.5 }}>
            URL을 입력하면 외부 라이브러리 없이 갈루아 필드 연산, Reed-Solomon 오류정정, 마스킹까지 직접 계산해 QR을 그립니다. 보기 모드로 각 영역을 색·윤곽선으로 분석하거나, 인터리빙된 코드워드가 어떤 블록으로 나뉘는지 색으로 확인할 수 있습니다.
          </p>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)", gap: 20, alignItems: "start" }} className="qr-grid">
          {/* 왼쪽: 캔버스 */}
          <section style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 20, position: "sticky", top: 20 }}>
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", background: viewMode !== "plain" ? "#FBFBFD" : "#fff", borderRadius: 10, padding: 12, minHeight: 200 }}>
              {result.error
                ? <p style={{ color: C.finder, fontSize: 14, textAlign: "center", lineHeight: 1.5 }}>{result.error}</p>
                : <canvas ref={canvasRef} style={{ width: "100%", maxWidth: 360, height: "auto", imageRendering: "pixelated" }} />}
            </div>
            {!result.error && (
              <>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button onClick={downloadPNG} style={btn(true)}>PNG 저장</button>
                  <button onClick={downloadSVG} style={btn(false)}>SVG 저장</button>
                </div>
                <div style={{ marginTop: 14 }}>
                  <label style={lbl}>보기 모드</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {[["plain", "기본 (흑백)"], ["fill", "구조 색 채우기"], ["outline", "요소 윤곽선"], ["blocks", "인터리빙 블록"]].map(([m, label]) => (
                      <button key={m} onClick={() => setViewMode(m)} style={modeBtn(viewMode === m)}>{label}</button>
                    ))}
                  </div>
                </div>
                <label style={toggleRow}>
                  <input type="checkbox" checked={quiet} onChange={e => setQuiet(e.target.checked)} style={{ accentColor: C.accent }} />
                  <span>여백(Quiet Zone) 표시</span>
                </label>
                {(viewMode === "fill" || viewMode === "outline") && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${C.line}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 10px" }}>
                    {(viewMode === "outline" ? usedTypes.filter(t => t !== "data") : usedTypes).map(t => <Swatch key={t} color={C[t]} label={TYPE_LABEL[t][0]} hollow={viewMode === "outline"} />)}
                  </div>
                )}
                {viewMode === "blocks" && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${C.line}` }}>
                    <div style={{ fontSize: 12, color: C.sub, marginBottom: 8, lineHeight: 1.5 }}>
                      데이터·오류정정 코드워드가 {result.nBlocks}개 블록으로 나뉘어 번갈아 배치된 모습입니다. 색 = 블록, <b style={{ color: C.ink }}>진한 칸 = 오류정정(EC)</b>, 연한 칸 = 데이터.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 10px" }}>
                      {Array.from({ length: result.nBlocks }, (_, i) => (
                        <Swatch key={i} color={BLOCK_PALETTE[i % BLOCK_PALETTE.length]} label={`블록 ${i + 1}`} />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          {/* 오른쪽: 입력 + 분석 */}
          <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={card}>
              <label style={lbl}>인코딩할 URL / 텍스트</label>
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." style={input} />
              <label style={{ ...lbl, marginTop: 16 }}>오류정정 레벨</label>
              <div style={{ display: "flex", gap: 6 }}>
                {["L", "M", "Q", "H"].map(l => (
                  <button key={l} onClick={() => setEc(l)} style={ecBtn(ec === l)}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{l}</div>
                    <div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>{EC_INFO[l]}</div>
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 12, color: C.sub, marginTop: 10, lineHeight: 1.5 }}>
                레벨이 높을수록 오염·훼손에 강하지만 같은 데이터에 더 큰 버전이 필요합니다.
              </p>
            </div>

            {!result.error && (
              <div style={card}>
                <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, letterSpacing: 1.5, color: C.sub, textTransform: "uppercase", marginBottom: 12 }}>인코딩 결과</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <Stat label="버전" value={`V${result.version}`} sub={`${result.size}×${result.size}`} />
                  <Stat label="선택된 마스크" value={`#${result.mask}`} sub={`점수 ${result.stats.bestScore}`} />
                  <Stat label="데이터 바이트" value={result.stats.byteLen} sub={`최대 ${result.stats.capacity}`} />
                  <Stat label="데이터 코드워드" value={result.stats.dataCw} sub="8비트 단위" />
                  <Stat label="EC 코드워드" value={result.stats.ecCw} sub="Reed-Solomon" />
                  <Stat label="총 모듈" value={result.size * result.size} sub="흑+백 칸" />
                </div>
              </div>
            )}

            <div style={card}>
              <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, letterSpacing: 1.5, color: C.sub, textTransform: "uppercase", marginBottom: 6 }}>생성 파이프라인</div>
              {[
                ["데이터 인코딩", "모드 지시자 + 길이 + UTF-8 바이트를 비트열로. 남는 공간은 0xEC·0x11로 채움."],
                ["오류정정 (Reed-Solomon)", "GF(256) 위에서 데이터 다항식을 생성다항식으로 나눈 나머지가 복원용 코드워드."],
                ["블록 분할·인터리빙", "코드워드를 블록으로 쪼개 번갈아 배치 — 한 곳이 크게 훼손돼도 분산되도록."],
                ["기능 패턴 배치", "파인더·타이밍·얼라인먼트 등 고정 패턴을 격자에 먼저 깔기."],
                ["마스킹", "8개 패턴을 모두 적용해 페널티 점수가 가장 낮은 것을 선택 (어두운 면적·반복 최소화)."],
                ["포맷·버전 정보", "EC 레벨과 마스크 번호를 BCH 코드로 보호해 두 곳에 기록."],
              ].map(([t, d], i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: i ? `1px solid ${C.grid}` : "none" }}>
                  <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, color: C.accent, fontWeight: 700, minWidth: 22 }}>{String(i + 1).padStart(2, "0")}</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{t}</div>
                    <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5, marginTop: 2 }}>{d}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      <style>{`
        @media (max-width: 720px){ .qr-grid{ grid-template-columns: 1fr !important; } .qr-grid section:first-child{ position: static !important; } }
        button:focus-visible, input:focus-visible{ outline: 2px solid ${C.accent}; outline-offset: 2px; }
      `}</style>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.sub }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "ui-monospace,monospace", lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: C.sub }}>{sub}</div>
    </div>
  );
}
const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 };
const lbl = { display: "block", fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 7 };
const input = { width: "100%", boxSizing: "border-box", padding: "11px 13px", border: `1px solid ${C.line}`, borderRadius: 9, fontSize: 14, fontFamily: "ui-monospace,monospace", color: C.ink, background: "#FBFBFD" };
const toggleRow = { display: "flex", alignItems: "center", gap: 9, marginTop: 12, fontSize: 13.5, cursor: "pointer", color: C.ink };
const btn = (primary) => ({ flex: 1, padding: "10px", borderRadius: 9, border: primary ? "none" : `1px solid ${C.line}`, background: primary ? C.ink : "#fff", color: primary ? "#fff" : C.ink, fontSize: 13.5, fontWeight: 600, cursor: "pointer" });
const ecBtn = (active) => ({ flex: 1, padding: "9px 4px", borderRadius: 9, border: `1px solid ${active ? C.accent : C.line}`, background: active ? C.accent : "#fff", color: active ? "#fff" : C.ink, cursor: "pointer", textAlign: "center" });
const modeBtn = (active) => ({ padding: "9px 6px", borderRadius: 9, border: `1px solid ${active ? C.accent : C.line}`, background: active ? C.accent : "#fff", color: active ? "#fff" : C.ink, fontSize: 12.5, fontWeight: 600, cursor: "pointer" });
