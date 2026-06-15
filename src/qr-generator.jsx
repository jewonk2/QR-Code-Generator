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

// [5] 블록 분할 → EC 계산 → 인터리빙 (+ 각 코드워드의 출신 블록·종류·인터리빙 전 위치 기록)
function interleave(dataCw, v, ec) {
  const spec = EC_BLOCKS[v][ec]; const dB = [], eB = []; let p = 0;
  for (const [n, t, d] of spec) for (let b = 0; b < n; b++) { const blk = dataCw.slice(p, p + d); p += d; dB.push(blk); eB.push(rsEncode(blk, t - d)); }
  // 인터리빙 전(테이프) 순서에서의 위치: 블록0 데이터 전체 → 블록1 데이터 전체 → … → 블록0 EC → …
  const dataOff = [], ecOff = []; let acc = 0;
  for (let bi = 0; bi < dB.length; bi++) { dataOff[bi] = acc; acc += dB[bi].length; }
  for (let bi = 0; bi < eB.length; bi++) { ecOff[bi] = acc; acc += eB[bi].length; }
  const res = [], origin = [], tape = [];
  const md = Math.max(...dB.map(b => b.length));
  for (let i = 0; i < md; i++) for (let bi = 0; bi < dB.length; bi++) if (i < dB[bi].length) { res.push(dB[bi][i]); origin.push({ block: bi, kind: "data", i }); tape.push(dataOff[bi] + i); }
  const me = Math.max(...eB.map(b => b.length));
  for (let i = 0; i < me; i++) for (let bi = 0; bi < eB.length; bi++) if (i < eB[bi].length) { res.push(eB[bi][i]); origin.push({ block: bi, kind: "ec", i }); tape.push(ecOff[bi] + i); }
  return { res, origin, tape, nBlocks: dB.length, totalCw: acc };
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

// [7] 데이터 비트 지그재그 배치 (+ 각 셀의 블록·종류·코드워드 슬롯 기록)
function placeData(matrix, cw, origin) {
  const { m, fn, size } = matrix; const bits = [];
  for (const c of cw) for (let i = 7; i >= 0; i--) bits.push((c >> i) & 1);
  const blockGrid = Array.from({ length: size }, () => new Array(size).fill(-1));
  const kindGrid = Array.from({ length: size }, () => new Array(size).fill(null));
  const cwIndexGrid = Array.from({ length: size }, () => new Array(size).fill(-1));
  let idx = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) { if (col === 6) col--; for (let i = 0; i < size; i++) { const row = up ? size - 1 - i : i; for (let c = 0; c < 2; c++) { const cc = col - c; if (!fn[row][cc]) {
    if (idx < bits.length) { m[row][cc] = bits[idx]; const slot = Math.floor(idx / 8); cwIndexGrid[row][cc] = slot; const o = origin[slot]; if (o) { blockGrid[row][cc] = o.block; kindGrid[row][cc] = o.kind; } }
    else m[row][cc] = 0;
    idx++; } } } up = !up; }
  return { blockGrid, kindGrid, cwIndexGrid };
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
  const { res: finalCw, origin, tape, nBlocks } = interleave(dataCw, version, ec);
  const matrix = createMatrix(version);
  const { blockGrid, kindGrid, cwIndexGrid } = placeData(matrix, finalCw, origin);
  let best = null, bestMask = 0, bestScore = Infinity; const scores = [];
  for (let mk = 0; mk < 8; mk++) { const gg = applyMask(matrix, mk); placeFormatInfo(gg, matrix, ec, mk); placeVersionInfo(gg, matrix, version); const sc = penalty(gg); scores.push(sc); if (sc < bestScore) { bestScore = sc; best = gg; bestMask = mk; } }
  return {
    matrix: best, baseMatrix: matrix, typeGrid: matrix.tp, blockGrid, kindGrid, cwIndexGrid, origin, tape, nBlocks, version, ec, mask: bestMask, size: matrix.size, cwValues: finalCw,
    stats: { byteLen: bytes.length, dataCw: totalDataCodewords(version, ec), ecCw: totalEcCodewords(version, ec), capacity: maxByteCapacity(version, ec), scores, bestScore }
  };
}

// =====================================================================
//  UI
// =====================================================================
const C = {
  bg: "#E7E9EF", grid: "#D2D6E0", surface: "#FFFFFF", ink: "#16223A", sub: "#5B6577",
  line: "#C5CBD8", accent: "#2B50EC",
  finder: "#D7263D", timing: "#1B9AAA", alignment: "#6A4C93", format: "#E0930A", version: "#C45BAA", dark: "#111827", data: "#16223A", ec: "#2E9E5B",
};
// 이스터에그(로맨틱) 모드용 구조색 핑크 팔레트 — 기능(QR 분석) 색은 건드리지 않음
const PINK = { bg: "#FFEAF3", grid: "#FBD0E4", surface: "#FFF6FB", ink: "#9B2C5E", sub: "#C9669A", line: "#F3BCD8", accent: "#EC4899" };
let TH = C;   // 현재 적용 중인 구조 테마 (App 렌더 시 설정)
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
  format: ["포맷 정보", "오류정정 레벨과 마스크 번호를 담는 영역"],
  version: ["버전 정보", "심볼 버전 (V7+, BCH 보호)"],
  dark: ["다크 모듈", "항상 검정인 고정 모듈"],
  data: ["데이터", "입력 텍스트가 변환된 코드워드"],
  ec: ["오류정정", "데이터 복원에 쓰이는 코드워드"],
};
const EC_INFO = { L: "약 7% 복원", M: "약 15% 복원", Q: "약 25% 복원", H: "약 30% 복원" };

function MaskThumb({ result, mk }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv || result.error) return;
    const { baseMatrix, version, ec, size } = result;
    const gg = applyMask(baseMatrix, mk); placeFormatInfo(gg, baseMatrix, ec, mk); placeVersionInfo(gg, baseMatrix, version);
    const px = 2, b = 2, total = (size + b * 2) * px; cv.width = total; cv.height = total;
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, total, total); ctx.fillStyle = "#000";
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (gg[r][c]) ctx.fillRect((c + b) * px, (r + b) * px, px, px);
  }, [result, mk]);
  return <canvas ref={ref} style={{ width: "100%", height: "auto", imageRendering: "pixelated", borderRadius: 3, display: "block" }} />;
}

function Swatch({ color, label, hatch }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: TH.sub }}>
      <span style={{ width: 11, height: 11, background: "#fff", backgroundImage: hatch ? `repeating-linear-gradient(45deg, ${color} 0 1.5px, #fff 1.5px 4px)` : "none", backgroundColor: hatch ? "#fff" : color, border: hatch ? `1px solid ${TH.line}` : "none", boxSizing: "border-box", borderRadius: 2, flexShrink: 0 }} />{label}
    </span>
  );
}

export default function App() {
  const [url, setUrl] = useState("");
  const [ec, setEc] = useState("M");
  const [viewMode, setViewMode] = useState("plain"); // plain | fill | blocks | masks
  const [quiet, setQuiet] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [maskOverride, setMaskOverride] = useState(null); // null = 자동 선택(최저 페널티)
  const [centerMode, setCenterMode] = useState("none"); // none | image | text
  const [centerText, setCenterText] = useState("");
  const [centerImgURL, setCenterImgURL] = useState(null);  // SVG 임베드용 dataURL
  const [imgTick, setImgTick] = useState(0);
  const [centerN, setCenterN] = useState(5);
  const [romanticOn, setRomanticOn] = useState(false);  // 이스터에그: 한 번 켜지면 유지
  const canvasRef = useRef(null);
  const imgBmpRef = useRef(null);                          // 캔버스용 ImageBitmap/Image

  const loadImageFile = (f) => {
    if (!f) return;
    setCenterMode("image");
    const rd = new FileReader();                           // SVG 저장용 data URL
    rd.onload = () => setCenterImgURL(rd.result);
    rd.readAsDataURL(f);
    const done = (bmp) => { imgBmpRef.current = bmp; setImgTick(t => t + 1); };  // 캔버스용
    const fallback = () => { const im = new Image(); im.onload = () => done(im); im.src = URL.createObjectURL(f); };
    if (typeof createImageBitmap === "function") createImageBitmap(f).then(done).catch(fallback);
    else fallback();
  };
  const onPickImage = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; loadImageFile(f); };
  const onDropImage = (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; loadImageFile(f); };
  const onPasteImage = (e) => { const items = (e.clipboardData && e.clipboardData.items) || []; for (const it of items) { if (it.type && it.type.indexOf("image/") === 0) { loadImageFile(it.getAsFile()); break; } } };

  const result = useMemo(() => generateQR(url || " ", ec), [url, ec]);
  const PX = 12, BORDER = quiet ? 4 : 0;
  // 이스터에그: 입력이 'user_name=윤슬'이면 로맨틱 모드 발동, 이후 지워도 유지
  const trig = (url || "").trim() === "user_name=윤슬";
  if (trig && !romanticOn) setRomanticOn(true);
  const romantic = romanticOn || trig;
  TH = romantic ? { ...C, ...PINK } : C;
  const activeMask = (result.error || maskOverride == null) ? (result.mask ?? 0) : maskOverride;
  // 현재 화면에 표시할 매트릭스 (수동 마스크 선택 반영)
  const displayMatrix = useMemo(() => {
    if (result.error) return null;
    if (maskOverride == null || maskOverride === result.mask) return result.matrix;
    const gg = applyMask(result.baseMatrix, maskOverride);
    placeFormatInfo(gg, result.baseMatrix, result.ec, maskOverride);
    placeVersionInfo(gg, result.baseMatrix, result.version);
    return gg;
  }, [result, maskOverride]);

  // 인터리빙 전(테이프) 블록별 데이터·EC 길이
  const blocksInfo = useMemo(() => {
    if (result.error) return [];
    const spec = EC_BLOCKS[result.version][result.ec]; const out = [];
    for (const [n, t, d] of spec) for (let b = 0; b < n; b++) out.push({ dataLen: d, ecLen: t - d });
    return out;
  }, [result]);

  // 각 코드워드 슬롯의 그리드 중심 좌표 (분산 애니메이션용)
  const slotCentroids = useMemo(() => {
    if (result.error) return [];
    const { size, cwIndexGrid, origin } = result; const n = origin.length;
    const sx = new Array(n).fill(0), sy = new Array(n).fill(0), cnt = new Array(n).fill(0);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) { const s = cwIndexGrid[r][c]; if (s >= 0 && s < n) { sx[s] += (c + BORDER + 0.5) * PX; sy[s] += (r + BORDER + 0.5) * PX; cnt[s]++; } }
    return Array.from({ length: n }, (_, s) => cnt[s] ? { x: sx[s] / cnt[s], y: sy[s] / cnt[s] } : { x: 0, y: 0 });
  }, [result, quiet]);

  useEffect(() => {
    if (playing) return;
    const cv = canvasRef.current; if (!cv || result.error) return;
    const { typeGrid, blockGrid, kindGrid, size } = result;
    const matrix = displayMatrix;
    const total = (size + BORDER * 2) * PX;
    cv.width = total; cv.height = total;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, total, total);
    let darkCell = null;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      const on = matrix[r][c];
      let color = on ? "#000000" : "#FFFFFF";
      if (viewMode === "fill") {
        const t = typeGrid[r][c];
        if (t === "dark") { darkCell = { x: (c + BORDER) * PX, y: (r + BORDER) * PX }; continue; } // 빗금은 따로
        if (t === "data") { const base = kindGrid[r][c] === "ec" ? C.ec : C.data; color = on ? base : tint(base, 0.86); }
        else color = on ? (C[t] || "#000000") : "#F2F3F7";
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
    // 다크 모듈: 검은 빗금
    if (darkCell) {
      const { x, y } = darkCell;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, PX, PX); ctx.clip();
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(x, y, PX, PX);
      ctx.strokeStyle = C.dark; ctx.lineWidth = 1.5;
      for (let d = -PX; d < PX; d += 3) { ctx.beginPath(); ctx.moveTo(x + d, y); ctx.lineTo(x + d + PX, y + PX); ctx.stroke(); }
      ctx.restore();
    }
    // 가운데 삽입: 정확히 n×n 정중앙 셀을 비우고 이미지/텍스트 배치
    if (centerMode !== "none") {
      const cN = Math.max(1, Math.min(centerN, size - 8));
      const cs = Math.round((size - cN) / 2);
      const x = (cs + BORDER) * PX, y = (cs + BORDER) * PX, wpx = cN * PX;
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(x, y, wpx, wpx);
      if (centerMode === "image" && imgBmpRef.current) {
        const bmp = imgBmpRef.current, iw = bmp.naturalWidth || bmp.width || 1, ih = bmp.naturalHeight || bmp.height || 1;
        const sc = Math.min(wpx / iw, wpx / ih), dw = iw * sc, dh = ih * sc;
        ctx.drawImage(bmp, x + (wpx - dw) / 2, y + (wpx - dh) / 2, dw, dh);
      } else if (centerMode === "text" && centerText) {
        ctx.fillStyle = TH.ink; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        let fs = wpx; ctx.font = `800 ${fs}px ui-sans-serif,system-ui,sans-serif`;
        while (fs > 6 && ctx.measureText(centerText).width > wpx * 0.92) { fs -= 1; ctx.font = `800 ${fs}px ui-sans-serif,system-ui,sans-serif`; }
        ctx.fillText(centerText, x + wpx / 2, y + wpx / 2);
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      }
    }
  }, [result, viewMode, quiet, playing, displayMatrix, centerMode, centerText, centerImgURL, imgTick, centerN]);

  // 인터리빙 애니메이션: (1)빈 매트릭스 → (2)문자마다 8비트(모듈) 셀 묶음 생성 → (3)블록 분할 → (4)각 셀이 매트릭스 제자리로 흩어져 배치
  useEffect(() => {
    if (!playing) return;
    if (result.error || viewMode !== "blocks") { setPlaying(false); return; }
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    const { size, typeGrid, origin, tape, nBlocks, cwIndexGrid, cwValues } = result; const n = origin.length;
    const hx = (v) => "0x" + (v & 255).toString(16).toUpperCase().padStart(2, "0");
    const M = displayMatrix;
    const total = (size + BORDER * 2) * PX; cv.width = total; cv.height = total;

    // 각 코드워드 슬롯의 실제 셀(중심좌표 + 비트 on/off)
    const cellsBySlot = Array.from({ length: n }, () => []);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) { const s = cwIndexGrid[r][c]; if (s >= 0 && s < n) cellsBySlot[s].push({ x: (c + BORDER + 0.5) * PX, y: (r + BORDER + 0.5) * PX, on: M[r][c] }); }
    const inv = new Array(n); for (let k = 0; k < n; k++) inv[tape[k]] = k;          // 테이프 순서 → 슬롯
    const blockOf = (ti) => origin[inv[ti]].block, kindOf = (ti) => origin[inv[ti]].kind;
    const baseCol = (b) => BLOCK_PALETTE[b % BLOCK_PALETTE.length];
    const cellCol = (b, kd, on) => on ? (kd === "ec" ? shade(baseCol(b), 0.32) : baseCol(b)) : tint(baseCol(b), 0.82);

    // 데이터 / 오류정정을 두 띠로 분리 배치 (사이에 세로 여백 SEP), 화면 세로 중앙 정렬
    const nData = result.stats.dataCw, nEc = n - nData;
    let mc = Math.max(3, Math.round(PX * 0.46)), clusterW, clusterH, hGap, vGap, CPR, dRows, eRows, SEP, bandH;
    const layout = (m) => {
      clusterW = 2 * m; clusterH = 4 * m; hGap = Math.max(4, Math.round(m * 2.4)); vGap = Math.max(8, Math.round(m * 5.0));
      CPR = Math.max(3, Math.floor((total * 0.96) / (clusterW + hGap)));
      dRows = Math.ceil(nData / CPR); eRows = Math.ceil(Math.max(1, nEc) / CPR); SEP = clusterH * 1.6;
      bandH = dRows * (clusterH + vGap) - vGap + SEP + eRows * (clusterH + vGap) - vGap;
      return bandH;
    };
    while (layout(mc) > total * 0.78 && mc > 2) mc--; layout(mc);
    const topY = Math.max(PX * 1.2, (total - bandH) / 2);
    const offX = (total - (CPR * (clusterW + hGap) - hGap)) / 2;
    const dataBandH = dRows * (clusterH + vGap) - vGap;
    const clusterCenter = (ci) => {
      if (ci < nData) { const col = ci % CPR, row = Math.floor(ci / CPR); return { x: offX + col * (clusterW + hGap) + clusterW / 2, y: topY + row * (clusterH + vGap) + clusterH / 2 }; }
      const e = ci - nData, col = e % CPR, row = Math.floor(e / CPR);
      return { x: offX + col * (clusterW + hGap) + clusterW / 2, y: topY + dataBandH + SEP + row * (clusterH + vGap) + clusterH / 2 };
    };
    const subOff = (j) => ({ dx: ((j % 2) + 0.5) * mc - clusterW / 2, dy: (Math.floor(j / 2) + 0.5) * mc - clusterH / 2 });
    const pos = (ti, slot) => clusterCenter(slot);
    const splitCenter = (ti, b) => clusterCenter(ti < nData ? Math.min(ti + b * 2, nData - 1) : Math.min(ti + b * 2, n - 1)); // 분할은 각 띠 안에서만

    // 문자 ↔ 데이터 코드워드 세그먼트
    const chars = Array.from(url || " ");
    const startBit = 4 + charCountBits(result.version);
    let bo = 0; const charRange = chars.map(c => { const a = bo; bo += utf8Bytes(c).length; return [a, bo]; });
    const totalMsgBytes = bo;
    const ownerOf = (j) => { const mid = j * 8 + 4; if (mid < startBit) return "h"; const bp = (mid - startBit) / 8; if (bp >= totalMsgBytes) return "p"; let ci = 0; while (ci < charRange.length && bp >= charRange[ci][1]) ci++; return "c" + Math.min(ci, charRange.length - 1); };
    const segs = []; let cur = null;
    for (let j = 0; j < nData; j++) { const key = ownerOf(j); if (!cur || cur.key !== key) { if (cur) segs.push(cur); const isC = key[0] === "c"; cur = { key, start: j, end: j + 1, isChar: isC, glyph: isC ? chars[+key.slice(1)] : (key === "h" ? "헤더" : "패딩") }; } else cur.end = j + 1; }
    if (cur) segs.push(cur);
    // 모든 코드워드를 동일 속도로 생성하되, 오류정정 생성 전에 잠시 멈춤(PAUSE)
    const perCw = Math.max(45, Math.min(150, 2600 / n)), perEc = perCw * 2.0, PAUSE = 850;
    const genByTi = new Array(n);
    for (let ti = 0; ti < n; ti++) genByTi[ti] = ti < nData ? ti * perCw : nData * perCw + PAUSE + (ti - nData) * perEc;
    segs.forEach(s => { s.t0 = s.start * perCw; s.tEnd = s.end * perCw; const cc = pos(s.start, s.start); s.cx = cc.x; s.cy = cc.y; }); // 라벨은 세그먼트 첫 묶음 위에 고정
    const P1 = nData * perCw + PAUSE + nEc * perEc, HOLD = 1500, SPLIT = 950, PLACE = 2800, splitStart = P1 + HOLD, P2 = splitStart + SPLIT, ENDT = P2 + PLACE;

    // 입자(개별 모듈 셀) 목록
    const parts = [];
    for (let ti = 0; ti < n; ti++) { const k = inv[ti], b = blockOf(ti), kd = kindOf(ti), cells = cellsBySlot[k]; for (let j = 0; j < cells.length; j++) parts.push({ ti, b, kd, on: cells[j].on, rx: cells[j].x, ry: cells[j].y, off: subOff(j), gen: genByTi[ti] }); }

    // 각 오류정정 코드워드: 생성 시각 + 실제 계산된 바이트값 (리드-솔로몬 결과) + 블록
    const BL = BLOCK_PALETTE.length;
    const ecTokens = [];
    for (let ti = nData; ti < n; ti++) { const k = inv[ti]; ecTokens.push({ ti, b: blockOf(ti), gen: genByTi[ti], val: cwValues[k] }); }
    const ecStart0 = nData * perCw + PAUSE;   // 오류정정 생성 시작 시각
    // 문자가 아닌 데이터 코드워드(헤더·채움): 실제 바이트값을 띄움
    const dataTagTokens = [];
    for (let ti = 0; ti < nData; ti++) { const o = ownerOf(ti); if (o === "h" || o === "p") dataTagTokens.push({ ti, gen: genByTi[ti], val: cwValues[inv[ti]] }); }

    const ease = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const t0 = performance.now(); let raf;

    const frame = (now) => {
      const T = now - t0;
      const g3 = T > P2 ? Math.min((T - P2) / PLACE, 1) : 0;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, total, total);

      // (1) 빈 매트릭스: 기능 패턴은 처음부터 옅게, 배치 단계에서 또렷하게
      ctx.save(); ctx.globalAlpha = 0.22 + 0.78 * g3; ctx.fillStyle = "#E3E7EF";
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (typeGrid[r][c] !== "data") ctx.fillRect((c + BORDER) * PX, (r + BORDER) * PX, PX, PX);
      ctx.restore();

      for (const p of parts) {
        let cx, cy, s;
        if (T < splitStart) {                           // ① 생성 + ②잠깐 정지(모든 선이 보이는 구간)
          if (T < p.gen) continue; const c0 = pos(p.ti, p.ti); cx = c0.x + p.off.dx; cy = c0.y + p.off.dy; s = mc;
        } else if (T < P2) {                            // ③ 분할: 블록 간격 벌어짐(각 띠 안에서)
          const e = ease((T - splitStart) / SPLIT); const c0 = pos(p.ti, p.ti), c1 = splitCenter(p.ti, p.b);
          cx = c0.x + (c1.x - c0.x) * e + p.off.dx; cy = c0.y + (c1.y - c0.y) * e + p.off.dy; s = mc;
        } else {                                        // ④ 배치: 각 셀이 블록 순서대로 제자리로 흩어지며 커짐
          const delay = (p.b / Math.max(1, nBlocks)) * 0.4; const lt = Math.max(0, Math.min((g3 - delay) / 0.6, 1)); const e = ease(lt);
          const c1 = splitCenter(p.ti, p.b), sx = c1.x + p.off.dx, sy = c1.y + p.off.dy;
          cx = sx + (p.rx - sx) * e; cy = sy + (p.ry - sy) * e; s = mc + (PX - mc) * e;
        }
        ctx.fillStyle = cellCol(p.b, p.kd, p.on); ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
      }

      // 문자가 아닌 데이터(헤더·채움)와 오류정정 묶음 위에 실제 바이트값을 한 글자씩 타이핑 (일정 시간 뒤 사라짐)
      if (T < P2) {
        let sf = 1; if (T > splitStart) sf = Math.max(0, 1 - (T - splitStart) / SPLIT);
        if (sf > 0) {
          ctx.font = `700 ${Math.round(Math.max(8, mc * 1.4))}px ui-monospace,monospace`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
          const drawTok = (tk, col) => {
            if (T < tk.gen) return;
            const age = T - tk.gen;
            let la = 1;
            if (age < 120) la = age / 120;
            else if (age > 1300) la = Math.max(0, 1 - (age - 1300) / 600);   // 약 1.9초 뒤 사라짐
            const a = Math.min(la, sf);
            if (a <= 0) return;
            const full = hx(tk.val), nch = Math.min(full.length, Math.floor(age / 40) + 1);
            const c = clusterCenter(tk.ti);
            ctx.globalAlpha = a; ctx.fillStyle = col; ctx.fillText(full.slice(0, nch), c.x, c.y - clusterH / 2 - mc * 0.45);
          };
          for (const tk of dataTagTokens) drawTok(tk, TH.sub);                                  // 헤더·채움 = 회색
          for (const et of ecTokens) drawTok(et, shade(BLOCK_PALETTE[et.b % BL], 0.32));        // 오류정정 = 블록색
          ctx.globalAlpha = 1; ctx.textAlign = "left";
        }
      }

      // 라벨: 데이터 문자(파란 글자)만 표시 (기능/EC 텍스트 없음)
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      for (const s of segs) {
        if (!s.isChar) continue;
        const TAIL = 1600;
        if (T < s.t0 || T > s.tEnd + TAIL) continue;
        let a = 1;
        if (T < s.t0 + 140) a = (T - s.t0) / 140;            // 페이드인
        else if (T > s.tEnd + 550) a = Math.max(0, 1 - (T - (s.tEnd + 550)) / (TAIL - 550)); // 한참 머물다 천천히 사라짐
        ctx.globalAlpha = a; ctx.fillStyle = TH.accent; ctx.font = `700 ${Math.round(Math.max(12, mc * 2.6))}px ui-sans-serif,system-ui,sans-serif`;
        ctx.fillText(s.glyph === " " ? "␣" : s.glyph, s.cx, s.cy - clusterH / 2 - mc * 0.6);
      }
      ctx.globalAlpha = 1; ctx.textAlign = "left";
      if (T < ENDT) raf = requestAnimationFrame(frame); else setPlaying(false);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, result, viewMode, quiet, displayMatrix, url]);

  // 입력 변경 시 애니메이션 정지·마스크 자동선택 복귀 / 모드 변경 시 애니메이션만 정지
  useEffect(() => { setPlaying(false); setMaskOverride(null); }, [url, ec]);
  useEffect(() => { setPlaying(false); }, [viewMode]);

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
    if (result.error) return; const size = result.size, matrix = displayMatrix; const b = BORDER, t = size + b * 2;
    let rects = ""; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) rects += `<rect x="${c + b}" y="${r + b}" width="1" height="1"/>`;
    let extra = "";
    if (centerMode !== "none") {
      const cN = Math.max(1, Math.min(centerN, size - 8)), cs = Math.round((size - cN) / 2);
      extra += `<rect x="${cs + b}" y="${cs + b}" width="${cN}" height="${cN}" fill="#fff"/>`;
      if (centerMode === "image" && centerImgURL) extra += `<image href="${centerImgURL}" x="${cs + b}" y="${cs + b}" width="${cN}" height="${cN}" preserveAspectRatio="xMidYMid meet"/>`;
      else if (centerMode === "text" && centerText) { const esc = centerText.replace(/[<>&]/g, m => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m])); extra += `<text x="${cs + b + cN / 2}" y="${cs + b + cN / 2}" font-size="${cN * 0.62}" font-family="sans-serif" font-weight="800" fill="#16223A" text-anchor="middle" dominant-baseline="central">${esc}</text>`; }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${t}" shape-rendering="crispEdges"><rect width="${t}" height="${t}" fill="#fff"/><g fill="#000">${rects}</g>${extra}</svg>`;
    const u = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a"); a.download = `qr_${Date.now()}.svg`; a.href = u;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1500);
  };

  const usedTypes = ["finder", "timing", "alignment", "format", ...(result.version >= 7 ? ["version"] : []), "dark", "data", "ec"];

  return (
    <div style={{ minHeight: "100vh", position: "relative", overflow: "hidden", background: romantic ? "linear-gradient(160deg,#FFEAF3,#FFD9EC 60%,#FFE8F4)" : TH.bg, backgroundImage: romantic ? "none" : `linear-gradient(${TH.grid} 1px,transparent 1px),linear-gradient(90deg,${TH.grid} 1px,transparent 1px)`, backgroundSize: "22px 22px", color: TH.ink, fontFamily: "ui-sans-serif,system-ui,'Segoe UI',sans-serif", padding: "32px 18px 64px" }}>
      {romantic && (
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}>
          {Array.from({ length: 54 }).map((_, i) => {
            const r = (k) => { const x = Math.sin((i + 1) * k) * 10000; return x - Math.floor(x); };
            const hearts = ["♥", "💗", "💕", "💖", "🩷", "💓"], cols = ["#EC4899", "#F472B6", "#FB7185", "#F9A8D4", "#FF8FB7"];
            const dur = (4 + r(6.6) * 5).toFixed(2), delay = (-r(3.1) * 6).toFixed(2);
            return <span key={"h" + i} style={{ position: "absolute", left: r(12.9) * 100 + "%", top: r(78.2) * 100 + "%", fontSize: 12 + r(3.7) * 36, opacity: 0.14 + r(9.3) * 0.26, color: cols[i % cols.length], animation: `floaty ${dur}s ease-in-out ${delay}s infinite` }}>{hearts[Math.floor(r(2.2) * hearts.length)]}</span>;
          })}
          {Array.from({ length: 30 }).map((_, i) => {
            const r = (k) => { const x = Math.sin((i + 7) * k + 3.3) * 10000; return x - Math.floor(x); };
            const sp = ["✨", "✦", "✧", "·", "❀"], dur = (1.6 + r(4.4) * 2.4).toFixed(2), delay = (-r(2.7) * 4).toFixed(2);
            return <span key={"s" + i} style={{ position: "absolute", left: r(5.4) * 100 + "%", top: r(9.1) * 100 + "%", fontSize: 8 + r(6.2) * 16, color: i % 3 ? "#FFC1DE" : "#FF7FB0", animation: `twinkle ${dur}s ease-in-out ${delay}s infinite` }}>{sp[Math.floor(r(8.8) * sp.length)]}</span>;
          })}
        </div>
      )}
      <div style={{ maxWidth: 1000, margin: "0 auto", position: "relative", zIndex: 1 }}>
        <header style={{ marginBottom: 26 }}>
          <div style={{ fontFamily: "ui-monospace,'SFMono-Regular',Menlo,monospace", fontSize: 12, letterSpacing: 2, color: TH.accent, textTransform: "uppercase", marginBottom: 8 }}>ISO/IEC 18004 · Byte mode · V1–10</div>
          <h1 style={{ fontSize: "clamp(28px,5vw,44px)", lineHeight: 1.02, margin: 0, fontWeight: 800, letterSpacing: -1 }}>
            QR Code<br />Generator{romantic && <span style={{ color: TH.accent }}> ♥</span>}
          </h1>
          <p style={{ color: TH.sub, maxWidth: 560, marginTop: 12, fontSize: 15, lineHeight: 1.5 }}>
            URL을 입력하면 외부 라이브러리 없이 갈루아 필드 연산, Reed-Solomon 오류정정, 마스킹까지 직접 계산해 QR을 그립니다. 보기 모드로 각 기능 영역(데이터·오류정정 분리)을 색으로 분석하고, 인터리빙 과정을 애니메이션으로 보거나, 8가지 마스크를 점수와 함께 비교·선택할 수 있습니다.
          </p>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)", gap: 20, alignItems: "start" }} className="qr-grid">
          {/* 왼쪽: 캔버스 */}
          <section style={{ background: TH.surface, border: `1px solid ${TH.line}`, borderRadius: 14, padding: 20, position: "sticky", top: 20 }}>
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
                  <label style={lbl()}>보기 모드</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {[["plain", "기본 (흑백)"], ["fill", "기능 표시"], ["blocks", "인터리빙 블록"], ["masks", "마스킹 비교"]].map(([m, label]) => (
                      <button key={m} onClick={() => setViewMode(m)} style={modeBtn(viewMode === m)}>{label}</button>
                    ))}
                  </div>
                </div>
                <label style={toggleRow()}>
                  <input type="checkbox" checked={quiet} onChange={e => setQuiet(e.target.checked)} style={{ accentColor: TH.accent }} />
                  <span>여백(Quiet Zone) 표시</span>
                </label>
                {viewMode === "fill" && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${TH.line}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 10px" }}>
                    {usedTypes.map(t => <Swatch key={t} color={C[t]} label={TYPE_LABEL[t][0]} hatch={t === "dark"} />)}
                  </div>
                )}
                {viewMode === "blocks" && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${TH.line}` }}>
                    <div style={{ fontSize: 11.5, color: TH.sub, marginBottom: 5 }}>인터리빙 전 (블록별 코드워드)</div>
                    <div style={{ display: "flex", height: 18, borderRadius: 5, overflow: "hidden", border: `1px solid ${TH.line}` }}>
                      {(() => {
                        const segs = []; const L = BLOCK_PALETTE.length;
                        blocksInfo.forEach((b, i) => segs.push(<div key={"d" + i} title={`블록 ${i + 1} 데이터 ${b.dataLen}개`} style={{ flexGrow: b.dataLen, background: BLOCK_PALETTE[i % L] }} />));
                        blocksInfo.forEach((b, i) => segs.push(<div key={"e" + i} title={`블록 ${i + 1} 오류정정 ${b.ecLen}개`} style={{ flexGrow: b.ecLen, background: shade(BLOCK_PALETTE[i % L], 0.32) }} />));
                        return segs;
                      })()}
                    </div>
                    <button onClick={() => setPlaying(true)} disabled={playing} style={{ ...btn(true), marginTop: 10, opacity: playing ? 0.55 : 1, cursor: playing ? "default" : "pointer" }}>
                      {playing ? "분산되는 중…" : "▶ 인터리빙 분산 애니메이션"}
                    </button>
                    <div style={{ fontSize: 11, color: TH.sub, marginTop: 8, lineHeight: 1.5 }}>
                      오류정정은 <b style={{ color: TH.ink }}>리드-솔로몬</b> 방식입니다. 데이터가 먼저 생성된 뒤 잠시 멈췄다가, 아래쪽에 오류정정 코드가 따로 만들어집니다. 이때 각 묶음 위에는 <b style={{ color: TH.ink }}>데이터로부터 실제 계산된 바이트값</b>이 하나씩 타이핑되듯 나타납니다.
                    </div>
                    <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 10px" }}>
                      {Array.from({ length: result.nBlocks }, (_, i) => (
                        <Swatch key={i} color={BLOCK_PALETTE[i % BLOCK_PALETTE.length]} label={`블록 ${i + 1}`} />
                      ))}
                    </div>
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${TH.line}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 10px" }}>
                      <Swatch color={BLOCK_PALETTE[0]} label="데이터 (연한색)" />
                      <Swatch color={shade(BLOCK_PALETTE[0], 0.32)} label="오류정정 (진한색)" />
                    </div>
                  </div>
                )}
                {viewMode === "masks" && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${TH.line}` }}>
                    <div style={{ fontSize: 12, color: TH.sub, marginBottom: 8, lineHeight: 1.5 }}>
                      마스크 8종의 페널티 점수를 계산해 <b style={{ color: TH.ink }}>가장 낮은 #{result.mask + 1}</b>을 자동 선택합니다. 점수가 낮을수록 명암이 고르게 퍼져 잘 읽힙니다. 썸네일을 누르면 다른 마스크를 직접 적용해 비교할 수 있습니다.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 7 }}>
                      {result.stats.scores.map((sc, mk) => (
                        <div key={mk} onClick={() => setMaskOverride(mk)} title={`마스크 #${mk + 1} 적용`}
                          style={{ textAlign: "center", padding: 6, borderRadius: 8, cursor: "pointer", border: `2px solid ${mk === activeMask ? TH.accent : TH.line}`, background: mk === activeMask ? "#EEF2FF" : "#fff" }}>
                          <MaskThumb result={result} mk={mk} />
                          <div style={{ fontSize: 11, fontWeight: 700, marginTop: 4 }}>#{mk + 1}{mk === result.mask ? " ★" : ""}{mk === activeMask && mk !== result.mask ? " ✓" : ""}</div>
                          <div style={{ fontSize: 10.5, color: mk === activeMask ? TH.accent : TH.sub }}>{sc}점</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: TH.sub, marginTop: 8 }}>★ 자동 선택(최저 점수) · ✓ 현재 수동 선택</div>
                    {maskOverride != null && maskOverride !== result.mask && (
                      <button onClick={() => setMaskOverride(null)} style={{ ...btn(false), marginTop: 10 }}>자동 선택(#{result.mask + 1})으로 되돌리기</button>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

          {/* 오른쪽: 입력 + 분석 */}
          <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={card()}>
              <label style={lbl()}>인코딩할 URL / 텍스트</label>
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." style={input()} />
              <label style={{ ...lbl(), marginTop: 16 }}>오류정정 레벨</label>
              <div style={{ display: "flex", gap: 6 }}>
                {["L", "M", "Q", "H"].map(l => (
                  <button key={l} onClick={() => setEc(l)} style={ecBtn(ec === l)}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{l}</div>
                    <div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>{EC_INFO[l]}</div>
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 12, color: TH.sub, marginTop: 10, lineHeight: 1.5 }}>
                레벨이 높을수록 오염·훼손에 강하지만 같은 데이터에 더 큰 버전이 필요합니다.
              </p>
            </div>

            {!result.error && (() => {
              const limit = { L: 4, M: 8, Q: 14, H: 16 }[result.ec];
              const cN = Math.max(1, Math.min(centerN, result.size - 8));
              const areaPct = (cN * cN) / (result.size * result.size) * 100;
              const risky = areaPct > limit;
              return (
                <div style={card()}>
                  <label style={lbl()}>가운데 삽입 (로고 / 텍스트)</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                    {[["none", "없음"], ["image", "이미지"], ["text", "텍스트"]].map(([m, label]) => (
                      <button key={m} onClick={() => setCenterMode(m)} style={modeBtn(centerMode === m)}>{label}</button>
                    ))}
                  </div>
                  {centerMode === "image" && (
                    <div style={{ marginBottom: 10 }}>
                      <div onDrop={onDropImage} onDragOver={e => e.preventDefault()} onPaste={onPasteImage} tabIndex={0}
                        style={{ border: `1.5px dashed ${TH.line}`, borderRadius: 8, padding: "14px 10px", textAlign: "center", fontSize: 12, color: TH.sub, outline: "none", background: "#FAFBFD" }}>
                        이미지를 여기로 <b style={{ color: TH.ink }}>끌어다 놓거나</b>, 클릭 후 <b style={{ color: TH.ink }}>붙여넣기(Ctrl/⌘+V)</b>
                        <div style={{ marginTop: 8 }}>
                          <input type="file" accept="image/*" onChange={onPickImage} style={{ fontSize: 12, color: TH.sub }} />
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: TH.sub, marginTop: 6 }}>{centerImgURL ? "이미지가 가운데에 배치됩니다." : "파일 선택창이 안 열리면 드래그·붙여넣기를 쓰세요."}</div>
                    </div>
                  )}
                  {centerMode === "text" && (
                    <input value={centerText} onChange={e => setCenterText(e.target.value)} maxLength={6} placeholder="" style={{ ...input(), marginBottom: 10 }} />
                  )}
                  {centerMode !== "none" && (
                    <>
                      <label style={{ ...lbl(), marginTop: 0 }}>비울 영역 크기: {cN}×{cN} 모듈</label>
                      <input type="range" min={3} max={Math.min(21, result.size - 8)} value={centerN} onChange={e => setCenterN(+e.target.value)} style={{ width: "100%", accentColor: TH.accent }} />
                      <p style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5, color: risky ? C.finder : TH.sub }}>
                        중앙 가림 면적 약 <b>{areaPct.toFixed(1)}%</b> · 현재 오류정정 레벨({result.ec}) 한계 약 {limit}%
                        {risky ? " — 한계를 넘어 스캔이 실패할 수 있습니다. 오류정정 레벨을 올리거나 크기를 줄이세요." : " — 복원 가능 범위입니다."}
                      </p>
                    </>
                  )}
                </div>
              );
            })()}

            {!result.error && (
              <div style={card()}>
                <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, letterSpacing: 1.5, color: TH.sub, textTransform: "uppercase", marginBottom: 12 }}>인코딩 결과</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <Stat label="버전" value={`V${result.version}`} sub={`${result.size}×${result.size}`} />
                  <Stat label="적용된 마스크" value={`#${activeMask + 1}`} sub={maskOverride != null && maskOverride !== result.mask ? `수동 · 점수 ${result.stats.scores[activeMask]}` : `자동 · 점수 ${result.stats.bestScore}`} />
                  <Stat label="데이터 바이트" value={result.stats.byteLen} sub={`최대 ${result.stats.capacity}`} />
                  <Stat label="데이터 코드워드" value={result.stats.dataCw} sub="8비트 단위" />
                  <Stat label="오류정정 코드워드" value={result.stats.ecCw} sub="복원용" />
                  <Stat label="총 모듈" value={result.size * result.size} sub="흑+백 칸" />
                </div>
              </div>
            )}

            <div style={card()}>
              <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, letterSpacing: 1.5, color: TH.sub, textTransform: "uppercase", marginBottom: 6 }}>생성 파이프라인</div>
              {[
                ["데이터 인코딩", "입력한 글자를 컴퓨터가 다루는 0과 1의 비트로 바꿉니다."],
                ["오류정정", "일부가 가려지거나 더러워져도 복원할 수 있도록 여분의 복구용 정보를 덧붙입니다."],
                ["블록 분할·인터리빙", "정보를 여러 조각으로 나눠 코드 곳곳에 흩어 놓아, 한 부분이 크게 훼손돼도 살아남게 합니다."],
                ["기능 패턴 배치", "스캐너가 위치와 방향을 잡도록 모서리의 큰 사각형 같은 고정 무늬를 먼저 그립니다."],
                ["마스킹", "검은 칸이 한쪽에 몰리지 않도록 8가지 규칙을 시험해 가장 잘 읽히는 무늬를 고릅니다."],
                ["포맷·버전 정보", "어떤 설정으로 만들었는지 알려주는 정보를 스캐너가 읽기 쉬운 자리에 기록합니다."],
              ].map(([t, d], i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: i ? `1px solid ${TH.grid}` : "none" }}>
                  <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, color: TH.accent, fontWeight: 700, minWidth: 22 }}>{String(i + 1).padStart(2, "0")}</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{t}</div>
                    <div style={{ fontSize: 12.5, color: TH.sub, lineHeight: 1.5, marginTop: 2 }}>{d}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      <style>{`
        @media (max-width: 720px){ .qr-grid{ grid-template-columns: 1fr !important; } .qr-grid section:first-child{ position: static !important; } }
        button:focus-visible, input:focus-visible{ outline: 2px solid ${TH.accent}; outline-offset: 2px; }
        @keyframes floaty{ 0%,100%{ transform: translateY(0) rotate(-6deg); } 50%{ transform: translateY(-16px) rotate(6deg); } }
        @keyframes twinkle{ 0%,100%{ opacity: 0.15; transform: scale(0.7); } 50%{ opacity: 0.95; transform: scale(1.25); } }
      `}</style>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: TH.sub }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "ui-monospace,monospace", lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: TH.sub }}>{sub}</div>
    </div>
  );
}
const card = () => ({ background: TH.surface, border: `1px solid ${TH.line}`, borderRadius: 14, padding: 18 });
const lbl = () => ({ display: "block", fontSize: 12, fontWeight: 600, color: TH.sub, marginBottom: 7 });
const input = () => ({ width: "100%", boxSizing: "border-box", padding: "11px 13px", border: `1px solid ${TH.line}`, borderRadius: 9, fontSize: 14, fontFamily: "ui-monospace,monospace", color: TH.ink, background: "#FBFBFD" });
const toggleRow = () => ({ display: "flex", alignItems: "center", gap: 9, marginTop: 12, fontSize: 13.5, cursor: "pointer", color: TH.ink });
const btn = (primary) => ({ flex: 1, padding: "10px", borderRadius: 9, border: primary ? "none" : `1px solid ${TH.line}`, background: primary ? TH.ink : "#fff", color: primary ? "#fff" : TH.ink, fontSize: 13.5, fontWeight: 600, cursor: "pointer" });
const ecBtn = (active) => ({ flex: 1, padding: "9px 4px", borderRadius: 9, border: `1px solid ${active ? TH.accent : TH.line}`, background: active ? TH.accent : "#fff", color: active ? "#fff" : TH.ink, cursor: "pointer", textAlign: "center" });
const modeBtn = (active) => ({ padding: "9px 6px", borderRadius: 9, border: `1px solid ${active ? TH.accent : TH.line}`, background: active ? TH.accent : "#fff", color: active ? "#fff" : TH.ink, fontSize: 12.5, fontWeight: 600, cursor: "pointer" });
