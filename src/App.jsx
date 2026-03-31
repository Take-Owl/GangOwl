import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import AdSlot, { ExportAd } from "./AdSlot";
import { isWeb, isDesktop, saveFileWithDialog, pickExportFolder, saveFileToFolder, checkForUpdates } from "./edition";

// ─── Constants ────────────────────────────────────────────────────────────────
const SCREEN_DPI = 96;
const STORAGE_KEY = "gangsheet-v6-saves";
const PRESETS_KEY  = "gangsheet-v6-presets";
const BUILT_IN_TEMPLATES=[
  {name:"DTF Roll 22×200",sheetW:22,sheetH:200,sheetDPI:300,margin:0,gap:0.25,inkCostPerSqIn:0,builtIn:true},
  {name:"DTF Roll 24×100",sheetW:24,sheetH:100,sheetDPI:300,margin:0,gap:0.25,inkCostPerSqIn:0,builtIn:true},
  {name:"DTF Sheet 13×19",sheetW:13,sheetH:19,sheetDPI:300,margin:0.25,gap:0.25,inkCostPerSqIn:0,builtIn:true},
  {name:"DTF Sheet 8.5×11",sheetW:8.5,sheetH:11,sheetDPI:300,margin:0.25,gap:0.25,inkCostPerSqIn:0,builtIn:true},
  {name:"Sublimation 13×19",sheetW:13,sheetH:19,sheetDPI:300,margin:0.5,gap:0.25,inkCostPerSqIn:0,builtIn:true},
  {name:"Vinyl 24×36",sheetW:24,sheetH:36,sheetDPI:150,margin:0.5,gap:0.5,inkCostPerSqIn:0,builtIn:true},
];

function ipx(i, dpi) { return Math.round(i * dpi); }
function sqIn(pl)    { return pl.reduce((a,p) => a + p.w * p.h, 0); }

let _id = 1;
const uid = () => _id++;

// ─── Sheet factory ────────────────────────────────────────────────────────────
function makeSheet(o = {}) {
  return {
    id: uid(), label: "Sheet 1",
    sheetW: 22, sheetH: 200, sheetDPI: 300,
    margin: 0, showMargin: true,
    showGrid: true, gridSize: 0.5, gridStyle: "lines", snapToGrid: false, snapSize: 0.25, canvasBg: "checker", inkCostPerSqIn: 0,
    placements: [], groups: [],
    uploadedImg: null, placeW: "", placeH: "",
    lockSide: "width", copies: 1, gap: 0.25,
    rotation: 0, flipH: false, flipV: false,
    zoom: 1, scrollX: 0, scrollY: 0, mirrorExport: false, autoRotateFill: false, autoRotatePlace: false, autoDistribute: false, snapToItems: false, autoTrimImport: true,
    cutEnabled: false, cutShape: "rounded-rect", cutOffset: 0.05, cutWidth: 1, cutColor: "#FF0000", cutRadius: 0.1,
    jobNotes: "", warning: "", extraSizes: [],
    ...o,
  };
}

// ─── Packer ───────────────────────────────────────────────────────────────────
function packItems(existing, w, h, gap, sW, sH, count, margin) {
  const placed = [], eps = 0.0001;
  const minX = margin, minY = margin, maxX = sW - margin, maxY = sH - margin;
  const ov = (ax,ay,aw,ah,bx,by,bw,bh,g) => ax<bx+bw+g&&ax+aw+g>bx&&ay<by+bh+g&&ay+ah+g>by;
  const fits = (x,y) => x>=minX-eps&&y>=minY-eps&&x+w<=maxX+eps&&y+h<=maxY+eps;
  const col   = (x,y) => [...existing,...placed].some(i=>ov(x,y,w,h,i.x,i.y,i.w,i.h,gap));
  const cm = new Map();
  const addC = (x,y) => { const k=`${x.toFixed(4)},${y.toFixed(4)}`; if(!cm.has(k)) cm.set(k,{x,y}); };
  const getC = () => [...cm.values()].sort((a,b)=>a.y!==b.y?a.y-b.y:a.x-b.x);
  addC(minX+gap, minY+gap);
  for (const i of existing) { addC(i.x+i.w+gap,i.y); addC(i.x,i.y+i.h+gap); }
  for (let i=0; i<count; i++) {
    let ok=false;
    for (const {x,y} of getC()) {
      if (!fits(x,y)||col(x,y)) continue;
      placed.push({x,y,w,h}); addC(x+w+gap,y); addC(x,y+h+gap); ok=true; break;
    }
    if (!ok) break;
  }
  return placed;
}

function fillSheet(designs, sW, sH, margin, existing=[], autoRotate=false) {
  let all=[...existing], changed=true;
  while (changed) {
    changed=false;
    for (const d of designs) {
      const r=packItems(all,d.w,d.h,d.gap,sW,sH,1,margin);
      let rR=[];
      if(autoRotate&&d.w!==d.h) rR=packItems(all,d.h,d.w,d.gap,sW,sH,1,margin);
      if(rR.length&&!r.length){ all.push({...rR[0],...d,w:d.h,h:d.w,rotation:((d.rotation||0)+90)%360}); changed=true; }
      else if(r.length){ all.push({...r[0],...d}); changed=true; }
    }
  }
  return all.slice(existing.length);
}

// ─── Content-aware nesting (raster mask approach) ────────────────────────────
// Resolution: pixels per inch in the nesting grid. Lower = faster, coarser.
const NEST_PPI = 15; // 15 pixels per inch → ~0.067" resolution (fast, plenty accurate for placement)

// Extract a binary alpha mask from an image at nesting resolution
function extractMask(img, wIn, hIn, rotation=0) {
  const pw = Math.ceil(wIn * NEST_PPI), ph = Math.ceil(hIn * NEST_PPI);
  const c = document.createElement("canvas");
  const isRot = rotation === 90 || rotation === 270;
  const cw = isRot ? ph : pw, ch = isRot ? pw : ph;
  c.width = cw; c.height = ch;
  const ctx = c.getContext("2d");
  if (rotation) {
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.translate(-pw / 2, -ph / 2);
  }
  ctx.drawImage(img, 0, 0, pw, ph);
  const data = ctx.getImageData(0, 0, cw, ch).data;
  const mask = new Uint8Array(cw * ch);
  for (let i = 0; i < mask.length; i++) {
    if (data[i * 4 + 3] > 20) mask[i] = 1;
  }
  return { mask, w: cw, h: ch };
}

// ─── Clean mask generation for nesting ───────────────────────────────────────
// Every mask returns { mask, w, h, contentOffsetX, contentOffsetY }
// contentOffset = grid pixels from mask top-left to content (0,0)

function buildItemMask(img, wIn, hIn, cutEnabled, cutShape, cutOffset, cutRadius, rotation) {
  const rot = rotation || 0;
  if (!cutEnabled || !cutShape || cutShape === "none") {
    const m = extractMask(img, wIn, hIn, rot);
    return { mask: m.mask, w: m.w, h: m.h, contentOffsetX: 0, contentOffsetY: 0 };
  }
  if (cutShape === "die-cut") {
    return buildDieCutMaskClean(img, wIn, hIn, cutOffset, rot);
  }
  return buildShapeMask(img, wIn, hIn, cutShape, cutOffset, cutRadius || 0, rot);
}

// Die-cut: render contour at 2x resolution, downscale for accuracy
function buildDieCutMaskClean(img, wIn, hIn, cutOffsetIn, rotation) {
  const RENDER = NEST_PPI * 2; // 60 PPI for quality
  const pw = Math.ceil(wIn * RENDER), ph = Math.ceil(hIn * RENDER);
  const offsetPx = cutOffsetIn * RENDER;
  const blurR = Math.max(5, Math.max(pw, ph) * 0.06);
  const pad = Math.ceil(offsetPx + blurR * 2.5 + 4);
  const tw = pw + pad * 2, th = ph + pad * 2;
  // Step 1: white silhouette
  const sil = document.createElement("canvas"); sil.width = tw; sil.height = th;
  const s = sil.getContext("2d");
  s.drawImage(img, pad, pad, pw, ph);
  s.globalCompositeOperation = "source-in"; s.fillStyle = "#fff"; s.fillRect(0, 0, tw, th);
  s.globalCompositeOperation = "source-over";
  // Step 2: blur + threshold
  const con = document.createElement("canvas"); con.width = tw; con.height = th;
  const c = con.getContext("2d");
  c.filter = `blur(${Math.round(blurR)}px)`; c.drawImage(sil, 0, 0); c.filter = "none";
  const cd = c.getImageData(0, 0, tw, th); const d = cd.data;
  for (let i = 0; i < d.length; i += 4) { const op = d[i+3] > 20; d[i]=d[i+1]=d[i+2]=op?255:0; d[i+3]=op?255:0; }
  // Flood-fill interior holes
  const fm = new Uint8Array(tw * th), fs = [];
  for (let x=0;x<tw;x++){if(d[x*4+3]===0)fs.push(x);if(d[((th-1)*tw+x)*4+3]===0)fs.push((th-1)*tw+x);}
  for (let y=1;y<th-1;y++){if(d[(y*tw)*4+3]===0)fs.push(y*tw);if(d[(y*tw+tw-1)*4+3]===0)fs.push(y*tw+tw-1);}
  for (let i=0;i<fs.length;i++) fm[fs[i]]=1;
  while(fs.length){const idx=fs.pop();const x=idx%tw,y=(idx-x)/tw;
    if(x>0&&!fm[idx-1]&&d[(idx-1)*4+3]===0){fm[idx-1]=1;fs.push(idx-1);}
    if(x<tw-1&&!fm[idx+1]&&d[(idx+1)*4+3]===0){fm[idx+1]=1;fs.push(idx+1);}
    if(y>0&&!fm[idx-tw]&&d[(idx-tw)*4+3]===0){fm[idx-tw]=1;fs.push(idx-tw);}
    if(y<th-1&&!fm[idx+tw]&&d[(idx+tw)*4+3]===0){fm[idx+tw]=1;fs.push(idx+tw);}
  }
  for(let i=0;i<tw*th;i++){if(d[i*4+3]===0&&!fm[i]){d[i*4]=d[i*4+1]=d[i*4+2]=255;d[i*4+3]=255;}}
  c.putImageData(cd, 0, 0); c.drawImage(sil, 0, 0);
  // Step 4: circular stamp (FILLED outer expansion)
  const st = document.createElement("canvas"); st.width = tw; st.height = th;
  const sc = st.getContext("2d");
  const steps = Math.max(36, Math.ceil(Math.PI * 2 * offsetPx / 1.5));
  for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; sc.drawImage(con, Math.cos(a) * offsetPx, Math.sin(a) * offsetPx); }
  sc.drawImage(con, 0, 0);
  // Downscale 2x to NEST_PPI, apply rotation
  const nw = Math.ceil(tw / 2), nh = Math.ceil(th / 2);
  const isRot = rotation === 90 || rotation === 270;
  const outW = isRot ? nh : nw, outH = isRot ? nw : nh;
  const out = document.createElement("canvas"); out.width = outW; out.height = outH;
  const o = out.getContext("2d");
  if (rotation) { o.translate(outW/2, outH/2); o.rotate(rotation * Math.PI / 180); o.translate(-nw/2, -nh/2); }
  o.drawImage(st, 0, 0, tw, th, 0, 0, nw, nh);
  const fd = o.getImageData(0, 0, outW, outH).data;
  const mask = new Uint8Array(outW * outH);
  for (let i = 0; i < mask.length; i++) { if (fd[i*4+3] > 10) mask[i] = 1; }
  // contentOffset: image was drawn at (pad, pad) in render space. In grid space that's pad/2.
  const co = Math.round(pad / 2);
  return { mask, w: outW, h: outH, contentOffsetX: co, contentOffsetY: co };
}

// Geometric cuts (rect, rounded-rect, circle): render filled shape path at NEST_PPI
function buildShapeMask(img, wIn, hIn, cutShape, cutOffsetIn, cutRadius, rotation) {
  const cw = Math.ceil(wIn * NEST_PPI), ch = Math.ceil(hIn * NEST_PPI);
  const oPx = Math.ceil(cutOffsetIn * NEST_PPI);
  const mw = cw + oPx * 2, mh = ch + oPx * 2;
  const isRot = rotation === 90 || rotation === 270;
  const outW = isRot ? mh : mw, outH = isRot ? mw : mh;
  const cv = document.createElement("canvas"); cv.width = outW; cv.height = outH;
  const ctx = cv.getContext("2d");
  ctx.translate(outW / 2, outH / 2);
  if (rotation) ctx.rotate(rotation * Math.PI / 180);
  // Fill the cut shape area (content bounds assumed to fill the placement box)
  ctx.fillStyle = "#fff";
  const rPx = (cutRadius || 0) * NEST_PPI;
  if (cutShape === "rectangle") {
    ctx.fillRect(-mw/2, -mh/2, mw, mh);
  } else if (cutShape === "rounded-rect") {
    const r = Math.min(rPx, mw/2, mh/2);
    ctx.beginPath();
    ctx.moveTo(-mw/2+r, -mh/2); ctx.lineTo(mw/2-r, -mh/2); ctx.arcTo(mw/2, -mh/2, mw/2, -mh/2+r, r);
    ctx.lineTo(mw/2, mh/2-r); ctx.arcTo(mw/2, mh/2, mw/2-r, mh/2, r);
    ctx.lineTo(-mw/2+r, mh/2); ctx.arcTo(-mw/2, mh/2, -mw/2, mh/2-r, r);
    ctx.lineTo(-mw/2, -mh/2+r); ctx.arcTo(-mw/2, -mh/2, -mw/2+r, -mh/2, r);
    ctx.closePath(); ctx.fill();
  } else if (cutShape === "circle") {
    ctx.beginPath(); ctx.ellipse(0, 0, mw/2, mh/2, 0, 0, Math.PI * 2); ctx.fill();
  }
  const data = ctx.getImageData(0, 0, outW, outH).data;
  const mask = new Uint8Array(outW * outH);
  for (let i = 0; i < mask.length; i++) { if (data[i*4+3] > 10) mask[i] = 1; }
  return { mask, w: outW, h: outH, contentOffsetX: oPx, contentOffsetY: oPx };
}

// Dilate a mask by radius pixels (circle brush), EXPANDING the canvas by radius on each side
function dilateMask(src, sw, sh, radius) {
  if (radius <= 0) return { mask: new Uint8Array(src), w: sw, h: sh, pad: 0 };
  const r = Math.ceil(radius);
  const ow = sw + r * 2, oh = sh + r * 2; // expanded output
  const out = new Uint8Array(ow * oh);
  const offsets = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy <= r * r) offsets.push({ dx, dy });
  }
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (src[y * sw + x]) {
      for (const { dx, dy } of offsets) {
        const nx = x + r + dx, ny = y + r + dy; // offset by r to center in expanded canvas
        if (nx >= 0 && nx < ow && ny >= 0 && ny < oh) out[ny * ow + nx] = 1;
      }
    }
  }
  return { mask: out, w: ow, h: oh, pad: r };
}

// Sheet-level occupancy grid
function createSheetGrid(sW, sH) {
  const gw = Math.ceil(sW * NEST_PPI), gh = Math.ceil(sH * NEST_PPI);
  return { grid: new Uint8Array(gw * gh), w: gw, h: gh };
}

// Stamp a mask onto the sheet grid at a given position (in grid coords)
function stampMask(grid, gw, gh, mask, mw, mh, gx, gy) {
  for (let my = 0; my < mh; my++) {
    const sy = gy + my;
    if (sy < 0 || sy >= gh) continue;
    const gRow = sy * gw, mRow = my * mw;
    for (let mx = 0; mx < mw; mx++) {
      if (!mask[mRow + mx]) continue;
      const sx = gx + mx;
      if (sx >= 0 && sx < gw) grid[gRow + sx] = 1;
    }
  }
}

// Check if a mask overlaps the sheet grid at position (gx, gy)
function maskOverlaps(grid, gw, gh, mask, mw, mh, gx, gy) {
  for (let my = 0; my < mh; my++) {
    const sy = gy + my;
    if (sy < 0 || sy >= gh) return true; // out of bounds = overlap
    const gRow = sy * gw, mRow = my * mw;
    for (let mx = 0; mx < mw; mx++) {
      if (!mask[mRow + mx]) continue;
      const sx = gx + mx;
      if (sx < 0 || sx >= gw) return true; // out of bounds
      if (grid[gRow + sx]) return true;
    }
  }
  return false;
}

// ─── Web Worker for parallel nesting scan ───────────────────────────────────
// Runs the heavy maskOverlaps scan loop off the main thread.
// Each worker handles one rotation, all rotations run in parallel.
const nestWorkerCode = `
self.onmessage = function(e) {
  const { grid, gw, gh, mask, mw, mh, scanMaxY, step } = e.data;
  let bestX = -1, bestY = -1, bestScore = Infinity;
  const maxY = Math.min(scanMaxY, gh);

  // Find actual mask content bounds
  let maskBottom = mh, maskTop = 0, maskLeft = mw, maskRight = 0;
  let maskPixelCount = 0;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    if (mask[y * mw + x]) {
      maskPixelCount++;
      if (y < maskTop || maskPixelCount === 1) maskTop = y;
      if (y + 1 > maskBottom) maskBottom = y + 1;
      if (x < maskLeft) maskLeft = x;
      if (x + 1 > maskRight) maskRight = x + 1;
    }
  }

  // Precompute mask border pixels (for neighbor density scoring)
  // These are mask pixels that have at least one non-mask neighbor
  const borderPixels = [];
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(maskPixelCount) / 12));
  for (let y = maskTop; y < maskBottom; y += sampleStep) {
    for (let x = maskLeft; x < maskRight; x += sampleStep) {
      if (!mask[y * mw + x]) continue;
      let isBorder = false;
      if (y === 0 || !mask[(y-1)*mw+x]) isBorder = true;
      else if (y === mh-1 || !mask[(y+1)*mw+x]) isBorder = true;
      else if (x === 0 || !mask[y*mw+x-1]) isBorder = true;
      else if (x === mw-1 || !mask[y*mw+x+1]) isBorder = true;
      if (isBorder) borderPixels.push([x, y]);
    }
  }
  const maxBorderSamples = Math.min(borderPixels.length, 120);

  // Neighbor density: count how many grid cells adjacent to the mask border are occupied
  function neighborDensity(gx, gy) {
    let touching = 0, checked = 0;
    const bStep = Math.max(1, Math.floor(borderPixels.length / maxBorderSamples));
    for (let i = 0; i < borderPixels.length; i += bStep) {
      const bx = borderPixels[i][0], by = borderPixels[i][1];
      const sx = gx + bx, sy = gy + by;
      checked++;
      // Check 4-neighbors outside the mask
      for (let d = 0; d < 4; d++) {
        const nx = sx + (d===0?-1:d===1?1:0), ny = sy + (d===2?-1:d===3?1:0);
        if (nx >= 0 && nx < gw && ny >= 0 && ny < gh && grid[ny * gw + nx]) touching++;
      }
    }
    return checked > 0 ? touching / (checked * 4) : 0; // 0..1 ratio
  }

  let firstValidY = -1;
  let candidateCount = 0;

  for (let gy = 0; gy <= maxY; gy += step) {
    if (gy + maskTop >= gh && gy + maskTop >= maxY) break;
    // Scan further to find nestled positions
    if (bestX >= 0 && gy > bestY + mh * 3) break;

    for (let gx = 0; gx <= gw - (maskRight - maskLeft); gx += step) {
      let overlap = false;
      for (let my = maskTop; my < maskBottom && !overlap; my++) {
        const sy = gy + my;
        if (sy < 0 || sy >= gh) { overlap = true; break; }
        const gRow = sy * gw, mRow = my * mw;
        for (let mx = maskLeft; mx < maskRight; mx++) {
          if (!mask[mRow + mx]) continue;
          const sx = gx + mx;
          if (sx < 0 || sx >= gw || grid[gRow + sx]) { overlap = true; break; }
        }
      }
      if (!overlap) {
        if (firstValidY < 0) firstValidY = gy;
        const bottomEdge = gy + maskBottom;
        // Compute neighbor density — how well this position fills gaps
        const density = neighborDensity(gx, gy);
        // Score: lower is better
        // Primary: bottom edge (pack upward)
        // Bonus: subtract density * weight (filling gaps is rewarded)
        const densityBonus = density * mh;
        const score = (bottomEdge - densityBonus) * 10000 + gx;
        if (score < bestScore) { bestScore = score; bestX = gx; bestY = gy; }
        candidateCount++;
        if (candidateCount >= 500) break;
      }
    }
    if (firstValidY >= 0 && gy > firstValidY + mh * 4) break;
  }
  self.postMessage({ bestX, bestY, bestScore });
};`;
let nestWorkerBlob = null;
function getNestWorkerURL() {
  if (!nestWorkerBlob) nestWorkerBlob = URL.createObjectURL(new Blob([nestWorkerCode], { type: "application/javascript" }));
  return nestWorkerBlob;
}

// Worker pool — reuse workers instead of create+terminate per scan
const workerPool = [];
const POOL_SIZE = 4;
function getPoolWorker() {
  if (workerPool.length < POOL_SIZE) {
    const w = new Worker(getNestWorkerURL());
    w._busy = false;
    workerPool.push(w);
  }
  const idle = workerPool.find(w => !w._busy);
  if (idle) { idle._busy = true; return idle; }
  // All busy — create a temporary overflow worker
  const w = new Worker(getNestWorkerURL());
  w._busy = true; w._temp = true;
  return w;
}

function runScanWorker(grid, gw, gh, mask, mw, mh, scanMaxY, step) {
  return new Promise(resolve => {
    const w = getPoolWorker();
    const gridCopy = new Uint8Array(grid);
    const maskCopy = new Uint8Array(mask);
    w.onmessage = e => { w._busy = false; if (w._temp) w.terminate(); resolve(e.data); };
    w.onerror = () => { w._busy = false; if (w._temp) w.terminate(); resolve({ bestX: -1, bestY: -1, bestScore: Infinity }); };
    w.postMessage({ grid: gridCopy, gw, gh, mask: maskCopy, mw, mh, scanMaxY, step });
  });
}

// Mask cache — avoid rebuilding identical masks for same image/size/rotation
const _maskCache = new Map();

// Content-aware nesting with clean contentOffset coordinate math.
// Every mask tracks contentOffsetX/Y = grid pixels from mask edge to content origin.
// Stamping: maskGridPos = contentGridPos - contentOffset - dilatePad
// Reading:  contentInches = (maskGridPos + contentOffset) / NEST_PPI
async function nestItems(img, wIn, hIn, gap, cutOffset, cutDieCutExtra, cutShape, cutEnabled, sW, sH, count, margin, existingPlacements, autoRotate, onProgress, allowOverflow=false) {
  const halfGapPx = Math.ceil((gap / 2) * NEST_PPI);
  // If overflow allowed, extend grid height to fit all items (estimate: count * item height)
  const overflowH = allowOverflow ? sH + count * (Math.max(wIn, hIn) + gap) : sH;
  const gw = Math.ceil(sW * NEST_PPI), gh = Math.ceil(overflowH * NEST_PPI);
  const grid = new Uint8Array(gw * gh);

  // Mark margins as occupied (skip bottom margin if overflow allowed)
  const marginPx = Math.ceil(Math.max(margin, 0.05) * NEST_PPI);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const atLeft = x < marginPx, atRight = x >= gw - marginPx;
    const atTop = y < marginPx, atBottom = !allowOverflow && y >= gh - marginPx;
    if (atLeft || atRight || atTop || atBottom) grid[y * gw + x] = 1;
  }

  // Stamp existing placements onto grid
  for (const ep of existingPlacements) {
    const eImg = cachedImg(ep.src);
    if (!eImg.complete || !eImg.naturalWidth) {
      const expand = Math.ceil(((ep.cutEnabled ? (ep.cutOffset||0) : 0) + gap / 2) * NEST_PPI);
      const ex = Math.floor(ep.x * NEST_PPI) - expand, ey = Math.floor(ep.y * NEST_PPI) - expand;
      const ew = Math.ceil(ep.w * NEST_PPI) + expand * 2, eh = Math.ceil(ep.h * NEST_PPI) + expand * 2;
      for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) {
        const sx = ex + x, sy = ey + y;
        if (sx >= 0 && sx < gw && sy >= 0 && sy < gh) grid[sy * gw + sx] = 1;
      }
      continue;
    }
    // ep.w/ep.h are the footprint (swapped for 90/270 rotated items).
    // buildItemMask applies rotation internally, so pass original dimensions.
    const epRot = ep.rotation || 0;
    const epIsRot = epRot === 90 || epRot === 270;
    const epOrigW = epIsRot ? ep.h : ep.w, epOrigH = epIsRot ? ep.w : ep.h;
    const epMask = buildItemMask(eImg, epOrigW, epOrigH, ep.cutEnabled||false, ep.cutShape||"none", ep.cutOffset||0, ep.cutRadius||0, epRot);
    const dilated = dilateMask(epMask.mask, epMask.w, epMask.h, halfGapPx);
    const stampX = Math.floor(ep.x * NEST_PPI) - epMask.contentOffsetX - dilated.pad;
    const stampY = Math.floor(ep.y * NEST_PPI) - epMask.contentOffsetY - dilated.pad;
    stampMask(grid, gw, gh, dilated.mask, dilated.w, dilated.h, stampX, stampY);
  }

  // Prepare masks for new item (try rotations) — with caching
  const rotations = autoRotate ? [0, 90, 180, 270] : [0];
  const masks = rotations.map(rot => {
    const cacheKey = `${img.src.slice(-40)}_${wIn}_${hIn}_${rot}_${halfGapPx}_${cutEnabled}_${cutShape}_${cutOffset}`;
    const cached = _maskCache.get(cacheKey);
    if (cached) return { rot, ...cached };
    const raw = buildItemMask(img, wIn, hIn, cutEnabled, cutShape, cutOffset, 0, rot);
    const dilated = dilateMask(raw.mask, raw.w, raw.h, halfGapPx);
    const entry = {
      mask: dilated.mask, w: dilated.w, h: dilated.h,
      contentOffsetX: raw.contentOffsetX + dilated.pad,
      contentOffsetY: raw.contentOffsetY + dilated.pad,
    };
    if (_maskCache.size >= 50) _maskCache.clear();
    _maskCache.set(cacheKey, entry);
    return { rot, ...entry };
  });

  // ─── Row-scan placement with smart bounds + async yields ───
  const step = 1; // 1 grid pixel at 15 PPI ≈ 0.067" — tight packing with good speed
  const results = [];
  let lastYield = performance.now();
  // Track scan bounds — only scan where items could fit, not the full sheet
  let scanMaxY = marginPx + Math.ceil((hIn + gap) * NEST_PPI);
  if (existingPlacements.length) {
    const epLowest = Math.max(...existingPlacements.map(p => (p.y + p.h) * NEST_PPI));
    scanMaxY = Math.min(gh, Math.ceil(epLowest + (hIn * 2 + gap * 2) * NEST_PPI));
  }

  for (let i = 0; i < count; i++) {
    if (onProgress) onProgress(i, count);

    let bestPos = null, bestScore = Infinity, bestRot = 0, bestMask = null;

    // Launch all rotations in parallel via Web Workers
    const workerPromises = masks.map(m =>
      runScanWorker(grid, gw, gh, m.mask, m.w, m.h, scanMaxY, step)
        .then(result => ({ ...result, m }))
    );
    const workerResults = await Promise.all(workerPromises);

    for (const { bestX, bestY, bestScore: ws, m } of workerResults) {
      if (bestX >= 0 && ws < bestScore) {
        bestScore = ws; bestPos = { x: bestX, y: bestY }; bestRot = m.rot; bestMask = m;
      }
    }

    if (!bestPos) break;

    // Stamp placed item and expand scan range
    stampMask(grid, gw, gh, bestMask.mask, bestMask.w, bestMask.h, bestPos.x, bestPos.y);
    scanMaxY = Math.min(gh, Math.max(scanMaxY, bestPos.y + bestMask.h + Math.ceil((hIn + gap) * NEST_PPI)));

    const isRot = bestRot === 90 || bestRot === 270;
    const fpW = isRot ? hIn : wIn, fpH = isRot ? wIn : hIn;
    results.push({
      x: (bestPos.x + bestMask.contentOffsetX) / NEST_PPI,
      y: (bestPos.y + bestMask.contentOffsetY) / NEST_PPI,
      w: fpW,
      h: fpH,
      rotation: bestRot,
    });
  }

  return results;
}

// ─── Image helpers ────────────────────────────────────────────────────────────
const imgCache = {};
function cachedImg(src) { if(!imgCache[src]){const i=new Image();i.src=src;imgCache[src]=i;} return imgCache[src]; }
async function toDataURL(src) {
  if (src.startsWith("data:")) return src;
  return new Promise(res=>{
    const i=new Image(); i.crossOrigin="anonymous";
    i.onload=()=>{const c=document.createElement("canvas");c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext("2d").drawImage(i,0,0);res(c.toDataURL("image/png"));};
    i.onerror=()=>res(src); i.src=src;
  });
}
function nativeRes(nW,nH,pW,pH,dpi) {
  const e=Math.min(nW/pW,nH/pH);
  return {effDpi:e, warn:e<dpi*0.75, caution:e<dpi&&e>=dpi*0.75};
}

// ─── Cut contour generation ──────────────────────────────────────────────────
const contourCache = new Map();

// Get the bounding box of visible (non-transparent) content in an image, in placement-local coords
function getContentBounds(img, w, h) {
  if (!img.complete || !img.naturalWidth) return { cx: 0, cy: 0, cw: w, ch: h };
  const maxDim = 256;
  const sc = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const sw = Math.max(4, Math.round(img.naturalWidth * sc));
  const sh = Math.max(4, Math.round(img.naturalHeight * sc));
  const cv = document.createElement("canvas"); cv.width = sw; cv.height = sh;
  const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0, sw, sh);
  const d = ctx.getImageData(0, 0, sw, sh).data;
  let top = sh, left = sw, bottom = 0, right = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (d[(y * sw + x) * 4 + 3] > 10) {
      if (y < top) top = y; if (y > bottom) bottom = y;
      if (x < left) left = x; if (x > right) right = x;
    }
  }
  if (bottom < top) return { cx: 0, cy: 0, cw: w, ch: h };
  return {
    cx: ((left + right) / 2 / sw - 0.5) * w,
    cy: ((top + bottom) / 2 / sh - 0.5) * h,
    cw: ((right - left + 1) / sw) * w,
    ch: ((bottom - top + 1) / sh) * h,
  };
}

function buildShapePath(shape, img, w, h, offsetPx, radiusPx) {
  const bounds = getContentBounds(img, w, h);
  const o = offsetPx;
  const path = new Path2D();
  if (shape === "rectangle") {
    path.rect(bounds.cx - bounds.cw/2 - o, bounds.cy - bounds.ch/2 - o, bounds.cw + o*2, bounds.ch + o*2);
  } else if (shape === "rounded-rect") {
    const bw = bounds.cw + o*2, bh = bounds.ch + o*2;
    const r = Math.max(0, Math.min(radiusPx, bw/2, bh/2));
    const x = bounds.cx - bounds.cw/2 - o, y = bounds.cy - bounds.ch/2 - o;
    path.moveTo(x + r, y);
    path.lineTo(x + bw - r, y); path.arcTo(x + bw, y, x + bw, y + r, r);
    path.lineTo(x + bw, y + bh - r); path.arcTo(x + bw, y + bh, x + bw - r, y + bh, r);
    path.lineTo(x + r, y + bh); path.arcTo(x, y + bh, x, y + bh - r, r);
    path.lineTo(x, y + r); path.arcTo(x, y, x + r, y, r);
    path.closePath();
  } else if (shape === "circle") {
    const rx = bounds.cw/2 + o, ry = bounds.ch/2 + o;
    path.ellipse(bounds.cx, bounds.cy, rx, ry, 0, 0, Math.PI * 2);
  }
  return path;
}

// Die-cut: Gaussian blur merges disconnected elements (fixed radius, independent
// of offset). Circular stamp expands the merged base shape by the offset amount.
// Two-pass stamp (outer/inner) produces a thin cut line at uniform distance.
function buildDieCutCanvas(img, w, h, offsetPx, color, lineWidth) {
  if (!img.complete || !img.naturalWidth) return null;
  const offset = Math.max(1, offsetPx);
  const lw = Math.max(1, lineWidth || 2);
  const iw = Math.ceil(w), ih = Math.ceil(h);

  // Fixed blur radius: only for merging elements, NOT tied to offset.
  // ~6% of image size: tight contours while still bridging nearby elements.
  // Flood-fill (below) handles any interior holes left by the blur.
  const blurR = Math.max(5, Math.max(iw, ih) * 0.06);
  // Padding: blur spread + full offset expansion
  const pad = Math.ceil(offset + blurR * 2.5 + lw + 4);
  const tw = Math.ceil(w + pad * 2), th = Math.ceil(h + pad * 2);

  // Step 1: White silhouette of the image on padded canvas
  const sil = document.createElement("canvas");
  sil.width = tw; sil.height = th;
  const sCtx = sil.getContext("2d");
  sCtx.drawImage(img, pad, pad, iw, ih);
  sCtx.globalCompositeOperation = "source-in";
  sCtx.fillStyle = "#fff";
  sCtx.fillRect(0, 0, tw, th);
  sCtx.globalCompositeOperation = "source-over";

  // Step 2: Gaussian blur to merge disconnected elements into one blob
  const connected = document.createElement("canvas");
  connected.width = tw; connected.height = th;
  const cCtx = connected.getContext("2d");
  cCtx.filter = `blur(${Math.round(blurR)}px)`;
  cCtx.drawImage(sil, 0, 0);
  cCtx.filter = "none";
  const cData = cCtx.getImageData(0, 0, tw, th);
  const d = cData.data;
  for (let i = 0; i < d.length; i += 4) {
    const opaque = d[i + 3] > 20;
    d[i] = d[i + 1] = d[i + 2] = opaque ? 255 : 0;
    d[i + 3] = opaque ? 255 : 0;
  }

  // Step 2b: Fill interior holes via flood-fill from edges.
  // Any transparent pixel reachable from the border is exterior.
  // Remaining transparent pixels are interior holes — fill them.
  const mask = new Uint8Array(tw * th); // 0=unvisited, 1=exterior
  const stack = [];
  // Seed all transparent border pixels
  for (let x = 0; x < tw; x++) {
    if (d[(0 * tw + x) * 4 + 3] === 0) stack.push(x);              // top row
    if (d[((th - 1) * tw + x) * 4 + 3] === 0) stack.push((th - 1) * tw + x); // bottom row
  }
  for (let y = 1; y < th - 1; y++) {
    if (d[(y * tw) * 4 + 3] === 0) stack.push(y * tw);              // left col
    if (d[(y * tw + tw - 1) * 4 + 3] === 0) stack.push(y * tw + tw - 1); // right col
  }
  for (let i = 0; i < stack.length; i++) mask[stack[i]] = 1;
  // BFS flood-fill
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % tw, y = (idx - x) / tw;
    const neighbors = [];
    if (x > 0) neighbors.push(idx - 1);
    if (x < tw - 1) neighbors.push(idx + 1);
    if (y > 0) neighbors.push(idx - tw);
    if (y < th - 1) neighbors.push(idx + tw);
    for (const n of neighbors) {
      if (!mask[n] && d[n * 4 + 3] === 0) { mask[n] = 1; stack.push(n); }
    }
  }
  // Fill interior holes (transparent pixels NOT marked as exterior)
  for (let i = 0; i < tw * th; i++) {
    if (d[i * 4 + 3] === 0 && !mask[i]) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
      d[i * 4 + 3] = 255;
    }
  }
  cCtx.putImageData(cData, 0, 0);

  // Step 3: Union with original silhouette for tight contour detail
  cCtx.drawImage(sil, 0, 0);
  // connected canvas is now the unified solid shape (no interior holes)

  // Step 4: Circular stamp for offset expansion — outer ring edge
  const result = document.createElement("canvas");
  result.width = tw; result.height = th;
  const rCtx = result.getContext("2d");
  const oSteps = Math.max(36, Math.ceil(Math.PI * 2 * offset / 1.5));
  for (let i = 0; i < oSteps; i++) {
    const a = (i / oSteps) * Math.PI * 2;
    rCtx.drawImage(connected, Math.cos(a) * offset, Math.sin(a) * offset);
  }
  rCtx.drawImage(connected, 0, 0);

  // Step 5: Color the outer expansion
  rCtx.globalCompositeOperation = "source-in";
  rCtx.fillStyle = color || "#FF0000";
  rCtx.fillRect(0, 0, tw, th);
  rCtx.globalCompositeOperation = "source-over";

  // Step 6: Subtract inner expansion to produce thin outline of width lw.
  // Inner = stamp at (offset - lw) distance.
  const innerR = Math.max(0, offset - lw);
  const inner = document.createElement("canvas");
  inner.width = tw; inner.height = th;
  const iCtx = inner.getContext("2d");
  if (innerR > 0.5) {
    const iSteps = Math.max(36, Math.ceil(Math.PI * 2 * innerR / 1.5));
    for (let i = 0; i < iSteps; i++) {
      const a = (i / iSteps) * Math.PI * 2;
      iCtx.drawImage(connected, Math.cos(a) * innerR, Math.sin(a) * innerR);
    }
  }
  iCtx.drawImage(connected, 0, 0);

  rCtx.globalCompositeOperation = "destination-out";
  rCtx.drawImage(inner, 0, 0);
  rCtx.globalCompositeOperation = "source-over";

  return { canvas: result, pad, cw: iw, ch: ih, tw, th };
}

const dieCutCache = new Map();

function getCutContour(src, shape, w, h, offsetPx, radiusPx) {
  const key = `${src.substring(0, 50)}_${shape}_${w.toFixed(1)}_${h.toFixed(1)}_${offsetPx.toFixed(1)}_${radiusPx.toFixed(1)}`;
  if (contourCache.has(key)) return contourCache.get(key);
  const img = cachedImg(src);
  const path = buildShapePath(shape, img, w, h, offsetPx, radiusPx);
  contourCache.set(key, path);
  if (contourCache.size > 200) { const first = contourCache.keys().next().value; contourCache.delete(first); }
  return path;
}

// ─── Storage ──────────────────────────────────────────────────────────────────
async function sGet(k){try{const r=await window.storage.get(k);return r?JSON.parse(r.value):null;}catch{return null;}}
async function sSet(k,v){try{await window.storage.set(k,JSON.stringify(v));return true;}catch{return false;}}

// ─── Colors ───────────────────────────────────────────────────────────────────
const HUES=[220,155,30,290,0,185,55,325,100,240];
let hueIdx=0;
const nextColor=()=>`hsl(${HUES[hueIdx++%HUES.length]},68%,58%)`;
const THEMES={
  dark:{bg:"#0c0b12",surface:"#13121c",surface2:"#181727",border:"#1f1e30",muted:"#3d3b60",text:"#e2e0ff",accent:"#a5b4fc",accentSolid:"#6366f1",hover:"#141328",selected:"#19182a",textSoft:"#c4c0f0",greenBright:"#4ade80",amber:"#f59e0b",green:"#22c55e",red:"#ef4444",canvasBg:"#08070f",warnBg:"#1e1400",warnBorder:"#5c3a00",okBg:"#0a1a0f",okBorder:"#1a5c2a"},
  light:{bg:"#f0f0f5",surface:"#ffffff",surface2:"#eaeaf0",border:"#d0d0dd",muted:"#8888a0",text:"#1a1a2e",accent:"#4f46e5",accentSolid:"#4f46e5",hover:"#e8e8f0",selected:"#e0e0f5",textSoft:"#4a4a6e",greenBright:"#16a34a",amber:"#d97706",green:"#16a34a",red:"#dc2626",canvasBg:"#d0d0dd",warnBg:"#fef3c7",warnBorder:"#d97706",okBg:"#dcfce7",okBorder:"#16a34a"},
  midnight:{bg:"#0a1628",surface:"#0f1f3a",surface2:"#132744",border:"#1a3355",muted:"#4a6a8f",text:"#d0e0ff",accent:"#60a5fa",accentSolid:"#3b82f6",hover:"#0d1a34",selected:"#122240",textSoft:"#8ab4e0",greenBright:"#4ade80",amber:"#f59e0b",green:"#22c55e",red:"#ef4444",canvasBg:"#060e1a",warnBg:"#1e1400",warnBorder:"#5c3a00",okBg:"#0a1a0f",okBorder:"#1a5c2a"},
};
let C=THEMES.dark;

// ─── Breakpoint hook ──────────────────────────────────────────────────────────
function useBreakpoint() {
  const [bp, setBp] = useState(() => {
    const w = typeof window !== "undefined" ? window.innerWidth : 1200;
    return w < 640 ? "mobile" : w < 1024 ? "tablet" : "desktop";
  });
  useEffect(() => {
    const handler = () => {
      const w = window.innerWidth;
      setBp(w < 640 ? "mobile" : w < 1024 ? "tablet" : "desktop");
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return bp;
}

// ─── Stepper input (mobile-friendly) ─────────────────────────────────────────
function Stepper({ value, onChange, min=0, step=0.1, style={} }) {
  const v = parseFloat(value) || 0;
  return (
    <div style={{display:"flex",alignItems:"center",gap:0,...style}}>
      <button onClick={()=>onChange(Math.max(min, parseFloat((v-step).toFixed(4))))} style={{width:36,height:36,background:C.surface2,border:`1px solid ${C.border}`,borderRight:"none",borderRadius:"4px 0 0 4px",color:C.text,fontSize:16,cursor:"pointer",flexShrink:0}}>−</button>
      <input type="number" value={value} onChange={e=>onChange(e.target.value)} min={min} step={step}
        style={{flex:1,background:C.bg,border:`1px solid ${C.border}`,color:C.text,padding:"7px 6px",fontSize:13,textAlign:"center",outline:"none",height:36,minWidth:0}} />
      <button onClick={()=>onChange(parseFloat((v+step).toFixed(4)))} style={{width:36,height:36,background:C.surface2,border:`1px solid ${C.border}`,borderLeft:"none",borderRadius:"0 4px 4px 0",color:C.text,fontSize:16,cursor:"pointer",flexShrink:0}}>+</button>
    </div>
  );
}

// ─── Bottom drawer ────────────────────────────────────────────────────────────
function Drawer({ open, onClose, title, children, height="85vh" }) {
  return (
    <div style={{position:"fixed",inset:0,zIndex:800,pointerEvents:open?"all":"none"}}>
      <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.6)",opacity:open?1:0,transition:"opacity 0.25s",cursor:"pointer"}} onClick={onClose}/>
      <div style={{position:"absolute",bottom:0,left:0,right:0,background:C.surface,borderRadius:"16px 16px 0 0",maxHeight:height,display:"flex",flexDirection:"column",transform:open?"translateY(0)":"translateY(100%)",transition:"transform 0.3s cubic-bezier(0.32,0.72,0,1)",boxShadow:"0 -8px 40px rgba(0,0,0,0.5)"}}>
        {/* Drag handle */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px 0"}}>
          <div style={{width:36,height:4,borderRadius:2,background:C.border,margin:"0 auto 8px"}} />
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px 10px",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
          <span style={{fontSize:12,fontWeight:700,color:C.accent,letterSpacing:"0.1em",textTransform:"uppercase"}}>{title}</span>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:C.muted,fontSize:20,cursor:"pointer",padding:"0 4px",lineHeight:1}}>×</button>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"12px 16px 24px"}}>{children}</div>
      </div>
    </div>
  );
}

// ─── Context menu (long-press on canvas item) ─────────────────────────────────
function ContextMenu({ x, y, onClose, onDelete, onDuplicate, onRotate, onFlipH, onFlipV, onTrim, onCut, onCopy, onPaste, canvasOnly }) {
  if (x === null) return null;
  const items = canvasOnly ? [
    {label:"📌 Paste", fn:()=>{onPaste();onClose();}},
  ] : [
    {label:"✂ Cut", fn:()=>{onCut();onClose();}},
    {label:"📋 Copy", fn:()=>{onCopy();onClose();}},
    {label:"📌 Paste", fn:()=>{onPaste();onClose();}},
    {label:"↻ Rotate 90°", fn:()=>{onRotate(90);onClose();}},
    {label:"↺ Rotate −90°", fn:()=>{onRotate(-90);onClose();}},
    {label:"↔ Flip H", fn:()=>{onFlipH();onClose();}},
    {label:"↕ Flip V", fn:()=>{onFlipV();onClose();}},
    {label:"✂ Trim Transparent", fn:()=>{onTrim();onClose();}},
    {label:"⊕ Duplicate", fn:()=>{onDuplicate();onClose();}},
    {label:"✕ Delete", fn:()=>{onDelete();onClose();}, danger:true},
  ];
  return (
    <div style={{position:"fixed",inset:0,zIndex:700}} onClick={onClose}>
      <div style={{position:"absolute",left:Math.min(x,window.innerWidth-160),top:Math.min(y,window.innerHeight-260),background:C.surface2,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden",boxShadow:"0 8px 32px rgba(0,0,0,0.5)",width:155}} onClick={e=>e.stopPropagation()}>
        {items.map(({label,fn,danger})=>(
          <div key={label} onClick={fn} style={{padding:"11px 14px",fontSize:12,color:danger?C.red:C.text,cursor:"pointer",borderBottom:`1px solid ${C.border}`}}>{label}</div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Main App ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
export default function GangSheetBuilder() {
  const bp = useBreakpoint();
  const isMobile  = bp === "mobile";
  const isTablet  = bp === "tablet";
  const isDesktop = bp === "desktop";

  // Update check is handled by the inline useEffect below (with status display)

  // ── Persisted UI state ──
  // All settings/preferences that should survive a page refresh go here.
  // Any future state additions here are automatically persisted.
  const UI_KEY = "gangsheet-ui-state";
  const SHEET_DEFAULTS = {showGrid:true,gridSize:0.5,gridStyle:"lines",snapToGrid:false,snapSize:0.25,canvasBg:"checker",zoom:1,scrollX:0,scrollY:0,mirrorExport:false,autoRotateFill:false,autoRotatePlace:false,autoDistribute:false,snapToItems:false,autoTrimImport:true,cutEnabled:false,cutShape:"rounded-rect",cutOffset:0.05,cutWidth:1,cutColor:"#FF0000",cutRadius:0.1};
  const loadUIState = () => {
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  };
  const savedUI = useRef(loadUIState());

  const [sheets, setSheets]         = useState(()=>{
    const s = savedUI.current;
    if(s?.sheets?.length>0){
      s.sheets.forEach(sh=>[...new Set(sh.placements.map(p=>p.src))].forEach(src=>cachedImg(src)));
      const ids=s.sheets.flatMap(sh=>[...sh.placements.map(p=>p.id),...sh.groups.map(g=>g.id),sh.id]);
      if(ids.length)_id=Math.max(...ids)+1;
      return s.sheets.map(sh=>({...SHEET_DEFAULTS,...sh}));
    }
    return [makeSheet({label:"Sheet 1"})];
  });
  const [activeId, setActiveId]     = useState(()=>savedUI.current?.activeId||sheets[0]?.id);
  // Safety: ensure at least one sheet always exists
  useEffect(()=>{if(!sheets.length){const ns=makeSheet({label:"Sheet 1"});setSheets([ns]);setActiveId(ns.id);}},[sheets]);
  const [editingTabId, setEditingTabId]     = useState(null);
  const [editingTabLabel, setEditingTabLabel] = useState("");

  // ── UI state ──
  const [selected, setSelected]         = useState(null);
  const [multiSelected, setMultiSelected] = useState([]); // Ctrl+click multi-select
  const [hoveredGroup, setHoveredGroup] = useState(null);
  const [dragging, setDragging]         = useState(null);
  const [resizeTooltip, setResizeTooltip] = useState(null); // {x,y,w,h} for resize tooltip
  const [layerCtx, setLayerCtx] = useState(null); // {x,y,type:"group"|"placement",id,groupId}
  const [tabCtx, setTabCtx] = useState(null); // {x,y,sheetId}
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [editingPlacementId, setEditingPlacementId] = useState(null);
  const [editingPlacementName, setEditingPlacementName] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const [hoveredPlacement, setHoveredPlacement] = useState(null);
  const [showLayers, setShowLayers] = useState(()=>savedUI.current?.showLayers!==false);
  const [confirmClose, setConfirmClose] = useState(null); // {sheetId, label}
  const [confirmDelete, setConfirmDelete] = useState(null); // {ids:[], label, isGroup}
  const [dragLayer, setDragLayer] = useState(null); // {id, groupId, fromIdx}
  const [dragOverId, setDragOverId] = useState(null);

  // ── Undo/Redo ──
  const isDraggingCanvas = useRef(false);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const undoSkip = useRef(false);
  const MAX_UNDO = 50;
  const [leftTab, setLeftTab]           = useState(()=>savedUI.current?.leftTab||"sheet");

  // Mobile drawers
  const [drawer, setDrawer] = useState(null); // "sheet"|"add"|"layers"|"sheets"

  // Settings (persisted)
  const [uiScale, setUiScale] = useState(()=>savedUI.current?.uiScale||1);
  const [theme, setTheme] = useState(()=>savedUI.current?.theme||"dark");
  const [showSettings, setShowSettings] = useState(false);
  C=THEMES[theme]||THEMES.dark;
  const sc=v=>Math.round(v*uiScale); // scale font sizes

  // Modals (transient — not persisted)
  const [showSave, setShowSave]           = useState(false);
  const [showPresets, setShowPresets]     = useState(false);
  const [showCSV, setShowCSV]             = useState(false);
  const [showFillConfirm, setShowFillConfirm] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showExportAd, setShowExportAd] = useState(false);
  const pendingExportRef = useRef(null);
  const [exportAllPending, setExportAllPending] = useState(false);
  const [exporting, setExporting]         = useState(false);
  const [exportProgress, setExportProgress] = useState("");
  const [exportAllMode, setExportAllMode] = useState(false);

  // Context menu (mobile long-press)
  const [ctxMenu, setCtxMenu] = useState({x:null,y:null});
  const longPressTimer = useRef(null);

  // Save/load
  const [saves, setSaves]       = useState({});
  const [saveName, setSaveName] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [saveLoading, setSaveLoading] = useState(true);

  // Auto-update check (desktop/Tauri only)
  const [updateStatus, setUpdateStatus] = useState(null);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    (async () => {
      try {
        setUpdateStatus("Checking for updates...");
        const { check } = await import("@tauri-apps/plugin-updater");
        const { relaunch } = await import("@tauri-apps/plugin-process");
        const update = await check();
        // Tauri v2: check() returns Update object if available, null if up to date
        if (update) {
          const ver = update.version || "new version";
          setUpdateStatus(null);
          const yes = window.confirm("GangOwl v" + ver + " is available. Update now?");
          if (yes) {
            setUpdateStatus("Downloading v" + ver + "...");
            let downloaded = 0, total = 0;
            await update.downloadAndInstall((evt) => {
              if (evt.event === "Started") total = evt.data?.contentLength || 0;
              if (evt.event === "Progress") { downloaded += evt.data?.chunkLength || 0; const pct = total ? Math.round(downloaded/total*100) : 0; setUpdateStatus("Downloading... " + pct + "%"); }
              if (evt.event === "Finished") setUpdateStatus("Installing...");
            });
            await relaunch();
          } else {
            setUpdateStatus("Update skipped");
            setTimeout(() => setUpdateStatus(null), 5000);
          }
        } else {
          setUpdateStatus("Up to date ✓");
          setTimeout(() => setUpdateStatus(null), 8000);
        }
      } catch (e) {
        console.error("Update check error:", e);
        // Capture every possible error shape
        let msg;
        try { msg = typeof e === "string" ? e : e?.message || e?.description || JSON.stringify(e); } catch { msg = String(e); }
        setUpdateStatus("Update: " + msg);
      }
    })();
  }, []);

  // Loading state — shown while images from saved project are loading
  const [appLoading, setAppLoading] = useState(()=>{
    const s = savedUI.current;
    return s?.sheets?.some(sh => sh.placements?.length > 0) || false;
  });
  useEffect(()=>{
    if (!appLoading) return;
    // Wait for all cached images to load, then hide loading screen
    const srcs = [...new Set(sheets.flatMap(s => s.placements.map(p => p.src)))];
    if (!srcs.length) { setAppLoading(false); return; }
    let loaded = 0;
    const check = () => { loaded++; if (loaded >= srcs.length) setAppLoading(false); };
    const timeout = setTimeout(() => setAppLoading(false), 5000); // max 5s wait
    srcs.forEach(src => {
      const img = cachedImg(src);
      if (img.complete) check();
      else { img.onload = check; img.onerror = check; }
    });
    return () => clearTimeout(timeout);
  }, []); // eslint-disable-line

  // Presets
  const [presets, setPresets]     = useState([]);
  const [presetName, setPresetName] = useState("");

  // Canvas zoom & pan
  const [zoom, setZoom]   = useState(()=>{
    const s=savedUI.current;
    if(s?.sheets?.length>0){const a=s.sheets.find(sh=>sh.id===s.activeId)||s.sheets[0];return a?.zoom||1;}
    return 1;
  });
  const [panX, setPanX]   = useState(0);
  const [panY, setPanY]   = useState(0);
  const pinchRef          = useRef(null);
  const panRef            = useRef(null);
  const spaceHeld         = useRef(false);
  const desktopPanRef     = useRef(null);

  // Tool switcher
  const [activeTool, setActiveTool] = useState(()=>savedUI.current?.activeTool||"select");

  // Rulers
  const [showRulers, setShowRulers] = useState(()=>savedUI.current?.showRulers??(typeof window!=="undefined"&&window.innerWidth>=1024));
  const hRulerRef = useRef(null);
  const vRulerRef = useRef(null);
  const RULER_SIZE = 24;

  // Smart guides
  const guidesRef = useRef([]);

  // Export options
  const [exportFormat, setExportFormat] = useState(()=>savedUI.current?.exportFormat||"png");
  const [exportQuality, setExportQuality] = useState(()=>savedUI.current?.exportQuality||0.92);
  const [exportPct, setExportPct] = useState(0);

  // Resize handles
  const [resizing, setResizing] = useState(null);
  // Rotation handle
  const [rotating, setRotating] = useState(null);
  // Hover cursor for handles
  const [hoverCursor, setHoverCursor] = useState(null);
  // Mouse position for ruler crosshair
  const mousePos = useRef({x:0,y:0});
  // Export cancel
  const exportCancelRef = useRef(false);
  // Auto-save
  const autoSaveTimer = useRef(null);

  const canvasRef     = useRef(null);
  const canvasWrapRef = useRef(null);
  const fileInputRef  = useRef(null);
  const autoTrimRef   = useRef(false);
  const clipboardRef  = useRef(null); // {placements: [...], groups: [...]} for copy/paste across sheets
  const tabInputRef   = useRef(null);
  const imgTimer      = useRef(null);
  const frozenOverflow= useRef(null);

  // ── Undo/Redo tracking ──
  // Snapshot sheets on every meaningful change (skip during undo/redo)
  const prevSheetsRef = useRef(null);
  useEffect(()=>{
    if(undoSkip.current){undoSkip.current=false;return;}
    if(isDraggingCanvas.current) return; // skip snapshots during drag — capture on mouseup
    // Deep-compare: only push if placements/groups actually changed
    const snap=JSON.stringify(sheets.map(s=>({id:s.id,placements:s.placements.map(p=>({id:p.id,x:p.x,y:p.y,w:p.w,h:p.h,rotation:p.rotation,flipH:p.flipH,flipV:p.flipV,groupId:p.groupId,name:p.name})),groups:s.groups.map(g=>({id:g.id,name:g.name}))})));
    if(snap===prevSheetsRef.current) return;
    if(prevSheetsRef.current!==null){
      undoStack.current.push({sheets:JSON.parse(JSON.stringify(sheets)),activeId});
      if(undoStack.current.length>MAX_UNDO) undoStack.current.shift();
      redoStack.current=[];
    }
    prevSheetsRef.current=snap;
  },[sheets,activeId]);

  const undo=()=>{
    if(!undoStack.current.length) return;
    const cur={sheets:JSON.parse(JSON.stringify(sheets)),activeId};
    redoStack.current.push(cur);
    const prev=undoStack.current.pop();
    undoSkip.current=true;
    // Restore image caches
    prev.sheets.forEach(s=>s.placements.forEach(p=>cachedImg(p.src)));
    setSheets(prev.sheets);
    setActiveId(prev.activeId);
    setSelected(null);setMultiSelected([]);
  };
  const redo=()=>{
    if(!redoStack.current.length) return;
    const cur={sheets:JSON.parse(JSON.stringify(sheets)),activeId};
    undoStack.current.push(cur);
    const next=redoStack.current.pop();
    undoSkip.current=true;
    next.sheets.forEach(s=>s.placements.forEach(p=>cachedImg(p.src)));
    setSheets(next.sheets);
    setActiveId(next.activeId);
    setSelected(null);setMultiSelected([]);
  };

  // ── Init (named saves & presets from async storage) ──
  useEffect(()=>{
    sGet(STORAGE_KEY).then(s=>{if(s)setSaves(s);setSaveLoading(false);});
    sGet(PRESETS_KEY).then(p=>{if(p)setPresets(p);});
    // Restore scroll position from saved state
    const s=savedUI.current;
    if(s?.sheets?.length>0){
      const a=s.sheets.find(sh=>sh.id===s.activeId)||s.sheets[0];
      if(a) requestAnimationFrame(()=>{const wrap=canvasWrapRef.current;if(wrap){wrap.scrollLeft=a.scrollX||0;wrap.scrollTop=a.scrollY||0;}});
    }
  },[]);

  // Sync zoom into active sheet so it persists per-tab
  useEffect(()=>{
    setSheets(prev=>prev.map(s=>s.id===activeId?{...s,zoom}:s));
  },[zoom,activeId]);

  // ── Auto-persist all UI state (debounced 1s) ──
  useEffect(()=>{
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current=setTimeout(async()=>{
      // Serialize image sources to data URLs for persistence
      const allSrcs=[...new Set(sheets.flatMap(s=>s.placements.map(p=>p.src)))];
      const sm={};for(const src of allSrcs){if(src.startsWith("data:"))sm[src]=src;else sm[src]=await toDataURL(src);}
      const wrap=canvasWrapRef.current;
      const ser=sheets.map(s=>{
        const base={...s,placements:s.placements.map(p=>({...p,src:sm[p.src]||p.src})),groups:s.groups.map(g=>({...g,src:sm[g.src]||g.src})),uploadedImg:s.uploadedImg?{...s.uploadedImg,src:sm[s.uploadedImg.src]||s.uploadedImg.src}:null};
        // Capture current scroll for the active sheet
        if(s.id===activeId&&wrap) return{...base,scrollX:wrap.scrollLeft,scrollY:wrap.scrollTop,zoom};
        return base;
      });
      const state={
        sheets:ser, activeId, leftTab, activeTool, showRulers, showLayers, exportFormat, exportQuality, uiScale, theme,
      };
      try{localStorage.setItem(UI_KEY,JSON.stringify(state));}catch{}
    },1000);
    return()=>clearTimeout(autoSaveTimer.current);
  },[sheets,activeId,leftTab,zoom,activeTool,showRulers,showLayers,exportFormat,exportQuality,uiScale,theme]);

  // ── Active sheet ──
  const active = sheets.find(s=>s.id===activeId) || sheets[0] || makeSheet();
  const updActive = useCallback((patch)=>{
    setSheets(prev=>prev.map(s=>s.id===activeId?{...s,...(typeof patch==="function"?patch(s):patch)}:s));
  },[activeId]);

  const sheetDefaults = {showGrid:true,gridSize:0.5,gridStyle:"lines",snapToGrid:false,snapSize:0.25,canvasBg:"checker",placements:[],groups:[],extraSizes:[]};
  const merged = {...sheetDefaults,...active};
  autoTrimRef.current = merged.autoTrimImport || false;
  const {sheetW,sheetH,sheetDPI,margin,showMargin,showGrid,gridSize,gridStyle,snapToGrid,snapSize,canvasBg,mirrorExport,autoRotateFill,autoRotatePlace,autoDistribute,snapToItems,autoTrimImport,cutEnabled,cutShape,cutOffset,cutWidth,cutColor,cutRadius,inkCostPerSqIn,
         placements,groups,uploadedImg,placeW,placeH,lockSide,copies,gap,
         rotation,flipH,flipV,jobNotes,warning,extraSizes} = merged;

  // ── Derived ──
  const usableSqIn = (sheetW-margin*2)*(sheetH-margin*2);
  const placedSqIn = sqIn(placements);
  const utilPct    = usableSqIn>0 ? Math.min(100,(placedSqIn/usableSqIn)*100) : 0;
  const estCost    = inkCostPerSqIn>0 ? (placedSqIn*inkCostPerSqIn).toFixed(2) : null;
  const selectedItem  = placements.find(p=>p.id===selected);
  const selectedGroup = selectedItem ? groups.find(g=>g.id===selectedItem.groupId) : null;
  // Sync selected layer to left pane
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{
    if(!selected) return;
    const item=placements.find(p=>p.id===selected);
    if(!item) return;
    updActive({
      uploadedImg:{src:item.src,naturalW:item.naturalW,naturalH:item.naturalH,name:item.name},
      placeW:parseFloat(item.w).toFixed(3),
      placeH:parseFloat(item.h).toFixed(3),
      copies:1,
      cutEnabled:item.cutEnabled||false,cutShape:item.cutShape||"rounded-rect",cutOffset:item.cutOffset||0.05,cutWidth:item.cutWidth||1,cutColor:item.cutColor||"#FF0000",cutRadius:item.cutRadius||0.1,
    });
    setLeftTab("add");
  },[selected]);
  const saveList = Object.values(saves).sort((a,b)=>b.savedAt?.localeCompare(a.savedAt));

  // ── Dynamic preview scale based on container ──
  const [previewScale, setPreviewScale] = useState(0.18);
  useEffect(()=>{
    const el = canvasWrapRef.current; if(!el) return;
    const obs = new ResizeObserver(entries=>{
      const {width,height} = entries[0].contentRect;
      const scaleW = (width-32)  / (sheetW * SCREEN_DPI);
      const scaleH = (height-32) / (sheetH * SCREEN_DPI);
      setPreviewScale(Math.min(scaleW, scaleH, 0.22));
    });
    obs.observe(el);
    return ()=>obs.disconnect();
  },[sheetW,sheetH,activeId]);

  const spx = useCallback((i)=> i * SCREEN_DPI * previewScale * zoom, [previewScale, zoom]);

  const snap = v => (!snapToGrid||!snapSize) ? v : Math.round(v/snapSize)*snapSize;

  // ── Tab management ──
  const uniqueLabel=(base,existing=sheets)=>{
    const names=new Set(existing.map(s=>s.label));
    if(!names.has(base)) return base;
    for(let i=2;i<999;i++){const n=`${base} ${i}`;if(!names.has(n))return n;}
    return `${base} ${Date.now()}`;
  };
  const addSheet = ()=>{
    const ns=makeSheet({label:uniqueLabel(`Sheet ${sheets.length+1}`),sheetW:active.sheetW,sheetH:active.sheetH,sheetDPI:active.sheetDPI,margin:active.margin,gap:active.gap});
    setSheets(prev=>[...prev,ns]); setActiveId(ns.id); setSelected(null); setLeftTab("sheet");
    if(isMobile) setDrawer(null);
  };
  const duplicateSheet=(sid,e)=>{
    e?.stopPropagation();
    const src=sheets.find(s=>s.id===sid); if(!src) return;
    const ns={...JSON.parse(JSON.stringify(src)),id:uid(),label:uniqueLabel(src.label+" (copy)")};
    // Remap group IDs and update placement references
    const gidMap={};
    ns.groups=ns.groups.map(g=>{const nid=uid();gidMap[g.id]=nid;return{...g,id:nid};});
    ns.placements=ns.placements.map(p=>({...p,id:uid(),groupId:gidMap[p.groupId]||p.groupId}));
    // Preload images
    ns.placements.forEach(p=>cachedImg(p.src));
    setSheets(prev=>{const i=prev.findIndex(s=>s.id===sid);const n=[...prev];n.splice(i+1,0,ns);return n;});
    setActiveId(ns.id); setSelected(null);
  };
  const closeSheet=(sid,e)=>{
    e?.stopPropagation();
    if(confirmClose) return; // prevent double-close while dialog is open
    const s=sheets.find(s=>s.id===sid);
    setConfirmClose({sheetId:sid,label:s?.label||"Sheet",hasContent:s?.placements?.length>0});
  };
  const doCloseSheet=(sid)=>{
    if(sheets.length<=1){const ns=makeSheet({label:"Sheet 1"});setSheets([ns]);setActiveId(ns.id);setSelected(null);setMultiSelected([]);setConfirmClose(null);setLeftTab("sheet");return;}
    const idx=sheets.findIndex(s=>s.id===sid);
    const next=sheets.filter(s=>s.id!==sid);
    if(!next.length){const ns=makeSheet({label:"Sheet 1"});setSheets([ns]);setActiveId(ns.id);setSelected(null);setMultiSelected([]);setConfirmClose(null);return;}
    setSheets(next);
    if(activeId===sid){setActiveId(next[Math.max(0,idx-1)].id);setSelected(null);}
    setConfirmClose(null);
  };
  const switchTab=sid=>{
    if(sid===activeId)return;
    // Save current zoom/scroll to departing sheet
    const wrap=canvasWrapRef.current;
    setSheets(prev=>prev.map(s=>s.id===activeId?{...s,zoom,scrollX:wrap?.scrollLeft||0,scrollY:wrap?.scrollTop||0}:s));
    // Restore zoom/scroll from incoming sheet
    const target=sheets.find(s=>s.id===sid);
    setZoom(target?.zoom||1);
    setActiveId(sid);setSelected(null);setHoveredGroup(null);setDragging(null);setPanX(0);setPanY(0);
    // Restore scroll position after render
    if(target&&wrap) requestAnimationFrame(()=>{wrap.scrollLeft=target.scrollX||0;wrap.scrollTop=target.scrollY||0;});
  };
  const startRenameTab=(sid,label,e)=>{e.stopPropagation();setEditingTabId(sid);setEditingTabLabel(label);setTimeout(()=>tabInputRef.current?.focus(),30);};
  const commitRenameTab=()=>{if(editingTabId) setSheets(prev=>prev.map(s=>s.id===editingTabId?{...s,label:editingTabLabel||s.label}:s));setEditingTabId(null);};

  // ── Desktop zoom & pan ──
  const [spaceDown, setSpaceDown] = useState(false);
  const isPanMode = activeTool === "pan" || spaceDown;
  const keyActionRef = useRef({});
  useEffect(()=>{
    const inInput=e=>e.target.closest("input,textarea,select");
    const onKeyDown=e=>{
      const ka=keyActionRef.current;
      if(e.code==="Space"&&!inInput(e)){e.preventDefault();spaceHeld.current=true;setSpaceDown(true);}
      if(e.key==="Escape"&&!inInput(e)){ka.setSelected(null);ka.setMultiSelected([]);}
      if(e.key==="v"&&!inInput(e))setActiveTool("select");
      if(e.key==="h"&&!inInput(e))setActiveTool("pan");
      if(e.ctrlKey&&e.key==="r"&&!inInput(e)){e.preventDefault();setShowRulers(r=>!r);}
      // Delete/Backspace to delete selected
      if((e.key==="Delete"||e.key==="Backspace")&&!inInput(e)){e.preventDefault();ka.deleteSelected();}
      // Ctrl+C to copy, Ctrl+V to paste
      if(e.ctrlKey&&e.key.toLowerCase()==="c"&&!inInput(e)){e.preventDefault();ka.copySelected();}
      if(e.ctrlKey&&e.key.toLowerCase()==="x"&&!inInput(e)){e.preventDefault();ka.cutSelected();}
      if(e.ctrlKey&&e.key.toLowerCase()==="v"&&!inInput(e)){e.preventDefault();ka.pasteFromClipboard();}
      // Ctrl+D to duplicate
      if(e.ctrlKey&&e.key==="d"&&!inInput(e)){e.preventDefault();ka.duplicateSelected();}
      // Ctrl+A to select all (cycle: group → all)
      if(e.ctrlKey&&e.key==="a"&&!inInput(e)){
        e.preventDefault();
        const{selected:sel,multiSelected:ms,setMultiSelected:setMS,setSelected:setSel,selectedItem:si,groups:grps,placements:pls}=ka;
        if(si){
          const siblings=pls.filter(p=>p.groupId===si.groupId);
          const cur=new Set([sel,...ms].filter(Boolean));
          const allSibs=siblings.every(p=>cur.has(p.id));
          if(!allSibs){setSel(siblings[0].id);setMS(siblings.slice(1).map(p=>p.id));}
          else if(pls.length){setSel(pls[0].id);setMS(pls.slice(1).map(p=>p.id));}
        } else if(pls.length){setSel(pls[0].id);setMS(pls.slice(1).map(p=>p.id));}
      }
      // Ctrl+0 to fit view
      if(e.ctrlKey&&e.key==="0"&&!inInput(e)){
        e.preventDefault();
        const wrap=ka.canvasWrapRef.current;if(!wrap)return;
        const wW=wrap.clientWidth-80,wH=wrap.clientHeight-80;
        const cw=ka.sheetW*SCREEN_DPI*ka.previewScale,ch=ka.sheetH*SCREEN_DPI*ka.previewScale;
        const fit=Math.min(wW/cw,wH/ch,1);
        ka.setZoom(fit);
      }
      // Ctrl+G to toggle grid
      if(e.ctrlKey&&e.key==="g"&&!inInput(e)){e.preventDefault();ka.updActive({showGrid:!ka.showGrid});}
      // Ctrl+Z undo, Ctrl+Shift+Z or Ctrl+Y redo
      if(e.ctrlKey&&e.key==="z"&&!e.shiftKey&&!inInput(e)){e.preventDefault();ka.undo();}
      if((e.ctrlKey&&e.key==="y"||(e.ctrlKey&&e.shiftKey&&e.key==="Z"))&&!inInput(e)){e.preventDefault();ka.redo();}
      // Arrow key nudge
      if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)&&!inInput(e)){
        e.preventDefault();
        const step=e.shiftKey?ka.snapSize*10:ka.snapSize;
        if(e.key==="ArrowLeft") ka.nudgeSelected(-step,0);
        if(e.key==="ArrowRight") ka.nudgeSelected(step,0);
        if(e.key==="ArrowUp") ka.nudgeSelected(0,-step);
        if(e.key==="ArrowDown") ka.nudgeSelected(0,step);
      }
      if(e.key==="?"&&!inInput(e)) ka.setShowShortcuts(v=>!v);
    };
    const onKeyUp=e=>{if(e.code==="Space"){spaceHeld.current=false;setSpaceDown(false);}};
    window.addEventListener("keydown",onKeyDown);
    window.addEventListener("keyup",onKeyUp);
    return()=>{window.removeEventListener("keydown",onKeyDown);window.removeEventListener("keyup",onKeyUp);};
  },[]);

  const onWheel=useCallback(e=>{
    // Only zoom when Ctrl/Cmd is held — otherwise let normal scroll through
    if(!e.ctrlKey&&!e.metaKey) return;
    e.preventDefault();
    const wrap=canvasWrapRef.current; if(!wrap) return;
    const delta=e.deltaY>0?0.9:1.1;
    const newZoom=Math.max(0.25,Math.min(50,zoom*delta));
    const rect=wrap.getBoundingClientRect();
    const cx=e.clientX-rect.left+wrap.scrollLeft;
    const cy=e.clientY-rect.top+wrap.scrollTop;
    const ratio=newZoom/zoom;
    const newScrollLeft=cx*ratio-(e.clientX-rect.left);
    const newScrollTop=cy*ratio-(e.clientY-rect.top);
    setZoom(newZoom);
    requestAnimationFrame(()=>{wrap.scrollLeft=newScrollLeft;wrap.scrollTop=newScrollTop;});
  },[zoom]);

  useEffect(()=>{
    const el=canvasWrapRef.current; if(!el) return;
    el.addEventListener("wheel",onWheel,{passive:false});
    return()=>el.removeEventListener("wheel",onWheel);
  },[onWheel]);

  // ── Aspect lock ──
  const handlePWChange=v=>{
    updActive({placeW:v});
    const newH=lockSide==="width"&&uploadedImg&&v?(parseFloat(v)*uploadedImg.naturalH/uploadedImg.naturalW).toFixed(3):null;
    if(newH) updActive({placeH:newH});
    // Live resize selected placement
    if(selected&&v){
      const nw=parseFloat(v);if(!nw||nw<=0)return;
      const nh=newH?parseFloat(newH):null;
      updActive(s=>({
        placements:s.placements.map(p=>p.id!==selected?p:{...p,w:nw,...(nh!=null?{h:nh}:{})}),
        groups:s.groups.map(g=>{const p=s.placements.find(p=>p.id===selected);return!p||g.id!==p.groupId?g:{...g,w:nw,...(nh!=null?{h:nh}:{})};})
      }));
    }
  };
  const handlePHChange=v=>{
    updActive({placeH:v});
    const newW=lockSide==="height"&&uploadedImg&&v?(parseFloat(v)*uploadedImg.naturalW/uploadedImg.naturalH).toFixed(3):null;
    if(newW) updActive({placeW:newW});
    // Live resize selected placement
    if(selected&&v){
      const nh=parseFloat(v);if(!nh||nh<=0)return;
      const nw=newW?parseFloat(newW):null;
      updActive(s=>({
        placements:s.placements.map(p=>p.id!==selected?p:{...p,h:nh,...(nw!=null?{w:nw}:{})}),
        groups:s.groups.map(g=>{const p=s.placements.find(p=>p.id===selected);return!p||g.id!==p.groupId?g:{...g,h:nh,...(nw!=null?{w:nw}:{})};})
      }));
    }
  };
  const handleLock=side=>{updActive({lockSide:side});if(!uploadedImg)return;if(side==="width"&&placeW)updActive({placeH:(parseFloat(placeW)*uploadedImg.naturalH/uploadedImg.naturalW).toFixed(3)});else if(side==="height"&&placeH)updActive({placeW:(parseFloat(placeH)*uploadedImg.naturalW/uploadedImg.naturalH).toFixed(3)});};

  // ── Upload ──
  const trimImage=(img)=>{
    const nw=img.naturalWidth,nh=img.naturalHeight;
    // For large images, scan at reduced resolution to find trim bounds, then crop at full res
    const MAX_SCAN=2048;
    const scale=Math.min(1,MAX_SCAN/Math.max(nw,nh));
    const sw=Math.round(nw*scale),sh=Math.round(nh*scale);
    const c=document.createElement("canvas");c.width=sw;c.height=sh;
    const ctx=c.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(img,0,0,sw,sh);
    let d;
    try{d=ctx.getImageData(0,0,sw,sh).data;}catch(e){console.warn("trimImage getImageData failed:",e);return null;}
    let top=sh,left=sw,bottom=0,right=0;
    for(let y=0;y<sh;y++) for(let x=0;x<sw;x++){
      if(d[(y*sw+x)*4+3]>10){if(y<top)top=y;if(y>bottom)bottom=y;if(x<left)left=x;if(x>right)right=x;}
    }
    if(bottom<top) return null; // fully transparent
    // Map back to full resolution coordinates (with small safety margin)
    const fLeft=Math.max(0,Math.floor(left/scale)-1);
    const fTop=Math.max(0,Math.floor(top/scale)-1);
    const fRight=Math.min(nw-1,Math.ceil((right+1)/scale)+1);
    const fBottom=Math.min(nh-1,Math.ceil((bottom+1)/scale)+1);
    const tw=fRight-fLeft+1,th=fBottom-fTop+1;
    if(tw>=nw-2&&th>=nh-2) return null; // nothing meaningful to trim
    const tc=document.createElement("canvas");tc.width=tw;tc.height=th;
    tc.getContext("2d").drawImage(img,fLeft,fTop,tw,th,0,0,tw,th);
    return{src:tc.toDataURL("image/png"),naturalW:tw,naturalH:th};
  };
  const loadImageFile=(file)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      cachedImg(url);
      let nw=img.naturalWidth,nh=img.naturalHeight,src=url;
      // Read trim setting from multiple sources to handle race conditions
      // 1. Check ref (updated every render)
      // 2. Also check the DOM toggle element as fallback
      let doTrim=autoTrimRef.current;
      if(!doTrim){
        // Fallback: read directly from the sheets state
        try{
          const el=document.querySelector('[data-autotrim]');
          if(el&&el.dataset.autotrim==='true') doTrim=true;
        }catch(e){}
      }
      if(doTrim){
        const trimmed=trimImage(img);
        if(trimmed){
          src=trimmed.src;nw=trimmed.naturalW;nh=trimmed.naturalH;cachedImg(src);
          setTrimNotice(`Trimmed to ${nw}×${nh}px`);
        } else {
          setTrimNotice("No transparency to trim");
        }
        clearTimeout(trimNoticeTimer.current);
        trimNoticeTimer.current=setTimeout(()=>setTrimNotice(""),3000);
      }
      updActive({uploadedImg:{src,naturalW:nw,naturalH:nh,name:file.name},placeW:(nw/sheetDPI).toFixed(3),placeH:(nh/sheetDPI).toFixed(3),warning:""});
      setLeftTab("add");
      if(isMobile) setDrawer("add");
    };
    img.src=url;
  };
  const loadBatchFiles=async(files)=>{
    const items=await Promise.all(files.map(file=>new Promise(resolve=>{
      const url=URL.createObjectURL(file);
      const img=new Image();
      img.onload=()=>{
        cachedImg(url);
        let src=url,nw=img.naturalWidth,nh=img.naturalHeight,trimmed=false,originalSrc=url;
        if(autoTrimRef.current){const t=trimImage(img);if(t){src=t.src;nw=t.naturalW;nh=t.naturalH;cachedImg(src);trimmed=true;}}
        resolve({id:uid(),file,src,originalSrc,name:file.name,naturalW:nw,naturalH:nh,w:(nw/sheetDPI).toFixed(3),h:(nh/sheetDPI).toFixed(3),lockSide:"width",copies:1,ready:true,error:null,trimmed});
      };
      img.onerror=()=>resolve({id:uid(),file,src:url,name:file.name,naturalW:0,naturalH:0,w:"1",h:"1",lockSide:"width",copies:1,ready:false,error:"Failed to load"});
      img.src=url;
    })));
    setBatchFiles(items.filter(it=>!it.error));
  };
  const onFile=e=>{
    const files=[...e.target.files]; e.target.value="";
    if(!files.length) return;
    if(files.length===1){loadImageFile(files[0]);return;}
    loadBatchFiles(files);
  };
  // Drag-and-drop files onto canvas
  const onDragDropFile=e=>{
    e.preventDefault();e.stopPropagation();
    const files=[...e.dataTransfer.files].filter(f=>f.type.startsWith("image/"));
    if(files.length===1){
      const file=files[0],clientX=e.clientX,clientY=e.clientY;
      const url=URL.createObjectURL(file);
      const img=new Image();
      img.onload=()=>{
        cachedImg(url);
        const w=+(img.naturalWidth/sheetDPI).toFixed(3),h=+(img.naturalHeight/sheetDPI).toFixed(3);
        const{x:dx,y:dy}=toIn(clientX,clientY);
        const px=snap(Math.max(0,Math.min(dx-w/2,sheetW-w)));
        const py=snap(Math.max(0,Math.min(dy-h/2,sheetH-h)));
        const color=nextColor(),groupId=uid(),placementId=uid(),shortName=file.name.replace(/\.[^.]+$/,"");
        updActive(s=>({
          warning:"",
          uploadedImg:{src:url,naturalW:img.naturalWidth,naturalH:img.naturalHeight,name:file.name},
          placeW:w.toFixed(3),placeH:h.toFixed(3),copies:1,
          groups:[...s.groups,{id:groupId,name:shortName,color,src:url,w,h,gap:parseFloat(gap)||0,naturalW:img.naturalWidth,naturalH:img.naturalHeight,notes:""}],
          placements:[...s.placements,{id:placementId,groupId,color,src:url,name:file.name,x:px,y:py,w,h,rotation:0,flipH:false,flipV:false,naturalW:img.naturalWidth,naturalH:img.naturalHeight}]
        }));
        setSelected(placementId);setMultiSelected([]);setLeftTab("add");
      };
      img.src=url;
    }
    else if(files.length>1){loadBatchFiles(files);}
  };
  // Clipboard paste
  const onPaste=useCallback(e=>{
    const items=[...e.clipboardData.items];
    const imgItem=items.find(i=>i.type.startsWith("image/"));
    if(!imgItem) return;
    e.preventDefault();
    const file=imgItem.getAsFile();
    if(file) loadImageFile(file);
  },[sheetDPI,gap,margin,sheetW,sheetH]);
  useEffect(()=>{window.addEventListener("paste",onPaste);return()=>window.removeEventListener("paste",onPaste);},[onPaste]);
  // Project file export/import
  const exportProject=async()=>{
    const allSrcs=[...new Set(sheets.flatMap(s=>s.placements.map(p=>p.src)))];
    const sm={};for(const src of allSrcs){if(src.startsWith("data:"))sm[src]=src;else sm[src]=await toDataURL(src);}
    const ser=sheets.map(s=>({...s,placements:s.placements.map(p=>({...p,src:sm[p.src]||p.src})),groups:s.groups.map(g=>({...g,src:sm[g.src]||g.src})),uploadedImg:s.uploadedImg?{...s.uploadedImg,src:sm[s.uploadedImg.src]||s.uploadedImg.src}:null}));
    const blob=new Blob([JSON.stringify({version:1,sheets:ser,savedAt:new Date().toISOString()})],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`gangowl-project-${new Date().toISOString().slice(0,10)}.gangowl`;document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),5000);
  };
  const importProject=e=>{
    const file=e.target.files[0];if(!file)return;e.target.value="";
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        const data=JSON.parse(reader.result);
        const importSheet=(src)=>{
          const ns=makeSheet({...src,label:uniqueLabel(src.label||file.name.replace(/\.[^.]+$/,""))});
          ns.placements.forEach(p=>cachedImg(p.src));
          ns.groups?.forEach(g=>{if(g.src)cachedImg(g.src);});
          const ids=[...ns.placements.map(p=>p.id),...ns.groups.map(g=>g.id),ns.id];
          if(ids.length)_id=Math.max(...ids)+1;
          setSheets(prev=>[...prev,ns]);setActiveId(ns.id);setSelected(null);setShowSave(false);
        };
        if(data.sheet) importSheet(data.sheet);
        else if(data.sheets) data.sheets.forEach(s=>importSheet(s));
      }catch{}
    };
    reader.readAsText(file);
  };

  // ── Auto-place ──
  // Expand existing placements by their individual cut offsets so the packer
  // treats them as larger obstacles, preventing new items from overlapping outlines.
  const inflateByCut=(pls)=>pls.map(p=>{
    if(!p.cutEnabled||!p.cutShape||p.cutShape==="none") return p;
    const co=p.cutOffset||0;
    const dce=p.cutShape==="die-cut"?Math.max(p.w,p.h)*0.08:0;
    const expand=co+dce;
    return {...p,x:p.x-expand,y:p.y-expand,w:p.w+expand*2,h:p.h+expand*2};
  });
  const [nestingInProgress,setNestingInProgress]=useState(false);
  const [nestingProgress,setNestingProgress]=useState("");
  const [batchFiles,setBatchFiles]=useState(null);
  const [trimNotice,setTrimNotice]=useState("");
  const trimNoticeTimer=useRef(null);
  const [dragTabId,setDragTabId]=useState(null);
  const [dragOverTabId,setDragOverTabId]=useState(null);
  const [showShortcuts,setShowShortcuts]=useState(false);
  const [batchAllQty,setBatchAllQty]=useState("");
  const [batchPlacing,setBatchPlacing]=useState(false);
  const [batchProgress,setBatchProgress]=useState("");
  const autoPlace=async()=>{
    if(!uploadedImg||!placeW||!placeH) return;
    const img=cachedImg(uploadedImg.src);
    const g=parseFloat(gap)||0,rawM=parseFloat(margin)||0,m=rawM;
    const cutProps=cutEnabled?{cutEnabled,cutShape,cutOffset,cutWidth,cutColor,cutRadius}:{};
    const co=cutEnabled?(cutOffset||0):0;
    const shortName=uploadedImg.name.replace(/\.[^.]+$/,"");

    // Build list of size jobs: base size + extra sizes
    const sizeJobs=[{w:parseFloat(placeW),h:parseFloat(placeH),copies:parseInt(copies)||1},...extraSizes.map(sz=>({w:parseFloat(sz.w)||1,h:parseFloat(sz.h)||1,copies:parseInt(sz.copies)||1}))];
    // Sort largest first for better packing
    sizeJobs.sort((a,b)=>(b.w*b.h*b.copies)-(a.w*a.h*a.copies));
    const totalJobs=sizeJobs.reduce((s,j)=>s+j.copies,0);

    setNestingInProgress(true);
    setNestingProgress(sizeJobs.length>1?`Preparing ${sizeJobs.length} sizes…`:"Preparing masks…");
    await new Promise(r=>setTimeout(r,0));

    let accPlacements=[...placements]; // accumulated placements for sequential packing
    const allNewGroups=[], allNewPlacements=[];
    let warn="", placedTotal=0;

    for(let si=0;si<sizeJobs.length;si++){
      const job=sizeJobs[si];
      const w=job.w, h=job.h, n=job.copies;
      const dieCutExtra=cutEnabled&&cutShape==="die-cut"?Math.max(w,h)*0.08:0;
      let packed;

      if(sizeJobs.length>1) setNestingProgress(`Size ${si+1}/${sizeJobs.length} (${w}"×${h}"): preparing…`);

      if(autoRotatePlace&&img.complete&&img.naturalWidth){
        const nested=await nestItems(img,w,h,g,co,dieCutExtra,cutShape,cutEnabled,sheetW,sheetH,n,m,accPlacements,true,(done,total)=>{
          setNestingProgress(sizeJobs.length>1?`Size ${si+1}/${sizeJobs.length}: placing ${done+1}/${total}`:`Placing ${done+1} of ${total}...`);
        },!autoDistribute);
        packed=nested.map(p=>({...p,rotated:p.rotation!==0}));
      } else {
        const gFull=g+(co+dieCutExtra)*2;
        const overflowSH=autoDistribute?sheetH:sheetH+n*(h+gFull);
        packed=packItems(inflateByCut(accPlacements),w,h,gFull,sheetW,overflowSH,n,m).map(p=>({...p,rotated:false}));
      }

      if(!packed.length&&!autoDistribute){
        const gFull=g+(co+dieCutExtra)*2;
        const maxBottom=accPlacements.length?Math.max(...accPlacements.map(p=>p.y+p.h)):0;
        packed=packItems(inflateByCut(accPlacements),w,h,gFull,sheetW,maxBottom+h*n+gFull*n+m*2,n,m).map(p=>({...p,rotated:false}));
      }

      const belowCanvas=packed.some(p=>p.y+p.h>sheetH);
      if(belowCanvas&&!autoDistribute&&!warn) warn="⚠ Placed below canvas — increase sheet height to print";

      // Track remaining for overflow distribution
      sizeJobs[si]._placed=packed.length;

      const color=nextColor(),groupId=uid();
      const group={id:groupId,name:sizeJobs.length>1?`${shortName} (${w}"×${h}")`:shortName,color,src:uploadedImg.src,w,h,gap:g,naturalW:uploadedImg.naturalW,naturalH:uploadedImg.naturalH,notes:jobNotes,rotation,flipH,flipV};
      allNewGroups.push(group);

      const newPls=packed.map(p=>{
        const rot=p.rotation!==undefined?(rotation+p.rotation)%360:p.rotated?(rotation+90)%360:rotation;
        const isSwap=rot===90||rot===270;
        const pw=isSwap?h:w,ph=isSwap?w:h;
        return{id:uid(),groupId,color,src:uploadedImg.src,name:uploadedImg.name,x:p.x,y:p.y,w:pw,h:ph,rotation:rot,flipH,flipV,naturalW:uploadedImg.naturalW,naturalH:uploadedImg.naturalH,...cutProps};
      });
      allNewPlacements.push(...newPls);
      accPlacements=[...accPlacements,...newPls]; // so next size packs around these
      placedTotal+=packed.length;
    }

    // ─── Auto-distribute overflow to new sheets ───
    const overflowSheets=[];
    if(autoDistribute){
      // Collect remaining counts per size job
      const remaining=sizeJobs.map((j,i)=>({...j,left:j.copies-(j._placed||0)})).filter(j=>j.left>0);
      let totalRemaining=remaining.reduce((s,j)=>s+j.left,0);

      while(totalRemaining>0){
        const sheetSettings={sheetW,sheetH,sheetDPI,margin,gap:g,showMargin,showGrid,gridSize,gridStyle,snapToGrid,snapSize,canvasBg,mirrorExport,autoRotateFill,autoRotatePlace,autoDistribute,snapToItems,autoTrimImport,cutEnabled,cutShape,cutOffset,cutWidth,cutColor,cutRadius,inkCostPerSqIn};
        const ns=makeSheet({...sheetSettings,label:uniqueLabel(`Sheet ${sheets.length+overflowSheets.length+1}`)});
        let nsAcc=[];
        let placedThisSheet=0;

        for(const rj of remaining){
          if(rj.left<=0) continue;
          const w=rj.w,h=rj.h,n=rj.left;
          const dieCutExtra=cutEnabled&&cutShape==="die-cut"?Math.max(w,h)*0.08:0;
          let packed;

          setNestingProgress(`Overflow sheet ${overflowSheets.length+1}: placing ${w}"×${h}"…`);
          await new Promise(r=>setTimeout(r,0));

          if(autoRotatePlace&&img.complete&&img.naturalWidth){
            packed=await nestItems(img,w,h,g,co,dieCutExtra,cutShape,cutEnabled,sheetW,sheetH,n,m,nsAcc,true,null,false);
            packed=packed.map(p=>({...p,rotated:p.rotation!==0}));
          } else {
            const gFull=g+(co+dieCutExtra)*2;
            packed=packItems(nsAcc.map(p=>{const pco=cutEnabled?(cutOffset||0):0;const pdce=cutEnabled&&cutShape==="die-cut"?Math.max(p.w,p.h)*0.08:0;const exp=pco+pdce;return{...p,x:p.x-exp,y:p.y-exp,w:p.w+exp*2,h:p.h+exp*2};}),w,h,gFull,sheetW,sheetH,n,m).map(p=>({...p,rotated:false}));
          }

          if(packed.length>0){
            const color=nextColor(),groupId=uid();
            ns.groups.push({id:groupId,name:sizeJobs.length>1?`${shortName} (${w}"×${h}")`:shortName,color,src:uploadedImg.src,w,h,gap:g,naturalW:uploadedImg.naturalW,naturalH:uploadedImg.naturalH,notes:jobNotes,rotation,flipH,flipV});
            const newPls=packed.map(p=>{
              const rot=p.rotation!==undefined?(rotation+p.rotation)%360:p.rotated?(rotation+90)%360:rotation;
              const isSwap=rot===90||rot===270;
              const pw=isSwap?h:w,ph=isSwap?w:h;
              return{id:uid(),groupId,color,src:uploadedImg.src,name:uploadedImg.name,x:p.x,y:p.y,w:pw,h:ph,rotation:rot,flipH,flipV,naturalW:uploadedImg.naturalW,naturalH:uploadedImg.naturalH,...cutProps};
            });
            ns.placements.push(...newPls);
            nsAcc=[...nsAcc,...newPls];
            rj.left-=packed.length;
            placedThisSheet+=packed.length;
          }
        }

        if(placedThisSheet===0) break; // safety: item too large for sheet
        overflowSheets.push(ns);
        totalRemaining=remaining.reduce((s,j)=>s+j.left,0);
      }

      if(remaining.some(j=>j.left>0)&&!warn) warn="Some items didn't fit.";
    } else {
      if(placedTotal<sizeJobs.reduce((s,j)=>s+j.copies,0)&&!warn) warn="Some items didn't fit.";
    }

    setNestingInProgress(false);

    // DPI warning for base size
    const bw=parseFloat(placeW),bh=parseFloat(placeH);
    const{warn:rW,caution,effDpi}=nativeRes(uploadedImg.naturalW,uploadedImg.naturalH,bw,bh,sheetDPI);
    if(rW&&!warn) warn=`⚠ ${Math.round(effDpi)}dpi — may blur (target ${sheetDPI})`;
    else if(caution&&!warn) warn=`⚠ ${Math.round(effDpi)}dpi at this size`;

    updActive(s=>({warning:warn,extraSizes:[],groups:[...s.groups,...allNewGroups],placements:[...s.placements,...allNewPlacements]}));
    if(overflowSheets.length){
      setSheets(prev=>[...prev,...overflowSheets]);
      setActiveId(overflowSheets[overflowSheets.length-1].id);
    }
    if(isMobile) setDrawer(null);
  };

  // Batch place: place all images from batch modal
  const batchPlace=async()=>{
    if(!batchFiles||!batchFiles.length) return;
    const g=parseFloat(gap)||0,m=parseFloat(margin)||0;
    const co=cutEnabled?(cutOffset||0):0;
    const cutProps=cutEnabled?{cutEnabled,cutShape,cutOffset,cutWidth,cutColor,cutRadius}:{};

    // Flatten all images × sizes into jobs, sort largest first
    const jobs=[];
    batchFiles.forEach(bf=>{
      const sizes=bf.sizes||[{id:"base",w:bf.w,h:bf.h,copies:bf.copies||1}];
      sizes.forEach(sz=>{
        const w=parseFloat(sz.w)||1,h=parseFloat(sz.h)||1,n=parseInt(sz.copies)||1;
        jobs.push({src:bf.src,name:bf.name,naturalW:bf.naturalW,naturalH:bf.naturalH,w,h,copies:n});
      });
    });
    jobs.sort((a,b)=>(b.w*b.h*b.copies)-(a.w*a.h*a.copies));

    const totalItems=jobs.reduce((s,j)=>s+j.copies,0);
    setBatchPlacing(true);setBatchProgress(`Preparing ${jobs.length} designs…`);
    await new Promise(r=>setTimeout(r,0));

    let accPlacements=[...placements];
    const allGroups=[],allPlacements=[];
    let warn="",jobsDone=0;

    for(let ji=0;ji<jobs.length;ji++){
      const job=jobs[ji];
      const w=job.w,h=job.h,n=job.copies;
      const dieCutExtra=cutEnabled&&cutShape==="die-cut"?Math.max(w,h)*0.08:0;
      const img=cachedImg(job.src);
      let packed;

      setBatchProgress(`Design ${ji+1}/${jobs.length}: ${job.name} (${w}"×${h}")…`);
      await new Promise(r=>setTimeout(r,0));

      if(autoRotatePlace&&img&&img.complete&&img.naturalWidth){
        packed=await nestItems(img,w,h,g,co,dieCutExtra,cutShape,cutEnabled,sheetW,sheetH,n,m,accPlacements,true,(done,total)=>{
          setBatchProgress(`Design ${ji+1}/${jobs.length}: placing ${done+1}/${total}`);
        },!autoDistribute);
        packed=packed.map(p=>({...p,rotated:p.rotation!==0}));
      } else {
        const gFull=g+(co+dieCutExtra)*2;
        const overflowSH=autoDistribute?sheetH:sheetH+n*(h+gFull);
        packed=packItems(inflateByCut(accPlacements),w,h,gFull,sheetW,overflowSH,n,m).map(p=>({...p,rotated:false}));
      }

      if(!packed.length&&!autoDistribute){
        const gFull=g+(co+dieCutExtra)*2;
        const maxBottom=accPlacements.length?Math.max(...accPlacements.map(p=>p.y+p.h)):0;
        packed=packItems(inflateByCut(accPlacements),w,h,gFull,sheetW,maxBottom+h*n+gFull*n+m*2,n,m).map(p=>({...p,rotated:false}));
      }

      const belowCanvas=packed.some(p=>p.y+p.h>sheetH);
      if(belowCanvas&&!autoDistribute&&!warn) warn="⚠ Placed below canvas — increase sheet height to print";

      // Track remaining for overflow
      jobs[ji]._placed=packed.length;

      const color=nextColor(),groupId=uid(),shortName=job.name.replace(/\.[^.]+$/,"");
      allGroups.push({id:groupId,name:shortName,color,src:job.src,w,h,gap:g,naturalW:job.naturalW,naturalH:job.naturalH,notes:"",rotation:0,flipH:false,flipV:false});

      const newPls=packed.map(p=>{
        const rot=p.rotation||0;
        const isRot=rot===90||rot===270;
        const pw=isRot?h:w,ph=isRot?w:h;
        return{id:uid(),groupId,color,src:job.src,name:job.name,x:p.x,y:p.y,w:pw,h:ph,rotation:rot,flipH:false,flipV:false,naturalW:job.naturalW,naturalH:job.naturalH,...cutProps};
      });
      allPlacements.push(...newPls);
      accPlacements=[...accPlacements,...newPls];
      jobsDone++;
    }

    // ─── Auto-distribute overflow to new sheets ───
    const batchOverflowSheets=[];
    if(autoDistribute){
      const remaining=jobs.map(j=>({...j,left:j.copies-(j._placed||0)})).filter(j=>j.left>0);
      let totalRemaining=remaining.reduce((s,j)=>s+j.left,0);

      while(totalRemaining>0){
        const sheetSettings={sheetW,sheetH,sheetDPI,margin,gap:g,showMargin,showGrid,gridSize,gridStyle,snapToGrid,snapSize,canvasBg,mirrorExport,autoRotateFill,autoRotatePlace,autoDistribute,snapToItems,autoTrimImport,cutEnabled,cutShape,cutOffset,cutWidth,cutColor,cutRadius,inkCostPerSqIn};
        const ns=makeSheet({...sheetSettings,label:uniqueLabel(`Sheet ${sheets.length+batchOverflowSheets.length+1}`)});
        let nsAcc=[];
        let placedThisSheet=0;

        for(const rj of remaining){
          if(rj.left<=0) continue;
          const w=rj.w,h=rj.h,n=rj.left;
          const dieCutExtra=cutEnabled&&cutShape==="die-cut"?Math.max(w,h)*0.08:0;
          const img=cachedImg(rj.src);
          let packed;

          setBatchProgress(`Overflow sheet ${batchOverflowSheets.length+1}: ${rj.name}…`);
          await new Promise(r=>setTimeout(r,0));

          if(autoRotatePlace&&img&&img.complete&&img.naturalWidth){
            packed=await nestItems(img,w,h,g,co,dieCutExtra,cutShape,cutEnabled,sheetW,sheetH,n,m,nsAcc,true,null,false);
            packed=packed.map(p=>({...p,rotated:p.rotation!==0}));
          } else {
            const gFull=g+(co+dieCutExtra)*2;
            packed=packItems(nsAcc.map(p=>{const pco=cutEnabled?(cutOffset||0):0;const pdce=cutEnabled&&cutShape==="die-cut"?Math.max(p.w,p.h)*0.08:0;const exp=pco+pdce;return{...p,x:p.x-exp,y:p.y-exp,w:p.w+exp*2,h:p.h+exp*2};}),w,h,gFull,sheetW,sheetH,n,m).map(p=>({...p,rotated:false}));
          }

          if(packed.length>0){
            const color=nextColor(),groupId=uid(),shortName=rj.name.replace(/\.[^.]+$/,"");
            ns.groups.push({id:groupId,name:shortName,color,src:rj.src,w,h,gap:g,naturalW:rj.naturalW,naturalH:rj.naturalH,notes:"",rotation:0,flipH:false,flipV:false});
            const newPls=packed.map(p=>{
              const rot=p.rotation||0;
              const isRot=rot===90||rot===270;
              const pw=isRot?h:w,ph=isRot?w:h;
              return{id:uid(),groupId,color,src:rj.src,name:rj.name,x:p.x,y:p.y,w:pw,h:ph,rotation:rot,flipH:false,flipV:false,naturalW:rj.naturalW,naturalH:rj.naturalH,...cutProps};
            });
            ns.placements.push(...newPls);
            nsAcc=[...nsAcc,...newPls];
            rj.left-=packed.length;
            placedThisSheet+=packed.length;
          }
        }

        if(placedThisSheet===0) break; // safety: item too large for sheet
        batchOverflowSheets.push(ns);
        totalRemaining=remaining.reduce((s,j)=>s+j.left,0);
      }

      if(remaining.some(j=>j.left>0)&&!warn) warn="Some items didn't fit.";
    } else {
      if(jobs.some(j=>(j._placed||0)<j.copies)&&!warn) warn="Some items didn't fit.";
    }

    setBatchPlacing(false);
    updActive(s=>({warning:warn,groups:[...s.groups,...allGroups],placements:[...s.placements,...allPlacements]}));
    if(batchOverflowSheets.length){
      setSheets(prev=>[...prev,...batchOverflowSheets]);
      setActiveId(batchOverflowSheets[batchOverflowSheets.length-1].id);
    }
    setBatchFiles(null);
  };

  const doFillSheet=()=>{
    setShowFillConfirm(false);
    if(!groups.length) return;
    const designs=groups.map(g=>{const gp=placements.find(p=>p.groupId===g.id);const co=gp?.cutEnabled?(gp.cutOffset||0):0;const dce=gp?.cutEnabled&&gp?.cutShape==="die-cut"?Math.max(g.w,g.h)*0.08:0;return{w:g.w,h:g.h,gap:(g.gap||gap)+(co+dce)*2,src:g.src,groupId:g.id,color:g.color,name:g.name,naturalW:g.naturalW,naturalH:g.naturalH};});
    const existing=inflateByCut(placements).map(p=>({x:p.x,y:p.y,w:p.w,h:p.h}));
    const packed=fillSheet(designs,sheetW,sheetH,parseFloat(margin)||0,existing,autoRotateFill);
    updActive(s=>({placements:[...s.placements,...packed.map(p=>({id:uid(),groupId:p.groupId,color:p.color,src:p.src,name:p.name,x:p.x,y:p.y,w:p.w,h:p.h,rotation:p.rotation||0,flipH:false,flipV:false,naturalW:p.naturalW,naturalH:p.naturalH}))]}));
  };

  const deleteSelected=()=>{
    if(!selected) return;
    const ids=multiSelected.length>0?[...multiSelected,selected].filter(Boolean):[selected].filter(Boolean);
    if(!ids.length) return;
    const count=ids.length;
    setConfirmDelete({ids,label:`${count} placement${count!==1?"s":""}`});
  };
  const doDelete=(ids)=>{
    const delSet=new Set(ids);
    updActive(s=>{
      const next=s.placements.filter(x=>!delSet.has(x.id));
      const usedGroups=new Set(next.map(p=>p.groupId));
      const ng=s.groups.filter(g=>usedGroups.has(g.id));
      return{placements:next,groups:ng};
    });
    setSelected(null);setMultiSelected([]);setConfirmDelete(null);
  };
  const renameGroup=(gid,name)=>{updActive(s=>({groups:s.groups.map(g=>g.id===gid?{...g,name}:g)}));};
  const duplicateGroup=(gid)=>{
    const g=groups.find(g=>g.id===gid);if(!g)return;
    const newGid=uid();const gp=placements.filter(p=>p.groupId===gid);
    const newGroup={...g,id:newGid,name:g.name+" (copy)"};
    const newPlacements=gp.map(p=>({...p,id:uid(),groupId:newGid}));
    updActive(s=>({groups:[...s.groups,newGroup],placements:[...s.placements,...newPlacements]}));
  };
  const addEmptyGroup=()=>{
    const gid=uid();const color=nextColor();
    updActive(s=>({groups:[...s.groups,{id:gid,name:`Group ${s.groups.length+1}`,src:"",color,w:1,h:1,naturalW:0,naturalH:0,notes:""}]}));
  };
  const renamePlacement=(pid,name)=>{updActive(s=>({placements:s.placements.map(p=>p.id===pid?{...p,name}:p)}));};
  const toggleGroupCollapse=(gid)=>setCollapsedGroups(prev=>{const n=new Set(prev);if(n.has(gid))n.delete(gid);else n.add(gid);return n;});
  const deleteGroup=(gid,e)=>{
    e?.stopPropagation();
    const g=groups.find(g=>g.id===gid);
    const count=placements.filter(p=>p.groupId===gid).length;
    setConfirmDelete({groupId:gid,label:`"${g?.name||"Group"}" (${count} item${count!==1?"s":""})`});
  };
  const doDeleteGroup=(gid)=>{
    updActive(s=>({placements:s.placements.filter(p=>p.groupId!==gid),groups:s.groups.filter(g=>g.id!==gid)}));
    if(placements.find(p=>p.id===selected)?.groupId===gid)setSelected(null);
    setConfirmDelete(null);
  };
  // Lock/Visibility toggles
  const toggleLock=(id)=>updActive(s=>({placements:s.placements.map(p=>p.id===id?{...p,locked:!p.locked}:p)}));
  const toggleGroupLock=(gid)=>updActive(s=>({placements:s.placements.map(p=>p.groupId===gid?{...p,locked:!p.locked}:p)}));
  const toggleVisible=(id)=>updActive(s=>({placements:s.placements.map(p=>p.id===id?{...p,visible:p.visible===false?true:false}:p)}));
  const toggleGroupVisible=(gid)=>{const anyHidden=placements.some(p=>p.groupId===gid&&p.visible===false);updActive(s=>({placements:s.placements.map(p=>p.groupId===gid?{...p,visible:anyHidden?true:false}:p)}));};
  // Nudge selected items
  const nudgeSelected=(dx,dy)=>{
    const ids=[...new Set([selected,...multiSelected].filter(Boolean))];
    if(!ids.length) return;
    updActive(s=>({placements:s.placements.map(p=>ids.includes(p.id)&&!p.locked?{...p,x:snap(p.x+dx),y:snap(p.y+dy)}:p)}));
  };
  // Alignment tools
  const alignSelected=(mode)=>{
    const ids=[...new Set([selected,...multiSelected].filter(Boolean))];
    const items=placements.filter(p=>ids.includes(p.id));
    if(items.length<2&&!["centerH","centerV"].includes(mode)) return;
    let update;
    if(mode==="left"){const min=Math.min(...items.map(p=>p.x));update=p=>({x:min});}
    else if(mode==="right"){const max=Math.max(...items.map(p=>p.x+p.w));update=p=>({x:max-p.w});}
    else if(mode==="top"){const min=Math.min(...items.map(p=>p.y));update=p=>({y:min});}
    else if(mode==="bottom"){const max=Math.max(...items.map(p=>p.y+p.h));update=p=>({y:max-p.h});}
    else if(mode==="centerH"){const cx=items.length>1?items.reduce((a,p)=>a+p.x+p.w/2,0)/items.length:sheetW/2;update=p=>({x:cx-p.w/2});}
    else if(mode==="centerV"){const cy=items.length>1?items.reduce((a,p)=>a+p.y+p.h/2,0)/items.length:sheetH/2;update=p=>({y:cy-p.h/2});}
    else if(mode==="distributeH"){const sorted=[...items].sort((a,b)=>a.x-b.x);const minX=sorted[0].x,maxX=sorted[sorted.length-1].x+sorted[sorted.length-1].w;const totalW=sorted.reduce((a,p)=>a+p.w,0);const gap2=(maxX-minX-totalW)/Math.max(1,sorted.length-1);let cx2=minX;const map=new Map();sorted.forEach(p=>{map.set(p.id,cx2);cx2+=p.w+gap2;});update=p=>({x:map.get(p.id)??p.x});}
    else if(mode==="distributeV"){const sorted=[...items].sort((a,b)=>a.y-b.y);const minY=sorted[0].y,maxY=sorted[sorted.length-1].y+sorted[sorted.length-1].h;const totalH=sorted.reduce((a,p)=>a+p.h,0);const gap2=(maxY-minY-totalH)/Math.max(1,sorted.length-1);let cy2=minY;const map=new Map();sorted.forEach(p=>{map.set(p.id,cy2);cy2+=p.h+gap2;});update=p=>({y:map.get(p.id)??p.y});}
    if(!update) return;
    const idSet=new Set(ids);
    updActive(s=>({placements:s.placements.map(p=>idSet.has(p.id)?{...p,...update(p)}:p)}));
  };
  const duplicateSelected=()=>{
    if(!selectedItem) return;
    const p=selectedItem;
    const packed=packItems(placements,p.w,p.h,parseFloat(gap)||0,sheetW,sheetH,1,parseFloat(margin)||0);
    const nx=packed.length?packed[0].x:p.x+0.5;
    const ny=packed.length?packed[0].y:p.y+0.5;
    const np={...p,id:uid(),x:nx,y:ny};
    updActive(s=>({placements:[...s.placements,np],warning:packed.length?"":"⚠ Duplicated outside canvas bounds"})); setSelected(np.id);
  };
  const copySelected=()=>{
    const ka=keyActionRef.current||{};
    const sel=ka.selected, ms=ka.multiSelected||[], pls=ka.placements||[], grps=ka.groups||[];
    const ids=ms.length>0?[...ms,sel].filter(Boolean):[sel].filter(Boolean);
    if(!ids.length) return;
    const idSet=new Set(ids);
    const copiedPls=pls.filter(p=>idSet.has(p.id)).map(p=>({...p}));
    const groupIds=new Set(copiedPls.map(p=>p.groupId));
    const copiedGrps=grps.filter(g=>groupIds.has(g.id)).map(g=>({...g}));
    clipboardRef.current={placements:copiedPls,groups:copiedGrps,pasteCount:0};
  };
  const cutSelected=()=>{
    copySelected();
    deleteSelected();
  };
  const pasteFromClipboard=()=>{
    const cb=clipboardRef.current;
    if(!cb||!cb.placements.length) return;
    cb.pasteCount=(cb.pasteCount||0)+1;
    const offset=0.25*cb.pasteCount;
    const gidMap={};
    const newGroups=cb.groups.map(g=>{const nid=uid();gidMap[g.id]=nid;return{...g,id:nid};});
    const newPls=cb.placements.map(p=>({...p,id:uid(),groupId:gidMap[p.groupId]||p.groupId,x:p.x+offset,y:p.y+offset}));
    newPls.forEach(p=>cachedImg(p.src));
    // Use functional update to read current groups from state (not stale closure)
    updActive(s=>{
      const existingGroupIds=new Set(s.groups.map(g=>g.id));
      const groupsToAdd=newGroups.filter(g=>!existingGroupIds.has(g.id));
      return{groups:[...s.groups,...groupsToAdd],placements:[...s.placements,...newPls]};
    });
    if(newPls.length===1){setSelected(newPls[0].id);setMultiSelected([]);}
    else if(newPls.length>1){setSelected(newPls[0].id);setMultiSelected(newPls.slice(1).map(p=>p.id));}
  };
  keyActionRef.current = { deleteSelected, duplicateSelected, copySelected, cutSelected, pasteFromClipboard, setSelected, setMultiSelected, selected, multiSelected, selectedItem, groups, placements, setZoom, canvasWrapRef, sheetW, sheetH, previewScale, updActive, showGrid, undo, redo, nudgeSelected, snapSize: snapSize||0.25, setShowShortcuts };
  const rotateSelected  =deg=>{if(!selectedItem)return;updActive(s=>({placements:s.placements.map(p=>{if(p.id!==selected)return p;const oldRot=(p.rotation||0),newRot=((oldRot+deg+360)%360);const oldIs90=oldRot===90||oldRot===270,newIs90=newRot===90||newRot===270;const swap=oldIs90!==newIs90;return{...p,rotation:newRot,...(swap?{w:p.h,h:p.w,x:p.x+(p.w-p.h)/2,y:p.y+(p.h-p.w)/2}:{})};})}));};
  const flipSelected    =axis=>{if(!selectedItem)return;updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:axis==="h"?{...p,flipH:!p.flipH}:{...p,flipV:!p.flipV})}));};
  // Trim transparent pixels from a placement (smart-object-like)
  const trimSelected=()=>{
    if(!selectedItem) return;
    const p=selectedItem;
    const img=cachedImg(p.src);
    if(!img.complete||!img.naturalWidth) return;
    const c=document.createElement("canvas");c.width=img.naturalWidth;c.height=img.naturalHeight;
    const ctx=c.getContext("2d");ctx.drawImage(img,0,0);
    const d=ctx.getImageData(0,0,c.width,c.height).data;
    let top=c.height,left=c.width,bottom=0,right=0;
    for(let y=0;y<c.height;y++) for(let x=0;x<c.width;x++){
      if(d[(y*c.width+x)*4+3]>10){if(y<top)top=y;if(y>bottom)bottom=y;if(x<left)left=x;if(x>right)right=x;}
    }
    if(bottom<top) return; // fully transparent
    const tw=right-left+1,th=bottom-top+1;
    const tc=document.createElement("canvas");tc.width=tw;tc.height=th;
    tc.getContext("2d").drawImage(c,left,top,tw,th,0,0,tw,th);
    const trimmedSrc=tc.toDataURL("image/png");
    // Calculate new dimensions in inches, maintaining scale
    const scaleX=p.w/img.naturalWidth,scaleY=p.h/img.naturalHeight;
    const newW=tw*scaleX,newH=th*scaleY;
    const offsetX=left*scaleX,offsetY=top*scaleY;
    updActive(s=>({
      placements:s.placements.map(pl=>pl.id!==p.id?pl:{...pl,src:trimmedSrc,x:pl.x+offsetX,y:pl.y+offsetY,w:newW,h:newH,naturalW:tw,naturalH:th}),
      groups:s.groups.map(g=>g.id!==p.groupId?g:{...g,src:trimmedSrc,w:newW,h:newH,naturalW:tw,naturalH:th}),
    }));
  };

  // ── Canvas draw ──
  // Calculate overflow extent from placements outside sheet bounds
  // Account for rotated bounding boxes so handles remain clickable
  const overflowPad=5; // inches of extra space around sheet for off-canvas dragging
  const rotBounds=(p)=>{
    if(!p.rotation) return {minX:p.x,minY:p.y,maxX:p.x+p.w,maxY:p.y+p.h};
    const cx=p.x+p.w/2,cy=p.y+p.h/2,rad=p.rotation*Math.PI/180;
    const cos=Math.cos(rad),sin=Math.sin(rad);
    const pts=[[-p.w/2,-p.h/2],[p.w/2,-p.h/2],[p.w/2,p.h/2],[-p.w/2,p.h/2]];
    let mnX=Infinity,mnY=Infinity,mxX=-Infinity,mxY=-Infinity;
    for(const[dx,dy] of pts){const rx=cos*dx-sin*dy+cx,ry=sin*dx+cos*dy+cy;mnX=Math.min(mnX,rx);mnY=Math.min(mnY,ry);mxX=Math.max(mxX,rx);mxY=Math.max(mxY,ry);}
    return{minX:mnX,minY:mnY,maxX:mxX,maxY:mxY};
  };
  // Include cut line offset so contours aren't clipped at canvas edges
  const cutPad=(p)=>{if(!p.cutEnabled) return 0; const co=p.cutOffset||0; const dce=p.cutShape==="die-cut"?Math.max(p.w,p.h)*0.08:0; return co+dce;};
  const isDraggingAny=!!(dragging||rotating||resizing);
  const calcOverflow=()=>{
    const pMinX=placements.length?Math.min(0,...placements.map(p=>{const c=cutPad(p),b=rotBounds(p);return b.minX-c;})):0;
    const pMinY=placements.length?Math.min(0,...placements.map(p=>{const c=cutPad(p),b=rotBounds(p);return b.minY-c;})):0;
    const pMaxX=placements.length?Math.max(sheetW,...placements.map(p=>{const c=cutPad(p),b=rotBounds(p);return b.maxX+c;})):sheetW;
    const pMaxY=placements.length?Math.max(sheetH,...placements.map(p=>{const c=cutPad(p),b=rotBounds(p);return b.maxY+c;})):sheetH;
    return{
      oL:Math.max(overflowPad,Math.abs(Math.min(0,pMinX))+overflowPad),
      oT:Math.max(overflowPad,Math.abs(Math.min(0,pMinY))+overflowPad),
      oR:Math.max(overflowPad,Math.max(0,pMaxX-sheetW)+overflowPad),
      oB:Math.max(overflowPad,Math.max(0,pMaxY-sheetH)+overflowPad),
    };
  };
  if(!isDraggingAny) frozenOverflow.current=null; // clear when not dragging
  if(isDraggingAny&&!frozenOverflow.current) frozenOverflow.current=calcOverflow(); // freeze on drag start
  const{oL,oT,oR,oB}=frozenOverflow.current||calcOverflow();
  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas) return;
    const ctx=canvas.getContext("2d");
    const cw=spx(sheetW), ch=spx(sheetH);
    const olPx=spx(oL),otPx=spx(oT),orPx=spx(oR),obPx=spx(oB);
    canvas.width=cw+olPx+orPx; canvas.height=ch+otPx+obPx;
    // Dark background for overflow area
    ctx.fillStyle=C.canvasBg;ctx.fillRect(0,0,canvas.width,canvas.height);
    // Sheet area
    ctx.save();ctx.translate(olPx,otPx);
    if(canvasBg==="checker"){
      const ts=11;
      for(let ty=0;ty*ts<ch;ty++) for(let tx=0;tx*ts<cw;tx++){ctx.fillStyle=(tx+ty)%2===0?"#cbcbcb":"#b0b0b0";ctx.fillRect(tx*ts,ty*ts,ts,ts);}
    }else{
      ctx.fillStyle=canvasBg;ctx.fillRect(0,0,cw,ch);
    }
    if(showGrid&&gridSize>0){
      // Adaptive: skip grid lines if they'd be less than 4px apart
      const pxPerGrid=spx(gridSize);
      let step=gridSize;
      while(spx(step)<4) step*=2;
      if(gridStyle==="dots"){
        ctx.fillStyle="rgba(99,102,241,0.5)";
        const r=Math.max(1.2,Math.min(3,pxPerGrid*0.08));
        for(let x=0;x<=sheetW;x+=step)for(let y=0;y<=sheetH;y+=step){ctx.beginPath();ctx.arc(spx(x),spx(y),r,0,Math.PI*2);ctx.fill();}
      }else{
        ctx.strokeStyle="rgba(99,102,241,0.3)";ctx.lineWidth=1;
        if(gridStyle==="dashed")ctx.setLineDash([4,4]);
        for(let x=0;x<=sheetW;x+=step){const sx=spx(x);ctx.beginPath();ctx.moveTo(sx,0);ctx.lineTo(sx,ch);ctx.stroke();}
        for(let y=0;y<=sheetH;y+=step){const sy=spx(y);ctx.beginPath();ctx.moveTo(0,sy);ctx.lineTo(cw,sy);ctx.stroke();}
        if(gridStyle==="dashed")ctx.setLineDash([]);
      }
    }
    const m=parseFloat(margin)||0;
    if(m>0){const ms=spx(m);ctx.fillStyle="rgba(239,68,68,0.06)";ctx.fillRect(0,0,cw,ms);ctx.fillRect(0,ch-ms,cw,ms);ctx.fillRect(0,ms,ms,ch-ms*2);ctx.fillRect(cw-ms,ms,ms,ch-ms*2);if(showMargin){ctx.strokeStyle="rgba(239,68,68,0.55)";ctx.lineWidth=1.5;ctx.setLineDash([6,4]);ctx.strokeRect(ms,ms,cw-ms*2,ch-ms*2);ctx.setLineDash([]);}}
    ctx.strokeStyle=C.accentSolid;ctx.lineWidth=2;ctx.strokeRect(1,1,cw-2,ch-2);
    [...placements].reverse().forEach(p=>{
      if(p.visible===false) return; // skip hidden layers
      const px=spx(p.x),py=spx(p.y),pw=spx(p.w),ph=spx(p.h);
      const isSel=p.id===selected||multiSelected.includes(p.id),isHov=p.groupId===hoveredGroup||p.id===hoveredPlacement;
      const imgObj=cachedImg(p.src);
      // Check if placement is fully outside canvas bounds
      const fullyOut=p.x+p.w<=0||p.x>=sheetW||p.y+p.h<=0||p.y>=sheetH;
      const partialOut=!fullyOut&&(p.x<0||p.y<0||p.x+p.w>sheetW||p.y+p.h>sheetH);
      // For 90/270° rotated items, w/h are the footprint (swapped).
      // drawImage needs original proportions so the image isn't warped.
      const isRot90 = p.rotation === 90 || p.rotation === 270;
      const dw = isRot90 ? ph : pw, dh = isRot90 ? pw : ph;
      ctx.save();ctx.translate(px+pw/2,py+ph/2);if(p.rotation)ctx.rotate((p.rotation*Math.PI)/180);if(p.flipH)ctx.scale(-1,1);if(p.flipV)ctx.scale(1,-1);
      if(p.locked){ctx.globalAlpha=0.7;} // dim locked layers slightly
      if(fullyOut){
        // Fully out of bounds: show placeholder only, no image
        ctx.fillStyle=p.color;ctx.globalAlpha=0.15;ctx.fillRect(-dw/2,-dh/2,dw,dh);ctx.globalAlpha=1;
        ctx.strokeStyle=p.color;ctx.lineWidth=1.5;ctx.setLineDash([6,4]);ctx.strokeRect(-dw/2,-dh/2,dw,dh);ctx.setLineDash([]);
      } else if(partialOut){
        // Partially out: clip image to canvas bounds
        ctx.save();
        // Compute clip rect in local (rotated) space — approximate with inverse transform of canvas rect
        const cpx=spx(Math.max(0,p.x))-px-pw/2,cpy=spx(Math.max(0,p.y))-py-ph/2;
        const cpw=spx(Math.min(sheetW,p.x+p.w)-Math.max(0,p.x)),cph=spx(Math.min(sheetH,p.y+p.h)-Math.max(0,p.y));
        if(!p.rotation){ctx.beginPath();ctx.rect(cpx,cpy,cpw,cph);ctx.clip();}
        if(imgObj.complete&&imgObj.naturalWidth>0){ctx.globalAlpha=isHov&&!isSel?0.6:1;ctx.drawImage(imgObj,-dw/2,-dh/2,dw,dh);ctx.globalAlpha=1;}
        else{ctx.fillStyle=p.color;ctx.globalAlpha=0.4;ctx.fillRect(-dw/2,-dh/2,dw,dh);ctx.globalAlpha=1;}
        ctx.restore();
        // Draw dashed border on the out-of-bounds portion
        ctx.strokeStyle=p.color;ctx.lineWidth=1;ctx.globalAlpha=0.4;ctx.setLineDash([4,3]);ctx.strokeRect(-pw/2,-ph/2,pw,ph);ctx.setLineDash([]);ctx.globalAlpha=1;
      } else {
        if(imgObj.complete&&imgObj.naturalWidth>0){ctx.globalAlpha=isHov&&!isSel?0.6:1;ctx.drawImage(imgObj,-dw/2,-dh/2,dw,dh);ctx.globalAlpha=1;}
        else{ctx.fillStyle=p.color;ctx.globalAlpha=0.4;ctx.fillRect(-dw/2,-dh/2,dw,dh);ctx.globalAlpha=1;}
      }
      // Draw cut contour line (per-placement)
      if(p.cutEnabled&&p.cutShape&&p.cutShape!=="none"){
        if(p.cutShape==="die-cut"){
          const osPx=spx(p.cutOffset||0);
          const key=`dc_${p.src.substring(0,40)}_${dw.toFixed(0)}_${dh.toFixed(0)}_${osPx.toFixed(0)}_${p.cutColor}_${p.cutWidth||1}`;
          if(!dieCutCache.has(key)){
            const r=buildDieCutCanvas(cachedImg(p.src),dw,dh,osPx,p.cutColor,p.cutWidth||1);
            if(r)dieCutCache.set(key,r);
            if(dieCutCache.size>100){dieCutCache.delete(dieCutCache.keys().next().value);}
          }
          const dc=dieCutCache.get(key);
          if(dc){
            const sx=dw/dc.cw, sy=dh/dc.ch;
            ctx.drawImage(dc.canvas,-dc.pad*sx-dw/2,-dc.pad*sy-dh/2,dc.tw*sx,dc.th*sy);
          }
        } else {
          const osPx=spx(p.cutOffset||0),rPx=spx(p.cutRadius||0);
          const contour=getCutContour(p.src,p.cutShape,dw,dh,osPx,rPx);
          if(contour){ctx.strokeStyle=p.cutColor||"#FF0000";ctx.lineWidth=p.cutWidth||1;ctx.stroke(contour);}
        }
      }
      // Draw selection/hover border inside the rotation transform (use dw/dh to match image)
      if(isSel){
        ctx.strokeStyle=C.amber;ctx.lineWidth=2;ctx.strokeRect(-dw/2-1,-dh/2-1,dw+2,dh+2);
        const hs=8;[[-dw/2-hs/2,-dh/2-hs/2],[dw/2-hs/2,-dh/2-hs/2],[-dw/2-hs/2,dh/2-hs/2],[dw/2-hs/2,dh/2-hs/2]].forEach(([hx,hy])=>{ctx.fillStyle=C.amber;ctx.fillRect(hx,hy,hs,hs);ctx.strokeStyle="#fff";ctx.lineWidth=1;ctx.strokeRect(hx,hy,hs,hs);});
        // Rotation arcs outside corners
        const ro=14;ctx.strokeStyle=C.accentSolid;ctx.lineWidth=1.5;
        [[-dw/2-ro,-dh/2-ro,0,-Math.PI/2],[dw/2+ro,-dh/2-ro,-Math.PI/2,-Math.PI],[-dw/2-ro,dh/2+ro,Math.PI/2,0],[dw/2+ro,dh/2+ro,Math.PI,Math.PI/2]].forEach(([cx2,cy2,sa,ea])=>{ctx.beginPath();ctx.arc(cx2,cy2,6,sa,ea);ctx.stroke();});
      } else if(isHov){ctx.strokeStyle=p.color;ctx.lineWidth=1.5;ctx.setLineDash([4,3]);ctx.strokeRect(-dw/2,-dh/2,dw,dh);ctx.setLineDash([]);}
      ctx.restore();
    });
    // Smart guides
    if(guidesRef.current.length){
      ctx.save();ctx.strokeStyle=C.accentSolid;ctx.lineWidth=1;ctx.setLineDash([4,4]);ctx.globalAlpha=0.7;
      for(const g of guidesRef.current){
        if(g.axis==="x"){const gx=spx(g.pos);ctx.beginPath();ctx.moveTo(gx,-spx(oT));ctx.lineTo(gx,ch+spx(oB));ctx.stroke();}
        else{const gy=spx(g.pos);ctx.beginPath();ctx.moveTo(-spx(oL),gy);ctx.lineTo(cw+spx(oR),gy);ctx.stroke();}
      }
      ctx.setLineDash([]);ctx.globalAlpha=1;ctx.restore();
    }
    ctx.restore(); // restore overflow translate
  },[placements,selected,multiSelected,hoveredGroup,hoveredPlacement,sheetW,sheetH,sheetDPI,margin,showMargin,showGrid,gridSize,gridStyle,canvasBg||"checker",activeId,previewScale,zoom,spx,oL,oT,oR,oB]);

  useEffect(()=>{
    clearInterval(imgTimer.current);
    imgTimer.current=setInterval(()=>{const ok=placements.every(p=>{const i=cachedImg(p.src);return i.complete&&i.naturalWidth>0;});if(!ok)updActive(s=>({placements:[...s.placements]}));},250);
    return()=>clearInterval(imgTimer.current);
  },[placements.length,activeId]);

  // ── Rulers ──
  const drawRulers=useCallback(()=>{
    if(!showRulers) return;
    const wrap=canvasWrapRef.current,hC=hRulerRef.current,vC=vRulerRef.current;
    if(!wrap||!hC||!vC) return;
    const scrollX=wrap.scrollLeft,scrollY=wrap.scrollTop;
    const wW=wrap.clientWidth,wH=wrap.clientHeight;
    const ppi=SCREEN_DPI*previewScale*zoom;
    // Tick interval adapts to zoom — show fewer ticks when zoomed out
    let tick, majorEvery;
    if(ppi<3){tick=50;majorEvery=50;}
    else if(ppi<6){tick=25;majorEvery=25;}
    else if(ppi<12){tick=10;majorEvery=10;}
    else if(ppi<25){tick=5;majorEvery=5;}
    else if(ppi<50){tick=2;majorEvery=2;}
    else if(ppi<100){tick=1;majorEvery=1;}
    else if(ppi<200){tick=0.5;majorEvery=1;}
    else{tick=0.25;majorEvery=1;}

    // Horizontal
    hC.width=wW;hC.height=RULER_SIZE;
    const hx=hC.getContext("2d");
    hx.fillStyle=C.surface;hx.fillRect(0,0,wW,RULER_SIZE);
    hx.strokeStyle=C.muted;hx.fillStyle=C.muted;hx.font="8px monospace";hx.textBaseline="top";
    const cv=canvasRef.current;
    const padL=cv?(cv.getBoundingClientRect().left-wrap.getBoundingClientRect().left+scrollX+spx(oL)):0;
    const startI=Math.floor((scrollX-padL)/ppi/tick)*tick;
    const endI=Math.ceil((scrollX-padL+wW)/ppi/tick)*tick;
    for(let i=startI;i<=endI;i+=tick){
      const x=i*ppi-scrollX+padL;
      if(x<0||x>wW) continue;
      const isMajor=Math.abs(i-Math.round(i/majorEvery)*majorEvery)<0.001;
      const th=isMajor?RULER_SIZE*0.6:RULER_SIZE*0.3;
      hx.beginPath();hx.moveTo(x,RULER_SIZE);hx.lineTo(x,RULER_SIZE-th);hx.stroke();
      if(isMajor) hx.fillText(`${Math.round(i)}"`,x+2,2);
    }
    // Shade areas outside the sheet bounds on horizontal ruler
    const canvasStartX=padL-scrollX, canvasEndX=canvasStartX+spx(sheetW);
    if(canvasStartX>0){hx.fillStyle="rgba(0,0,0,0.3)";hx.fillRect(0,0,canvasStartX,RULER_SIZE);}
    if(canvasEndX<wW){hx.fillStyle="rgba(0,0,0,0.3)";hx.fillRect(canvasEndX,0,wW-canvasEndX,RULER_SIZE);}
    // Mouse crosshair on horizontal ruler
    if(cv&&mousePos.current.x){
      const wrapRect=wrap.getBoundingClientRect();
      const mx=mousePos.current.x-wrapRect.left;
      if(mx>=0&&mx<=wW){hx.strokeStyle="#ef4444";hx.lineWidth=1;hx.beginPath();hx.moveTo(mx,0);hx.lineTo(mx,RULER_SIZE);hx.stroke();}
    }
    hx.strokeStyle=C.border;hx.beginPath();hx.moveTo(0,RULER_SIZE-0.5);hx.lineTo(wW,RULER_SIZE-0.5);hx.stroke();

    // Vertical
    vC.width=RULER_SIZE;vC.height=wH;
    const vx=vC.getContext("2d");
    vx.fillStyle=C.surface;vx.fillRect(0,0,RULER_SIZE,wH);
    vx.strokeStyle=C.muted;vx.fillStyle=C.muted;vx.font="8px monospace";vx.textBaseline="middle";
    const padT=cv?(cv.getBoundingClientRect().top-wrap.getBoundingClientRect().top+scrollY+spx(oT)):0;
    const startJ=Math.floor((scrollY-padT)/ppi/tick)*tick;
    const endJ=Math.ceil((scrollY-padT+wH)/ppi/tick)*tick;
    for(let j=startJ;j<=endJ;j+=tick){
      const y=j*ppi-scrollY+padT;
      if(y<0||y>wH) continue;
      const isMajor=Math.abs(j-Math.round(j/majorEvery)*majorEvery)<0.001;
      const tw=isMajor?RULER_SIZE*0.6:RULER_SIZE*0.3;
      vx.beginPath();vx.moveTo(RULER_SIZE,y);vx.lineTo(RULER_SIZE-tw,y);vx.stroke();
      if(isMajor){vx.save();vx.translate(9,y+2);vx.rotate(-Math.PI/2);vx.fillText(`${Math.round(j)}"`,0,0);vx.restore();}
    }
    // Shade areas outside canvas bounds on vertical ruler
    const canvasStartY=padT-scrollY, canvasEndY=canvasStartY+spx(sheetH);
    if(canvasStartY>0){vx.fillStyle="rgba(0,0,0,0.3)";vx.fillRect(0,0,RULER_SIZE,canvasStartY);}
    if(canvasEndY<wH){vx.fillStyle="rgba(0,0,0,0.3)";vx.fillRect(0,canvasEndY,RULER_SIZE,wH-canvasEndY);}
    // Mouse crosshair on vertical ruler
    if(cv&&mousePos.current.y){
      const wrapRect=wrap.getBoundingClientRect();
      const my=mousePos.current.y-wrapRect.top;
      if(my>=0&&my<=wH){vx.strokeStyle="#ef4444";vx.lineWidth=1;vx.beginPath();vx.moveTo(0,my);vx.lineTo(RULER_SIZE,my);vx.stroke();}
    }
    vx.strokeStyle=C.border;vx.beginPath();vx.moveTo(RULER_SIZE-0.5,0);vx.lineTo(RULER_SIZE-0.5,wH);vx.stroke();
  },[showRulers,previewScale,zoom,sheetW,sheetH,oL,oT]);

  useEffect(()=>{
    const wrap=canvasWrapRef.current; if(!wrap) return;
    const handler=()=>drawRulers();
    wrap.addEventListener("scroll",handler);
    drawRulers();
    return()=>wrap.removeEventListener("scroll",handler);
  },[drawRulers]);

  // ── Coordinate helpers ──
  const toIn=(cx,cy)=>{
    const r=canvasRef.current.getBoundingClientRect();
    return{x:(cx-r.left)/(SCREEN_DPI*previewScale*zoom)-oL,y:(cy-r.top)/(SCREEN_DPI*previewScale*zoom)-oT};
  };
  const hitTest=(x,y)=>{for(let i=placements.length-1;i>=0;i--){const p=placements[i];if(p.visible===false)continue;if(p.rotation){const{lx,ly}=toLocal(x,y,p);const isR=p.rotation===90||p.rotation===270;const hw=isR?p.h:p.w,hh=isR?p.w:p.h;const cx2=p.x+p.w/2,cy2=p.y+p.h/2;if(lx>=cx2-hw/2&&lx<=cx2+hw/2&&ly>=cy2-hh/2&&ly<=cy2+hh/2)return p;}else{if(x>=p.x&&x<=p.x+p.w&&y>=p.y&&y<=p.y+p.h)return p;}}return null;};

  // ── Transform point into placement's local (un-rotated) space ──
  const toLocal=(x,y,p)=>{
    if(!p.rotation) return {lx:x,ly:y};
    const cx=p.x+p.w/2, cy=p.y+p.h/2;
    const rad=-(p.rotation*Math.PI)/180;
    const dx=x-cx, dy=y-cy;
    return {lx:Math.cos(rad)*dx-Math.sin(rad)*dy+cx, ly:Math.sin(rad)*dx+Math.cos(rad)*dy+cy};
  };
  // ── Resize handle hit-test ──
  const hitTestHandle=(x,y)=>{
    if(!selectedItem) return null;
    const p=selectedItem;
    const{lx,ly}=toLocal(x,y,p);
    const hs=Math.max(0.2, 8/(SCREEN_DPI*previewScale*zoom));
    // Use original (un-swapped) dimensions to match visual handle positions
    const isR90=p.rotation===90||p.rotation===270;
    const hw=isR90?p.h:p.w, hh=isR90?p.w:p.h;
    const cx=p.x+p.w/2, cy=p.y+p.h/2;
    const corners=[
      {corner:"tl",cx:cx-hw/2,cy:cy-hh/2},{corner:"tr",cx:cx+hw/2,cy:cy-hh/2},
      {corner:"bl",cx:cx-hw/2,cy:cy+hh/2},{corner:"br",cx:cx+hw/2,cy:cy+hh/2},
    ];
    for(const c of corners) if(Math.abs(lx-c.cx)<hs&&Math.abs(ly-c.cy)<hs) return c;
    return null;
  };
  // ── Rotation handle hit-test (outside corners) ──
  const hitTestRotation=(x,y)=>{
    if(!selectedItem) return null;
    const p=selectedItem;
    const{lx,ly}=toLocal(x,y,p);
    const ro=Math.max(0.3, 14/(SCREEN_DPI*previewScale*zoom));
    const hs=Math.max(0.2, 10/(SCREEN_DPI*previewScale*zoom));
    const isR90=p.rotation===90||p.rotation===270;
    const hw=isR90?p.h:p.w, hh=isR90?p.w:p.h;
    const cx=p.x+p.w/2, cy=p.y+p.h/2;
    const corners=[
      {cx:cx-hw/2-ro,cy:cy-hh/2-ro},{cx:cx+hw/2+ro,cy:cy-hh/2-ro},
      {cx:cx-hw/2-ro,cy:cy+hh/2+ro},{cx:cx+hw/2+ro,cy:cy+hh/2+ro},
    ];
    for(const c of corners) if(Math.abs(lx-c.cx)<hs&&Math.abs(ly-c.cy)<hs) return c;
    return null;
  };

  // ── Mouse events (desktop) ──
  const onMD=e=>{
    // Middle-click, space+click, or pan tool → pan
    if(e.button===1||spaceHeld.current||activeTool==="pan"){
      e.preventDefault();
      const wrap=canvasWrapRef.current;
      desktopPanRef.current={startX:e.clientX,startY:e.clientY,scrollLeft:wrap.scrollLeft,scrollTop:wrap.scrollTop};
      return;
    }
    const{x,y}=toIn(e.clientX,e.clientY);
    // Check rotation handle (click outside corner of selected item)
    if(selectedItem){
      const rotHit=hitTestRotation(x,y);
      if(rotHit){
        const p=selectedItem;
        const cx=p.x+p.w/2,cy=p.y+p.h/2;
        const startAngle=Math.atan2(y-cy,x-cx)*180/Math.PI;
        setRotating({id:p.id,startAngle,origRotation:p.rotation||0});
        return;
      }
    }
    // Check resize handles on selected item first
    const handle=hitTestHandle(x,y);
    if(handle){
      const p=selectedItem;
      setResizing({id:p.id,corner:handle.corner,startX:x,startY:y,origX:p.x,origY:p.y,origW:p.w,origH:p.h,aspectRatio:p.w/p.h,rotation:p.rotation||0});
      return;
    }
    const p=hitTest(x,y);
    if(p){
      if(e.ctrlKey||e.metaKey){
        // Ctrl+click: toggle in multi-select, deselect if already the only selection
        if(p.id===selected&&multiSelected.length===0){
          setSelected(null);
        } else {
          setMultiSelected(prev=>{
            const next=prev.includes(p.id)?prev.filter(id=>id!==p.id):[...prev,p.id];
            if(p.id===selected&&next.length>0){setSelected(next[0]);return next.filter(id=>id!==next[0]);}
            if(!selected) setSelected(p.id);
            return next;
          });
        }
      } else {
        // If clicking an already multi-selected item, drag all of them
        const isInMulti=multiSelected.includes(p.id)||p.id===selected;
        if(multiSelected.length>0&&isInMulti){
          // Drag all selected items
          const allIds=[...new Set([selected,...multiSelected].filter(Boolean))];
          const origins=allIds.map(id=>{const pl=placements.find(pp=>pp.id===id);return pl?{id,origX:pl.x,origY:pl.y,origW:pl.w,origH:pl.h}:null;}).filter(Boolean);
          isDraggingCanvas.current=true;setDragging({id:p.id,startX:x,startY:y,origX:p.x,origY:p.y,multi:origins});
        } else {
          setSelected(p.id);setMultiSelected([]);
          if(!p.locked){isDraggingCanvas.current=true;setDragging({id:p.id,startX:x,startY:y,origX:p.x,origY:p.y});}
        }
      }
    } else {setSelected(null);setMultiSelected([]);}
  };
  const onMM=e=>{
    mousePos.current={x:e.clientX,y:e.clientY};
    if(showRulers) drawRulers();
    if(desktopPanRef.current){
      const wrap=canvasWrapRef.current;
      wrap.scrollLeft=desktopPanRef.current.scrollLeft-(e.clientX-desktopPanRef.current.startX);
      wrap.scrollTop=desktopPanRef.current.scrollTop-(e.clientY-desktopPanRef.current.startY);
      return;
    }
    // Rotation handle dragging
    if(rotating){
      const{x,y}=toIn(e.clientX,e.clientY);
      const p=placements.find(p=>p.id===rotating.id);
      if(!p) return;
      const cx=p.x+p.w/2,cy=p.y+p.h/2;
      const angle=Math.atan2(y-cy,x-cx)*180/Math.PI;
      let newRot=(rotating.origRotation+(angle-rotating.startAngle)+360)%360;
      // Snap to 15° increments when Shift is held
      if(e.shiftKey) newRot=Math.round(newRot/15)*15;
      updActive(s=>({placements:s.placements.map(p=>p.id!==rotating.id?p:{...p,rotation:Math.round(newRot)})}));
      return;
    }
    // Resize handle dragging
    if(resizing){
      const rawPt=toIn(e.clientX,e.clientY);
      const{corner,origX,origY,origW,origH,aspectRatio,rotation}=resizing;
      // Transform mouse to local (un-rotated) space of the placement
      const fakeP={x:origX,y:origY,w:origW,h:origH,rotation};
      const{lx:x,ly:y}=toLocal(rawPt.x,rawPt.y,fakeP);
      let nX=origX,nY=origY,nW=origW,nH=origH;
      if(rotation%360!==0){
        // For rotated images: resize keeping center fixed to avoid position drift
        const ocx=origX+origW/2,ocy=origY+origH/2;
        if(corner==="br"){nW=Math.max(0.25,(x-ocx)*2);nH=Math.max(0.25,(y-ocy)*2);}
        else if(corner==="bl"){nW=Math.max(0.25,(ocx-x)*2);nH=Math.max(0.25,(y-ocy)*2);}
        else if(corner==="tr"){nW=Math.max(0.25,(x-ocx)*2);nH=Math.max(0.25,(ocy-y)*2);}
        else if(corner==="tl"){nW=Math.max(0.25,(ocx-x)*2);nH=Math.max(0.25,(ocy-y)*2);}
        nX=ocx-nW/2;nY=ocy-nH/2;
      } else {
        if(corner==="br"){nW=Math.max(0.25,x-origX);nH=Math.max(0.25,y-origY);}
        else if(corner==="bl"){nW=Math.max(0.25,origX+origW-x);nH=Math.max(0.25,y-origY);nX=origX+origW-nW;}
        else if(corner==="tr"){nW=Math.max(0.25,x-origX);nH=Math.max(0.25,origY+origH-y);nY=origY+origH-nH;}
        else if(corner==="tl"){nW=Math.max(0.25,origX+origW-x);nH=Math.max(0.25,origY+origH-y);nX=origX+origW-nW;nY=origY+origH-nH;}
      }
      // Shift = aspect ratio lock
      if(e.shiftKey){
        if(nW/nH>aspectRatio)nW=nH*aspectRatio; else nH=nW/aspectRatio;
        if(corner==="tl"){nX=origX+origW-nW;nY=origY+origH-nH;}
        else if(corner==="tr")nY=origY+origH-nH;
        else if(corner==="bl")nX=origX+origW-nW;
      }
      // No clamping — allow off-canvas placement (clipped on export)
      updActive(s=>({placements:s.placements.map(p=>p.id!==resizing.id?p:{...p,x:snap(nX),y:snap(nY),w:snap(nW),h:snap(nH)})}));
      setResizeTooltip({x:e.clientX+15,y:e.clientY+15,w:snap(nW),h:snap(nH)});
      return;
    }
    if(!dragging){
      // Hover cursor detection for resize/rotation handles
      const{x,y}=toIn(e.clientX,e.clientY);
      const rHandle=hitTestHandle(x,y);
      if(rHandle){setHoverCursor(rHandle.corner==="tl"||rHandle.corner==="br"?"nwse-resize":"nesw-resize");return;}
      const rotH=hitTestRotation(x,y);
      if(rotH){setHoverCursor("alias");return;}
      const hit=hitTest(x,y);
      if(hit){setHoverCursor("move");return;}
      setHoverCursor(null);
      return;
    }
    const{x,y}=toIn(e.clientX,e.clientY);
    const dx=x-dragging.startX,dy=y-dragging.startY;
    // Smart guides: snap to other items' edges/centers
    const applySmartSnap=(px,py,pw,ph,dragIds)=>{
      if(!snapToItems){guidesRef.current=[];return{x:snap(px),y:snap(py)};}
      const thresh=Math.max(0.05,3/(SCREEN_DPI*previewScale*zoom));
      const others=placements.filter(p=>!dragIds.has(p.id)&&p.visible!==false);
      const guides=[];
      let sx=px,sy=py;
      const edges={l:px,r:px+pw,cx:px+pw/2,t:py,b:py+ph,cy:py+ph/2};
      let bestDx=thresh,bestDy=thresh;
      for(const o of others){
        const oe={l:o.x,r:o.x+o.w,cx:o.x+o.w/2,t:o.y,b:o.y+o.h,cy:o.y+o.h/2};
        for(const[ek,ev] of [["l",edges.l],["r",edges.r],["cx",edges.cx]]){
          for(const[ok,ov] of [["l",oe.l],["r",oe.r],["cx",oe.cx]]){
            const d=Math.abs(ev-ov);
            if(d<bestDx){bestDx=d;sx=px+(ov-ev);guides.push({axis:"x",pos:ov});}
          }
        }
        for(const[ek,ev] of [["t",edges.t],["b",edges.b],["cy",edges.cy]]){
          for(const[ok,ov] of [["t",oe.t],["b",oe.b],["cy",oe.cy]]){
            const d=Math.abs(ev-ov);
            if(d<bestDy){bestDy=d;sy=py+(ov-ev);guides.push({axis:"y",pos:ov});}
          }
        }
      }
      // Keep only guides that match final snapped position
      const finalGuides=guides.filter(g=>{
        if(g.axis==="x") return Math.abs(g.pos-sx)<thresh||Math.abs(g.pos-(sx+pw))<thresh||Math.abs(g.pos-(sx+pw/2))<thresh;
        return Math.abs(g.pos-sy)<thresh||Math.abs(g.pos-(sy+ph))<thresh||Math.abs(g.pos-(sy+ph/2))<thresh;
      });
      guidesRef.current=finalGuides;
      return{x:sx,y:sy};
    };
    if(dragging.multi){
      const originMap=new Map(dragging.multi.map(o=>[o.id,o]));
      const dragIds=new Set(dragging.multi.map(o=>o.id));
      const first=dragging.multi[0];
      const{x:sx,y:sy}=applySmartSnap(first.origX+dx,first.origY+dy,first.origW||0,first.origH||0,dragIds);
      const sdx=sx-(first.origX+dx),sdy=sy-(first.origY+dy);
      updActive(s=>({placements:s.placements.map(p=>{
        const o=originMap.get(p.id);if(!o) return p;
        return{...p,x:snap(o.origX+dx+sdx),y:snap(o.origY+dy+sdy)};
      })}));
    } else {
      const p=placements.find(p=>p.id===dragging.id);
      const pw=p?p.w:0,ph=p?p.h:0;
      const{x:sx,y:sy}=applySmartSnap(dragging.origX+dx,dragging.origY+dy,pw,ph,new Set([dragging.id]));
      updActive(s=>({placements:s.placements.map(p=>p.id!==dragging.id?p:{...p,x:snap(sx),y:snap(sy)})}));
    }
  };
  const onMU=()=>{
    guidesRef.current=[];
    if(resizing){
      // Sync group dimensions to match resized placement so auto-place/fill-sheet use correct size
      const p=placements.find(p=>p.id===resizing.id);
      if(p) updActive(s=>({groups:s.groups.map(g=>g.id!==p.groupId?g:{...g,w:p.w,h:p.h})}));
    }
    isDraggingCanvas.current=false;setDragging(null);setResizing(null);setRotating(null);setResizeTooltip(null);desktopPanRef.current=null;
  };
  // Attach window-level listeners during drag/rotate/resize so events continue outside canvas
  useEffect(()=>{
    if(!dragging&&!rotating&&!resizing&&!desktopPanRef.current) return;
    const handleMove=(e)=>onMM(e);
    const handleUp=()=>onMU();
    window.addEventListener("mousemove",handleMove);
    window.addEventListener("mouseup",handleUp);
    return()=>{window.removeEventListener("mousemove",handleMove);window.removeEventListener("mouseup",handleUp);};
  },[dragging,rotating,resizing]);
  // Edge-scroll: auto-scroll when cursor hits the wrapper's visible edge during drag
  useEffect(()=>{
    const wrap=canvasWrapRef.current;if(!wrap) return;
    if(!dragging&&!rotating&&!resizing) return;
    const edgePx=20;
    const scrollSpeed=6;
    let rafId=null;
    const tick=()=>{
      const mx=mousePos.current?.x??0, my=mousePos.current?.y??0;
      const rect=wrap.getBoundingClientRect();
      let dx=0,dy=0;
      if(mx<=rect.left+edgePx) dx=-scrollSpeed;
      else if(mx>=rect.right-edgePx) dx=scrollSpeed;
      if(my<=rect.top+edgePx) dy=-scrollSpeed;
      else if(my>=rect.bottom-edgePx) dy=scrollSpeed;
      if(dx||dy){wrap.scrollLeft+=dx;wrap.scrollTop+=dy;}
      rafId=requestAnimationFrame(tick);
    };
    rafId=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(rafId);};
  },[dragging,rotating,resizing]);
  // Right-click on canvas (desktop context menu)
  const onCtx=e=>{
    e.preventDefault();
    const{x,y}=toIn(e.clientX,e.clientY);
    const p=hitTest(x,y);
    if(p){setSelected(p.id);setCtxMenu({x:e.clientX,y:e.clientY});}
    else if(clipboardRef.current&&clipboardRef.current.placements.length){setCtxMenu({x:e.clientX,y:e.clientY,canvasOnly:true});}
  };

  // ── Touch events (mobile) ──
  const onTouchStart=e=>{
    if(e.touches.length===2){
      // Pinch start
      const t=e.touches;
      pinchRef.current={dist:Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY),zoom};
      return;
    }
    const t=e.touches[0];
    const{x,y}=toIn(t.clientX,t.clientY);
    // Long press for context menu
    longPressTimer.current=setTimeout(()=>{
      const p=hitTest(x,y);
      if(p){setSelected(p.id);setCtxMenu({x:t.clientX,y:t.clientY});}
    },500);
    // Drag start
    const p=hitTest(x,y);
    if(p){setSelected(p.id);isDraggingCanvas.current=true;setDragging({id:p.id,startX:x,startY:y,origX:p.x,origY:p.y});}
    else{
      setSelected(null);
      panRef.current={startX:t.clientX,startY:t.clientY,panX,panY};
    }
  };
  const onTouchMove=e=>{
    clearTimeout(longPressTimer.current);
    if(e.touches.length===2&&pinchRef.current){
      const t=e.touches;
      const dist=Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
      const newZoom=Math.max(0.25,Math.min(50,pinchRef.current.zoom*(dist/pinchRef.current.dist)));
      setZoom(newZoom); return;
    }
    if(e.touches.length!==1) return;
    const t=e.touches[0];
    if(dragging){
      const{x,y}=toIn(t.clientX,t.clientY);
      const dx=x-dragging.startX,dy=y-dragging.startY;
      updActive(s=>({placements:s.placements.map(p=>p.id!==dragging.id?p:{...p,x:snap(dragging.origX+dx),y:snap(dragging.origY+dy)})}));
    } else if(panRef.current){
      // Pan canvas when not dragging an item
    }
  };
  const onTouchEnd=()=>{clearTimeout(longPressTimer.current);isDraggingCanvas.current=false;setDragging(null);pinchRef.current=null;panRef.current=null;};

  // ── Export ──
  // Preload all placement images so they're cached for tile rendering
  const preloadImages=async(placements,onProgress)=>{
    const cache=new Map();
    for(let i=0;i<placements.length;i++){
      if(exportCancelRef.current) throw new Error("Cancelled");
      onProgress(i,placements.length);
      const p=placements[i];
      if(cache.has(p.src)) continue;
      await new Promise(res=>{
        const img=new Image();img.crossOrigin="anonymous";
        img.onload=()=>{cache.set(p.src,img);res();};
        img.onerror=()=>{cache.set(p.src,null);res();};
        img.src=p.src;
      });
      if(i%5===4) await new Promise(r=>setTimeout(r,0));
    }
    return cache;
  };

  // Draw relevant placements onto a tile canvas at the given region
  const drawTile=(cache,placements,dpi,tileX,tileY,tileW,tileH,bg,mirror=false,cutOpts=null)=>{
    const c=document.createElement("canvas");c.width=tileW;c.height=tileH;
    const ctx=c.getContext("2d");
    if(!ctx) return null;
    if(bg){ctx.fillStyle=bg;ctx.fillRect(0,0,tileW,tileH);}
    if(mirror){ctx.translate(tileW,0);ctx.scale(-1,1);}
    for(let pi=placements.length-1;pi>=0;pi--){
      const p=placements[pi];
      if(p.visible===false) continue;
      const img=cache.get(p.src);if(!img) continue;
      const px2=ipx(p.x,dpi),py2=ipx(p.y,dpi),pw2=ipx(p.w,dpi),ph2=ipx(p.h,dpi);
      const right=px2+pw2,bottom=py2+ph2;
      if(right<tileX||px2>tileX+tileW||bottom<tileY||py2>tileY+tileH) continue;
      ctx.save();
      ctx.translate(px2-tileX+pw2/2,py2-tileY+ph2/2);
      if(p.rotation)ctx.rotate((p.rotation*Math.PI)/180);
      if(p.flipH)ctx.scale(-1,1);if(p.flipV)ctx.scale(1,-1);
      ctx.drawImage(img,-pw2/2,-ph2/2,pw2,ph2);
      if(p.cutEnabled&&p.cutShape&&p.cutShape!=="none"){
        if(p.cutShape==="die-cut"){
          const osPx=ipx(p.cutOffset||0,dpi);
          const dc=buildDieCutCanvas(img,pw2,ph2,osPx,p.cutColor,p.cutWidth||1);
          if(dc){const sx=pw2/dc.cw,sy=ph2/dc.ch;ctx.drawImage(dc.canvas,-dc.pad*sx-pw2/2,-dc.pad*sy-ph2/2,dc.tw*sx,dc.th*sy);}
        } else {
          const osPx=ipx(p.cutOffset||0,dpi),rPx=ipx(p.cutRadius||0,dpi);
          const contour=getCutContour(p.src,p.cutShape,pw2,ph2,osPx,rPx);
          if(contour){ctx.strokeStyle=p.cutColor||"#FF0000";ctx.lineWidth=p.cutWidth||1;ctx.stroke(contour);}
        }
      }
      ctx.restore();
    }
    return c;
  };

  const canvasToBlob=(canvas,mime,qual)=>new Promise(res=>canvas.toBlob(b=>res(b),mime,qual));

  const exportFolderRef=useRef(null);
  const downloadBlob=(blob,fname)=>{
    if(exportFolderRef.current) return saveFileToFolder(blob,exportFolderRef.current,fname);
    return saveFileWithDialog(blob,fname);
  };

  // ── Manual PNG encoder for large images (bypasses canvas size limits) ──
  const crc32Table=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c;}return t;})();
  const crc32=(buf,start=0,len)=>{let c=0xFFFFFFFF;const end=start+(len??buf.length-start);for(let i=start;i<end;i++)c=crc32Table[(c^buf[i])&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;};
  const pngChunk=(type,data)=>{
    const len=data.length;
    const buf=new Uint8Array(len+12);
    const dv=new DataView(buf.buffer);
    dv.setUint32(0,len);
    buf[4]=type.charCodeAt(0);buf[5]=type.charCodeAt(1);buf[6]=type.charCodeAt(2);buf[7]=type.charCodeAt(3);
    buf.set(data,8);
    dv.setUint32(len+8,crc32(buf,4,len+4));
    return buf;
  };

  const buildPngFromStrips=async(fullW,fullH,cache,placements,dpi,bg,onProgress,cutOpts=null)=>{
    // PNG signature
    const sig=new Uint8Array([137,80,78,71,13,10,26,10]);
    // IHDR
    const ihdr=new Uint8Array(13);const ihdrDv=new DataView(ihdr.buffer);
    ihdrDv.setUint32(0,fullW);ihdrDv.setUint32(4,fullH);
    ihdr[8]=8;ihdr[9]=bg?2:6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0; // 8-bit, RGB or RGBA
    const channels=bg?3:4;
    const ihdrChunk=pngChunk("IHDR",ihdr);

    // Build IDAT data strip-by-strip using DeflateStream
    const MAX_DIM=16384;const MAX_AREA=100_000_000;
    const stripH=Math.min(MAX_DIM,Math.max(1,Math.floor(MAX_AREA/fullW)));
    const numStrips=Math.ceil(fullH/stripH);
    // Collect all raw row data, deflate in chunks
    const ds=new CompressionStream("deflate");
    const writer=ds.writable.getWriter();
    const reader=ds.readable.getReader();
    // Collect compressed chunks
    const compressedParts=[];
    const readerDone=(async()=>{while(true){const{value,done}=await reader.read();if(done)break;compressedParts.push(value);}})();

    for(let s=0;s<numStrips;s++){
      if(exportCancelRef.current) throw new Error("Cancelled");
      const tileY=s*stripH;
      const tileH=Math.min(stripH,fullH-tileY);
      onProgress(s,numStrips,"Rendering");
      const tile=drawTile(cache,placements,dpi,0,tileY,fullW,tileH,bg,false,cutOpts);
      if(!tile) throw new Error("Tile render failed — out of memory");
      const ctx=tile.getContext("2d");
      const imgData=ctx.getImageData(0,0,fullW,tileH);
      // Build filtered rows (filter byte 0 = None for each row)
      const rowBytes=fullW*channels+1;
      const stripBuf=new Uint8Array(rowBytes*tileH);
      for(let y=0;y<tileH;y++){
        stripBuf[y*rowBytes]=0; // filter: None
        const srcOff=y*fullW*4;
        const dstOff=y*rowBytes+1;
        if(channels===4){
          stripBuf.set(imgData.data.subarray(srcOff,srcOff+fullW*4),dstOff);
        } else {
          for(let x=0;x<fullW;x++){
            stripBuf[dstOff+x*3]=imgData.data[srcOff+x*4];
            stripBuf[dstOff+x*3+1]=imgData.data[srcOff+x*4+1];
            stripBuf[dstOff+x*3+2]=imgData.data[srcOff+x*4+2];
          }
        }
      }
      await writer.write(stripBuf);
      // free tile memory
      tile.width=0;tile.height=0;
      onProgress(s+1,numStrips,"Compressing");
      await new Promise(r=>setTimeout(r,0));
    }
    await writer.close();
    await readerDone;

    // Combine compressed data into IDAT chunks (max 2MB each to stay safe)
    const CHUNK_MAX=2*1024*1024;
    const idatChunks=[];
    let buf=new Uint8Array(0);
    for(const part of compressedParts){
      const merged=new Uint8Array(buf.length+part.length);merged.set(buf);merged.set(part,buf.length);buf=merged;
      while(buf.length>=CHUNK_MAX){
        idatChunks.push(pngChunk("IDAT",buf.slice(0,CHUNK_MAX)));
        buf=buf.slice(CHUNK_MAX);
      }
    }
    if(buf.length>0) idatChunks.push(pngChunk("IDAT",buf));

    const iendChunk=pngChunk("IEND",new Uint8Array(0));
    // Assemble final PNG
    let totalLen=sig.length+ihdrChunk.length+iendChunk.length;
    for(const c of idatChunks) totalLen+=c.length;
    const png=new Uint8Array(totalLen);
    let off=0;
    png.set(sig,off);off+=sig.length;
    png.set(ihdrChunk,off);off+=ihdrChunk.length;
    for(const c of idatChunks){png.set(c,off);off+=c.length;}
    png.set(iendChunk,off);
    return new Blob([png],{type:"image/png"});
  };

  // Build a minimal PDF with an embedded JPEG image
  const buildPdf=async(jpegBlob,widthPt,heightPt)=>{
    const imgBytes=new Uint8Array(await jpegBlob.arrayBuffer());
    const enc=new TextEncoder();
    const parts=[];let offset=0;
    const add=(s)=>{const b=typeof s==="string"?enc.encode(s):s;parts.push(b);offset+=b.length;return offset-b.length;};
    const xref=[];
    add("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
    // Object 1: Catalog
    xref.push(offset);add("1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n");
    // Object 2: Pages
    xref.push(offset);add(`2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n`);
    // Object 3: Page
    xref.push(offset);add(`3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}]/Contents 4 0 R/Resources<</XObject<</Img 5 0 R>>>>>>\nendobj\n`);
    // Object 4: Content stream (draw image full page)
    const stream=`q ${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} 0 0 cm /Img Do Q`;
    xref.push(offset);add(`4 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`);
    // Object 5: Image XObject (JPEG)
    xref.push(offset);add(`5 0 obj\n<</Type/XObject/Subtype/Image/Width ${Math.round(widthPt*96/72)}/Height ${Math.round(heightPt*96/72)}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${imgBytes.length}>>\nstream\n`);
    add(imgBytes);
    add("\nendstream\nendobj\n");
    // Xref table
    const xrefOff=offset;
    add(`xref\n0 ${xref.length+1}\n0000000000 65535 f \n`);
    for(const x of xref) add(`${String(x).padStart(10,"0")} 00000 n \n`);
    add(`trailer\n<</Size ${xref.length+1}/Root 1 0 R>>\nstartxref\n${xrefOff}\n%%EOF\n`);
    return new Blob(parts,{type:"application/pdf"});
  };

  const exportSheet=async(sheet,sheetIdx=0,totalSheets=1)=>{
    const fullW=ipx(sheet.sheetW,sheet.sheetDPI),fullH=ipx(sheet.sheetH,sheet.sheetDPI);
    const isPdf=exportFormat==="pdf";
    const mimeType=isPdf?"image/jpeg":exportFormat==="jpeg"?"image/jpeg":exportFormat==="webp"?"image/webp":"image/png";
    const quality=exportFormat==="png"?undefined:isPdf?0.92:exportQuality;
    const ext=isPdf?"pdf":exportFormat==="jpeg"?"jpg":exportFormat;
    const bg=exportFormat==="jpeg"||isPdf?"#ffffff":null;
    const baseName=totalSheets>1?`${sheetIdx+1}of${totalSheets}-${sheet.label.replace(/\s+/g,"-")}-${sheet.sheetW}x${sheet.sheetH}-${sheet.sheetDPI}dpi`:`${sheet.label.replace(/\s+/g,"-")}-${sheet.sheetW}x${sheet.sheetH}-${sheet.sheetDPI}dpi`;
    const pctFn=(pct)=>totalSheets>1?Math.round(((sheetIdx+pct/100)/totalSheets)*100):pct;

    // Phase 1: preload images
    setExportProgress(`[${sheet.label}] Loading images…`);
    const cache=await preloadImages(sheet.placements,(i,t)=>{
      setExportPct(pctFn(Math.round((i/t)*20)));
      setExportProgress(`[${sheet.label}] Loading ${i+1}/${t}`);
    });

    // Phase 2: try single-canvas export first (fast path)
    const MAX_DIM=16384;const MAX_AREA=124_000_000;
    const needsTiling=fullW>MAX_DIM||fullH>MAX_DIM||fullW*fullH>MAX_AREA;

    const cutOpts=sheet.cutEnabled?{enabled:true,shape:sheet.cutShape,offset:sheet.cutOffset,width:sheet.cutWidth,color:sheet.cutColor,radius:sheet.cutRadius}:null;

    if(!needsTiling){
      setExportProgress(`[${sheet.label}] Rendering…`);setExportPct(pctFn(25));
      const tile=drawTile(cache,sheet.placements,sheet.sheetDPI,0,0,fullW,fullH,bg,sheet.mirrorExport,cutOpts);
      if(!tile) throw new Error("Could not create canvas — try closing other tabs");
      setExportProgress(`[${sheet.label}] Encoding ${exportFormat.toUpperCase()}…`);setExportPct(pctFn(80));
      await new Promise(r=>setTimeout(r,50));
      const imgBlob=await canvasToBlob(tile,mimeType,quality);
      if(!imgBlob) throw new Error("Encoding failed — try JPEG format");
      if(isPdf){
        const widthPt=sheet.sheetW*72,heightPt=sheet.sheetH*72;
        const pdfBlob=await buildPdf(imgBlob,widthPt,heightPt);
        downloadBlob(pdfBlob,`${baseName}.pdf`);
      } else {
        downloadBlob(imgBlob,`${baseName}.${ext}`);
      }
      setExportPct(pctFn(100));
      return;
    }

    // Phase 3: tiled export — single file output
    setExportProgress(`[${sheet.label}] Large image — tiled encoding…`);setExportPct(pctFn(22));

    if(exportFormat==="png"){
      // Use manual PNG encoder that works strip-by-strip
      const blob=await buildPngFromStrips(fullW,fullH,cache,sheet.placements,sheet.sheetDPI,bg,(done,total,phase)=>{
        setExportPct(pctFn(22+Math.round((done/total)*70)));
        setExportProgress(`[${sheet.label}] ${phase} strip ${done}/${total}…`);
      },cutOpts);
      downloadBlob(blob,`${baseName}.png`);
    } else {
      // For JPEG/WebP: render strips, draw each onto a shared BMP buffer, then re-encode
      // Strategy: render into vertical strips small enough to fit canvas limits,
      // draw each strip onto a tall-but-narrow final canvas
      // Actually: for JPEG we can use a wider approach — render the full width but limited height strips,
      // paste each strip onto a final canvas that we build row-by-row as BMP, then convert
      // Simplest: use the PNG path and convert in-browser
      const pngBlob=await buildPngFromStrips(fullW,fullH,cache,sheet.placements,sheet.sheetDPI,"#ffffff",(done,total,phase)=>{
        setExportPct(pctFn(22+Math.round((done/total)*60)));
        setExportProgress(`[${sheet.label}] ${phase} strip ${done}/${total}…`);
      },cutOpts);
      // Convert PNG blob to JPEG/WebP via createImageBitmap + small-tile re-encode
      // For large images this may not work either, so just download as PNG with a note
      setExportProgress(`[${sheet.label}] Image exceeds canvas limits — exporting as PNG instead`);
      downloadBlob(pngBlob,`${baseName}.png`);
    }
    setExportPct(pctFn(100));
  };
  const cancelExport=()=>{exportCancelRef.current=true;};
  const doExport=async(all=false)=>{
    exportCancelRef.current=false;
    exportFolderRef.current=null;
    setShowExportDialog(false);setExporting(true);setExportAllMode(all);setExportPct(0);
    await new Promise(r=>setTimeout(r,50));
    try{
      if(all){
        const valid=sheets.filter(s=>s.placements.length>0);
        // On desktop with multiple sheets, pick a folder once instead of per-file dialogs
        if(isDesktop&&valid.length>1){
          const folder=await pickExportFolder();
          if(!folder){setExporting(false);return;}
          exportFolderRef.current=folder;
        }
        for(let si=0;si<valid.length;si++){await exportSheet(valid[si],si,valid.length);await new Promise(r=>setTimeout(r,400));}
        exportFolderRef.current=null;
      }else{
        await exportSheet(active);
      }
      // brief pause at 100% so user sees completion
      setExportProgress("Done!");setExportPct(100);
      await new Promise(r=>setTimeout(r,600));
    }catch(err){
      if(err.message==="Cancelled"){setExportProgress("Export cancelled");await new Promise(r=>setTimeout(r,800));}
      else{console.error("Export error:",err);setExportProgress(`Error: ${err.message}`);await new Promise(r=>setTimeout(r,2000));}
    }finally{
      setExporting(false);setExportProgress("");setExportPct(0);
    }
  };

  const startExport=(all=false)=>{
    if(isWeb){
      pendingExportRef.current=all;
      setShowExportDialog(false);
      setShowExportAd(true);
    } else {
      doExport(all);
    }
  };
  const onExportAdDone=useCallback(()=>{
    setShowExportAd(false);
    doExport(pendingExportRef.current||false);
  },[]);

  // ── CSV ──
  const csvText=()=>{
    const rows=[["Sheet","Design","Notes","Qty","W","H","Rot","Flip","EffDPI","Status","X","Y"]];
    sheets.forEach(s=>s.groups.forEach(g=>{const gp=s.placements.filter(p=>p.groupId===g.id);const{effDpi,warn,caution}=g.naturalW?nativeRes(g.naturalW,g.naturalH,g.w,g.h,s.sheetDPI):{effDpi:0,warn:false,caution:false};gp.forEach((p,pi)=>rows.push([s.label,g.name,g.notes||"",pi===0?gp.length:"",g.w.toFixed(3),g.h.toFixed(3),p.rotation||0,p.flipH?"H":p.flipV?"V":"—",Math.round(effDpi),warn?"LOW":caution?"CAUTION":"OK",p.x.toFixed(3),p.y.toFixed(3)]));})  );
    return rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
  };
  const downloadCSV=()=>{const b=new Blob([csvText()],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`gang-sheet-${Date.now()}.csv`;a.click();};

  // ── Save/load ──
  const saveProject=async()=>{
    const name=saveName.trim();if(!name){setSaveStatus("⚠ Enter a name.");return;}
    setSaveStatus("Saving…");
    try{
      const s=active;
      const allSrcs=[...new Set(s.placements.map(p=>p.src))];
      const sm={};for(const src of allSrcs){if(src.startsWith("data:"))sm[src]=src;else sm[src]=await toDataURL(src);}
      const wrap=canvasWrapRef.current;
      const ser={...s,zoom,scrollX:wrap?.scrollLeft||0,scrollY:wrap?.scrollTop||0,placements:s.placements.map(p=>({...p,src:sm[p.src]||p.src})),groups:s.groups.map(g=>({...g,src:sm[g.src]||g.src})),uploadedImg:s.uploadedImg?{...s.uploadedImg,src:sm[s.uploadedImg.src]||s.uploadedImg.src}:null};
      const blob=new Blob([JSON.stringify({version:1,sheet:ser,savedAt:new Date().toISOString()})],{type:"application/json"});
      await saveFileWithDialog(blob,`${name}.gangowl`);
      setSaveStatus(`✓ Exported "${name}.gangowl"`);
    }catch(err){setSaveStatus(`✗ Failed — ${err.message}`);}
  };
  const loadProject=saveObj=>{
    const loaded=(saveObj.sheets||[]).map(s=>({...SHEET_DEFAULTS,...s}));
    loaded.forEach(s=>[...new Set(s.placements.map(p=>p.src))].forEach(src=>cachedImg(src)));
    const ids=loaded.flatMap(s=>[...s.placements.map(p=>p.id),...s.groups.map(g=>g.id),s.id]);
    if(ids.length)_id=Math.max(...ids)+1;
    setSheets(loaded);setActiveId(loaded[0]?.id);setSelected(null);
    setSaveStatus(`✓ Loaded "${saveObj.name}"`);setShowSave(false);setLeftTab("sheet");setDrawer(null);
  };
  const deleteSave=async(name,e)=>{e.stopPropagation();const c=await sGet(STORAGE_KEY)||{};delete c[name];await sSet(STORAGE_KEY,c);setSaves(c);};
  const savePreset=async()=>{const name=presetName.trim();if(!name)return;const p={name,sheetW,sheetH,sheetDPI,margin,gap,inkCostPerSqIn};const next=[...presets.filter(x=>x.name!==name),p];setPresets(next);await sSet(PRESETS_KEY,next);setPresetName("");setShowPresets(false);};
  const loadPreset=p=>{updActive({sheetW:p.sheetW,sheetH:p.sheetH,sheetDPI:p.sheetDPI,margin:p.margin||0,gap:p.gap||0.25,inkCostPerSqIn:p.inkCostPerSqIn||0});setShowPresets(false);};
  const deletePreset=async(name,e)=>{e.stopPropagation();const next=presets.filter(p=>p.name!==name);setPresets(next);await sSet(PRESETS_KEY,next);};

  // ── Styles ──
  const touchTarget = isMobile ? 44 : 32;
  const fontSize    = isMobile ? 14 : 12;

  const S = {
    app:{display:"flex",height:"100dvh",background:C.bg,color:C.text,fontFamily:"'DM Mono','Courier New',monospace",overflow:"hidden",flexDirection:"column",WebkitTapHighlightColor:"transparent"},
    topRow:{display:"flex",flex:1,overflow:"hidden"},
    left:{width:isMobile?0:Math.round((isTablet?260:296)*uiScale),zoom:uiScale,background:C.surface,borderRight:`1px solid ${C.border}`,display:isMobile?"none":"flex",flexDirection:"column",overflow:"hidden",flexShrink:0},
    right:{width:isMobile?0:Math.round((isTablet?220:252)*uiScale),zoom:uiScale,background:C.surface,borderLeft:`1px solid ${C.border}`,display:isMobile?"none":"flex",flexDirection:"column",overflow:"hidden",flexShrink:0},
    main:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0},
    logo:{padding:isMobile?"10px 12px 8px":"13px 13px 10px",borderBottom:`1px solid ${C.border}`,fontSize:isMobile?14:13,fontWeight:700,letterSpacing:"0.13em",color:C.accent,display:"flex",alignItems:"center",gap:6,flexShrink:0},
    panelHead:{padding:"9px 12px 8px",fontSize:11,letterSpacing:"0.1em",color:C.muted,textTransform:"uppercase",borderBottom:`1px solid ${C.border}`,flexShrink:0},
    ltabs:{display:"flex",borderBottom:`1px solid ${C.border}`,flexShrink:0},
    ltab:a=>({flex:1,padding:`${isMobile?10:8}px 0`,fontSize:isMobile?12:11,letterSpacing:"0.08em",textTransform:"uppercase",border:"none",cursor:"pointer",background:a?C.selected:"transparent",color:a?C.accent:C.muted,borderBottom:a?`2px solid ${C.accentSolid}`:"2px solid transparent"}),
    panel:{padding:isMobile?"14px":"12px",display:"flex",flexDirection:"column",gap:isMobile?12:10,overflowY:"auto",flex:1},
    label:{fontSize:isMobile?12:10,letterSpacing:"0.08em",color:C.muted,textTransform:"uppercase",marginBottom:2},
    input:{background:C.bg,border:`1px solid ${C.border}`,borderRadius:4,color:C.text,padding:isMobile?"9px 10px":"6px 7px",fontSize:isMobile?14:12,width:"100%",outline:"none"},
    row:{display:"flex",gap:isMobile?8:5},
    btn:(v="d")=>({minHeight:touchTarget,padding:isMobile?"0 16px":"6px 12px",borderRadius:6,border:v==="ghost"?`1px solid ${C.border}`:"none",cursor:"pointer",fontSize:isMobile?13:11,letterSpacing:"0.06em",textTransform:"uppercase",fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",background:v==="primary"?C.accentSolid:v==="success"?C.green:v==="warning"?C.amber:v==="danger"?C.red:v==="ghost"?"transparent":C.surface2,color:v==="warning"||v==="success"?C.bg:C.text}),
    uploadZone:{border:`2px dashed ${C.surface2}`,borderRadius:8,padding:isMobile?"24px 14px":"15px 10px",textAlign:"center",cursor:"pointer",background:C.bg},
    lockBtn:a=>({flex:1,padding:isMobile?"9px 4px":"5px 2px",fontSize:isMobile?11:9,letterSpacing:"0.06em",textTransform:"uppercase",border:`1px solid ${a?C.accentSolid:C.border}`,borderRadius:5,cursor:"pointer",background:a?C.selected:"transparent",color:a?C.accent:C.muted}),
    toolbar:{padding:isMobile?"6px 10px":"7px 11px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:5,background:C.surface,flexShrink:0,flexWrap:"wrap",zoom:uiScale},
    canvasWrap:{flex:1,overflow:"scroll",background:C.canvasBg,WebkitOverflowScrolling:"touch"},
    statusBar:{padding:"5px 12px",background:C.surface,borderTop:`1px solid ${C.border}`,fontSize:10,color:C.muted,display:"flex",gap:10,flexShrink:0,flexWrap:"wrap",alignItems:"center",zoom:uiScale},
    divider:{borderTop:`1px solid ${C.border}`,paddingTop:isMobile?10:8,marginTop:2},
    warn:{padding:"8px 10px",background:C.warnBg,border:`1px solid ${C.warnBorder}`,borderRadius:5,fontSize:isMobile?12:10,color:C.amber,lineHeight:1.5},
    ok:{padding:"8px 10px",background:C.okBg,border:`1px solid ${C.okBorder}`,borderRadius:5,fontSize:isMobile?12:10,color:C.greenBright,lineHeight:1.5},
    grpRow:(hov,sel)=>({display:"flex",alignItems:"center",gap:7,padding:"9px 10px",borderRadius:6,cursor:"pointer",marginBottom:4,background:sel?C.selected:hov?C.hover:"transparent",border:`1px solid ${sel?C.accentSolid:hov?C.surface2:"transparent"}`,borderBottom:`1px solid ${C.border}`}),
    dot:c=>({width:10,height:10,borderRadius:3,background:c,flexShrink:0}),
    copyRow:sel=>({padding:"6px 10px 6px 28px",borderRadius:4,cursor:"pointer",marginBottom:2,background:sel?C.selected:"transparent",border:`1px solid ${sel?C.amber:"transparent"}`,display:"flex",alignItems:"center",gap:5,borderBottom:`1px solid ${C.border}`}),
    modal:{position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:900},
    modalBox:{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,width:isMobile?"94vw":440,maxHeight:"86vh",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 20px 60px rgba(0,0,0,0.6)"},
    modalHead:{padding:"13px 15px 10px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"},
    slot:{padding:"10px 12px",borderRadius:6,cursor:"pointer",marginBottom:5,background:C.bg,border:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:7},
    toggle:on=>({width:30,height:17,borderRadius:9,background:on?C.accentSolid:C.surface2,position:"relative",cursor:"pointer",flexShrink:0,transition:"background 0.2s"}),
    toggleKnob:on=>({position:"absolute",top:2.5,left:on?14:3,width:12,height:12,borderRadius:"50%",background:"#fff",transition:"left 0.15s"}),
    overlay:{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,flexDirection:"column",gap:12},
    spinner:{width:32,height:32,border:`3px solid ${C.border}`,borderTop:`3px solid ${C.accentSolid}`,borderRadius:"50%",animation:"spin 0.7s linear infinite"},
    utilBar:pct=>({height:5,borderRadius:3,background:pct>90?C.red:pct>70?C.amber:C.green,width:`${pct}%`,transition:"width 0.3s"}),
    sheetTabBar:{display:"flex",alignItems:"center",background:C.surface,borderBottom:`1px solid ${C.border}`,flexShrink:0,overflowX:"auto",gap:0,zoom:uiScale},
    sheetTab:act=>({display:"flex",alignItems:"center",gap:5,padding:"8px 12px 8px 13px",fontSize:11,cursor:"pointer",whiteSpace:"nowrap",borderRight:`1px solid ${C.border}`,background:act?C.surface:"transparent",color:act?C.text:C.muted,borderBottom:act?`3px solid ${C.accentSolid}`:"3px solid transparent",fontWeight:act?700:400,flexShrink:0,opacity:act?1:0.6}),
    addTabBtn:{padding:"0 12px",fontSize:18,color:C.muted,cursor:"pointer",background:"transparent",border:"none",display:"flex",alignItems:"center",alignSelf:"stretch",flexShrink:0},
    // Mobile bottom nav
    mobileNav:{display:"flex",background:C.surface,borderTop:`1px solid ${C.border}`,flexShrink:0,zIndex:100},
    mobileNavBtn:(active)=>({flex:1,padding:"10px 4px 12px",display:"flex",flexDirection:"column",alignItems:"center",gap:2,cursor:"pointer",background:"transparent",border:"none",color:active?C.accent:C.muted,fontSize:9,letterSpacing:"0.07em",textTransform:"uppercase",borderTop:active?`2px solid ${C.accentSolid}`:"2px solid transparent"}),
  };

  const Toggle=({on,onClick})=><div style={S.toggle(on)} onClick={onClick}><div style={S.toggleKnob(on)}/></div>;

  // ── Shared panel content (used in both sidebar and drawers) ──
  const sheetPanelJsx=(
    <div style={S.panel}>
      <div><div style={S.label}>Width (in)</div>
        {isMobile?<Stepper value={sheetW} onChange={v=>updActive({sheetW:parseFloat(v)||22})} min={1} step={0.5}/>:<input style={S.input} type="number" min="1" step="0.5" value={sheetW} onChange={e=>updActive({sheetW:parseFloat(e.target.value)||22})}/>}
      </div>
      <div><div style={S.label}>Height (in)</div>
        {isMobile?<Stepper value={sheetH} onChange={v=>updActive({sheetH:parseFloat(v)||200})} min={1} step={1}/>:<input style={S.input} type="number" min="1" step="1" value={sheetH} onChange={e=>updActive({sheetH:parseFloat(e.target.value)||200})}/>}
      </div>
      <div><div style={S.label}>Print DPI</div>
        <select style={S.input} value={sheetDPI} onChange={e=>updActive({sheetDPI:parseInt(e.target.value)})}>
          <option value={150}>150 dpi</option><option value={300}>300 dpi — standard DTF</option>
          <option value={600}>600 dpi</option><option value={1200}>1200 dpi</option>
        </select>
      </div>
      <div style={S.divider}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <div style={S.label}>Sheet Margin</div><Toggle on={margin>0} onClick={()=>updActive({margin:margin>0?0:0.25})}/>
        </div>
        {margin>0&&<>
          {isMobile?<Stepper value={margin} onChange={v=>updActive({margin:parseFloat(v)||0})} min={0} step={0.05}/>:<input style={S.input} type="number" min="0" step="0.05" value={margin} onChange={e=>updActive({margin:parseFloat(e.target.value)||0})}/>}
          <div style={{fontSize:9,color:C.muted,marginTop:3}}>Usable: {(sheetW-margin*2).toFixed(2)}"×{(sheetH-margin*2).toFixed(2)}"</div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6}}><Toggle on={showMargin} onClick={()=>updActive({showMargin:!showMargin})}/><span style={{fontSize:9,color:C.muted}}>Show guide</span></div>
        </>}
      </div>
      <div style={S.divider}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
          <div style={S.label}>Grid</div><Toggle on={showGrid} onClick={()=>updActive({showGrid:!showGrid})}/>
        </div>
        <div style={{display:"flex",gap:4,marginBottom:5}}>
          <select style={{...S.input,flex:1}} value={gridSize} onChange={e=>updActive({gridSize:parseFloat(e.target.value)})}>
            <option value={0.125}>⅛"</option><option value={0.25}>¼"</option><option value={0.5}>½"</option><option value={1}>1"</option><option value={2}>2"</option><option value={5}>5"</option>
          </select>
          <select style={{...S.input,flex:1}} value={gridStyle} onChange={e=>updActive({gridStyle:e.target.value})}>
            <option value="lines">Lines</option><option value="dashed">Dashed</option><option value="dots">Dots</option>
          </select>
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5,marginTop:8}}>
          <div style={S.label}>Snap</div><Toggle on={snapToGrid} onClick={()=>updActive({snapToGrid:!snapToGrid})}/>
        </div>
        <select style={S.input} value={snapSize} onChange={e=>updActive({snapSize:parseFloat(e.target.value)})}>
          <option value={0.0625}>1/16"</option><option value={0.125}>⅛"</option><option value={0.25}>¼"</option><option value={0.5}>½"</option><option value={1}>1"</option>
        </select>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:8}}>
          <div style={S.label}>Smart Guides</div><Toggle on={snapToItems} onClick={()=>updActive({snapToItems:!snapToItems})}/>
        </div>
        <div style={{marginTop:8}}>
          <div style={S.label}>Canvas Background</div>
          <div style={{display:"flex",gap:4,marginTop:4}}>
            {[{v:"checker",label:"▦"},{v:"#ffffff",label:"W"},{v:"#000000",label:"B"},{v:"#808080",label:"G"}].map(o=>(
              <button key={o.v} style={{flex:1,padding:"5px 0",borderRadius:4,border:`1px solid ${canvasBg===o.v?C.accentSolid:C.border}`,background:canvasBg===o.v?C.selected:"transparent",color:canvasBg===o.v?C.accent:C.muted,cursor:"pointer",fontSize:10,fontWeight:700}} onClick={()=>updActive({canvasBg:o.v})}>{o.label}</button>
            ))}
            <input type="color" value={canvasBg==="checker"?"#cbcbcb":canvasBg} onChange={e=>updActive({canvasBg:e.target.value})} style={{width:28,height:28,border:`1px solid ${C.border}`,borderRadius:4,padding:0,cursor:"pointer",background:"transparent"}} title="Custom color"/>
          </div>
        </div>
      </div>
      <div style={S.divider}><div style={S.label}>Ink Cost / sq in ($)</div>
        <input style={S.input} type="number" min="0" step="0.001" value={inkCostPerSqIn} placeholder="0.00" onChange={e=>updActive({inkCostPerSqIn:parseFloat(e.target.value)||0})}/>
        {inkCostPerSqIn>0&&<div style={{fontSize:9,color:C.greenBright,marginTop:2}}>Est: ${estCost} · {placedSqIn.toFixed(1)} sq in</div>}
      </div>
      <div style={S.divider}><div style={S.label}>Output</div>
        <div style={{fontSize:isMobile?12:11,color:C.accent,lineHeight:1.9}}>
          <div>{ipx(sheetW,sheetDPI).toLocaleString()}×{ipx(sheetH,sheetDPI).toLocaleString()} px</div>
          <div style={{color:C.muted}}>≈{((ipx(sheetW,sheetDPI)*ipx(sheetH,sheetDPI)*4)/1024/1024).toFixed(0)} MB</div>
        </div>
      </div>
      {placements.length>0&&<div style={S.divider}><button style={{...S.btn("danger"),width:"100%"}} onClick={()=>{updActive({placements:[],groups:[]});setSelected(null);}}>Clear This Sheet</button></div>}
    </div>
  );

  const addImagePanelJsx=(
    <div style={S.panel}>
      <div style={S.uploadZone} onClick={()=>fileInputRef.current.click()}>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={onFile}/>
        {uploadedImg?(<>
          <img src={uploadedImg.src} alt="" style={{maxWidth:"100%",maxHeight:isMobile?120:80,objectFit:"contain",borderRadius:4,marginBottom:4,border:`1px solid ${C.border}`}}/>
          <div style={{fontSize:isMobile?13:12,color:C.accent,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{uploadedImg.name}</div>
          <div style={{fontSize:10,color:C.muted}}>{uploadedImg.naturalW}×{uploadedImg.naturalH}px · click to replace</div>
        </>):(<>
          <div style={{fontSize:isMobile?28:21,marginBottom:4}}>⬆️</div>
          <div style={{fontSize:isMobile?14:11,color:C.accent}}>{isMobile?"Tap to upload":"Upload Image"}</div>
          <div style={{fontSize:10,color:C.muted}}>PNG · JPG · WebP</div>
        </>)}
      </div>
      <div data-autotrim={autoTrimImport?'true':'false'} style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
        <span style={{fontSize:10,color:C.muted}}>Auto-trim on import</span>
        <Toggle on={autoTrimImport} onClick={()=>updActive({autoTrimImport:!autoTrimImport})}/>
      </div>
      {trimNotice&&<div style={{fontSize:9,color:C.accent,marginBottom:4,transition:"opacity 0.3s"}}>{trimNotice}</div>}
      {uploadedImg&&placeW&&placeH&&(()=>{const{effDpi,warn,caution}=nativeRes(uploadedImg.naturalW,uploadedImg.naturalH,parseFloat(placeW)||1,parseFloat(placeH)||1,sheetDPI);return warn?<div style={S.warn}>⚠ {Math.round(effDpi)}dpi — may blur</div>:caution?<div style={{...S.warn,borderColor:"#4a3000"}}>⚠ {Math.round(effDpi)}dpi (target {sheetDPI})</div>:<div style={S.ok}>✓ {Math.round(effDpi)}dpi — good</div>})()}
      <div><div style={S.label}>Aspect Lock</div>
        <div style={{display:"flex",gap:5}}>
          {["none","width","height"].map(s=><button key={s} style={{...S.lockBtn(lockSide===s),minHeight:touchTarget}} onClick={()=>handleLock(s)}>{s==="none"?"Free":s==="width"?"↔ W":"↕ H"}</button>)}
        </div>
      </div>
      <div style={S.row}>
        <div style={{flex:1}}><div style={S.label}>Width (in)</div>
          {isMobile?<Stepper value={placeW} onChange={handlePWChange} min={0.01} step={0.1} style={{opacity:lockSide==="height"?0.4:1}}/>:<input style={{...S.input,opacity:lockSide==="height"?0.4:1}} type="number" min="0.01" step="0.1" value={placeW} readOnly={lockSide==="height"} onChange={e=>handlePWChange(e.target.value)}/>}
        </div>
        <div style={{flex:1}}><div style={S.label}>Height (in)</div>
          {isMobile?<Stepper value={placeH} onChange={handlePHChange} min={0.01} step={0.1} style={{opacity:lockSide==="width"?0.4:1}}/>:<input style={{...S.input,opacity:lockSide==="width"?0.4:1}} type="number" min="0.01" step="0.1" value={placeH} readOnly={lockSide==="width"} onChange={e=>handlePHChange(e.target.value)}/>}
        </div>
      </div>
      <div style={S.row}>
        <div style={{flex:1}}><div style={S.label}>Copies</div>
          {isMobile?<Stepper value={copies} onChange={v=>updActive({copies:Math.max(1,parseInt(v)||1)})} min={1} step={1}/>:<input style={S.input} type="number" min="1" max="999" value={copies} onChange={e=>updActive({copies:parseInt(e.target.value)||1})}/>}
        </div>
        <div style={{flex:1}}><div style={S.label}>Gap (in)</div>
          {isMobile?<Stepper value={gap} onChange={v=>updActive({gap:parseFloat(v)||0})} min={0} step={0.05}/>:<input style={S.input} type="number" min="0" step="0.05" value={gap} onChange={e=>updActive({gap:parseFloat(e.target.value)||0})}/>}
        </div>
      </div>
      {uploadedImg&&placeW&&placeH&&copies>1&&(()=>{
        const iw=parseFloat(placeW)||1,ih=parseFloat(placeH)||1,g2=parseFloat(gap)||0;
        const uw=sheetW-(parseFloat(margin)||0)*2,uh=sheetH-(parseFloat(margin)||0)*2;
        const cols=Math.max(1,Math.floor(uw/(iw+g2))),rows=Math.max(1,Math.floor(uh/(ih+g2)));
        const perSheet=cols*rows;
        const totalCopies=parseInt(copies)||1;
        const sheetsNeeded=Math.ceil(totalCopies/perSheet);
        return <div style={{fontSize:9,color:C.muted,marginBottom:4}}>
          {autoDistribute?`~${perSheet}/sheet, ${sheetsNeeded} sheet${sheetsNeeded>1?"s":""} needed`:`~${perSheet} fit on this sheet`}
        </div>;
      })()}
      <div><div style={S.label}>Transform</div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          {[0,90,180,270].map(r=><button key={r} style={{...S.lockBtn(rotation===r),flex:"unset",minHeight:touchTarget,padding:"0 10px"}} onClick={()=>{updActive({rotation:r});if(selected)updActive(s=>({placements:s.placements.map(p=>{if(p.id!==selected)return p;const oldRot=p.rotation||0;const oldIs90=oldRot===90||oldRot===270,newIs90=r===90||r===270;const swap=oldIs90!==newIs90;return{...p,rotation:r,...(swap?{w:p.h,h:p.w,x:p.x+(p.w-p.h)/2,y:p.y+(p.h-p.w)/2}:{})};})}));}}>{r}°</button>)}
          <button style={{...S.lockBtn(flipH),flex:"unset",minHeight:touchTarget,padding:"0 10px"}} onClick={()=>{const nv=!flipH;updActive({flipH:nv});if(selected)updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,flipH:nv})}));}}>↔</button>
          <button style={{...S.lockBtn(flipV),flex:"unset",minHeight:touchTarget,padding:"0 10px"}} onClick={()=>{const nv=!flipV;updActive({flipV:nv});if(selected)updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,flipV:nv})}));}}>↕</button>
        </div>
      </div>
      <div><div style={S.label}>Order Notes</div>
        <textarea style={{...S.input,minHeight:isMobile?56:44,fontSize:isMobile?13:11}} placeholder="Customer, order #, size..." value={jobNotes} onChange={e=>updActive({jobNotes:e.target.value})}/>
      </div>
      {warning&&<div style={S.warn}>{warning}</div>}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4,marginTop:4}}>
        <span style={{fontSize:10,color:C.muted}}>Cut Lines</span>
        <Toggle on={cutEnabled} onClick={()=>{const nv=!cutEnabled;updActive({cutEnabled:nv});if(selected)updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,cutEnabled:nv,cutShape,cutOffset,cutWidth,cutColor,cutRadius})}));}}/>
      </div>
      {cutEnabled&&<div style={{marginBottom:6,display:"flex",flexDirection:"column",gap:5}}>
        <div style={{display:"flex",gap:3}}>
          {[["die-cut","Die-Cut"],["rounded-rect","Rounded"],["rectangle","Rect"],["circle","Circle"]].map(([v,l])=>(
            <button key={v} style={{flex:1,padding:"4px 0",borderRadius:4,border:`1px solid ${cutShape===v?C.accentSolid:C.border}`,background:cutShape===v?C.selected:"transparent",color:cutShape===v?C.accent:C.muted,cursor:"pointer",fontSize:8,fontWeight:700}} onClick={()=>{updActive({cutShape:v});if(selected)updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,cutShape:v})}));}}>{l}</button>
          ))}
        </div>
        <div style={S.row}>
          <div style={{flex:1}}><div style={S.label}>Offset (in)</div><input style={S.input} type="number" min="0" max="1" step="0.1" value={cutOffset} onChange={e=>{const v=parseFloat(e.target.value)||0;updActive({cutOffset:v});if(selected)updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,cutOffset:v})}));}}/></div>
          <div style={{flex:1}}><div style={S.label}>Width (px)</div><input style={S.input} type="number" min="0.5" max="10" step="0.5" value={cutWidth} onChange={e=>{const v=parseFloat(e.target.value)||1;updActive({cutWidth:v});if(selected)updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,cutWidth:v})}));}}/></div>
        </div>
        <div style={S.row}>
          <div style={{flex:1}}><div style={S.label}>Color</div><input type="color" value={cutColor} onChange={e=>{updActive({cutColor:e.target.value});if(selected)updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,cutColor:e.target.value})}));}} style={{width:"100%",height:28,border:`1px solid ${C.border}`,borderRadius:4,padding:0,cursor:"pointer",background:"transparent"}}/></div>
          {cutShape==="rounded-rect"&&<div style={{flex:1}}><div style={S.label}>Radius (in)</div><input style={S.input} type="number" min="0" max="2" step="0.05" value={cutRadius} onChange={e=>{const v=parseFloat(e.target.value)||0;updActive({cutRadius:v});if(selected)updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,cutRadius:v})}));}}/></div>}
        </div>
      </div>}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <span style={{fontSize:10,color:C.muted}}>Auto-rotate for best fit</span>
        <Toggle on={autoRotatePlace} onClick={()=>updActive({autoRotatePlace:!autoRotatePlace})}/>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <span style={{fontSize:10,color:C.muted}}>Auto-distribute across sheets</span>
        <Toggle on={autoDistribute} onClick={()=>updActive({autoDistribute:!autoDistribute})}/>
      </div>
      {/* Extra size variants */}
      {extraSizes.length>0&&<div style={{marginBottom:6}}>
        <div style={S.label}>Additional Sizes</div>
        {extraSizes.map((sz,i)=>{
          const ar=uploadedImg&&uploadedImg.naturalH>0?uploadedImg.naturalW/uploadedImg.naturalH:1;
          const updSz=(patch)=>updActive(s=>({extraSizes:s.extraSizes.map(s2=>s2.id===sz.id?{...s2,...patch}:s2)}));
          return <div key={sz.id} style={{display:"flex",gap:4,alignItems:"center",marginBottom:4}}>
            <span style={{fontSize:9,color:C.muted,minWidth:14}}>#{i+2}</span>
            <input style={{...S.input,flex:1}} type="number" min="0.01" step="0.1" value={sz.w||""} onChange={e=>{const v=e.target.value;const pv=parseFloat(v);if(!v||isNaN(pv)||!isFinite(pv)){updSz({w:v});return;}updSz(lockSide==="width"?{w:v,h:(pv/ar).toFixed(3)}:{w:v});}}/>
            <span style={{fontSize:9,color:C.muted}}>×</span>
            <input style={{...S.input,flex:1}} type="number" min="0.01" step="0.1" value={sz.h||""} onChange={e=>{const v=e.target.value;const pv=parseFloat(v);if(!v||isNaN(pv)||!isFinite(pv)){updSz({h:v});return;}updSz(lockSide==="height"?{h:v,w:(pv*ar).toFixed(3)}:{h:v});}}/>
            <input style={{...S.input,width:48}} type="number" min="1" max="999" value={sz.copies||1} onChange={e=>updSz({copies:parseInt(e.target.value)||1})}/>
            <button style={{...S.btn("ghost"),padding:"2px 5px",fontSize:9}} onClick={()=>updActive(s=>({extraSizes:s.extraSizes.filter(s2=>s2.id!==sz.id)}))}>✕</button>
          </div>;
        })}
      </div>}
      <button style={{...S.btn("ghost"),width:"100%",marginBottom:6,fontSize:9,padding:"5px 0"}} onClick={()=>updActive(s=>({extraSizes:[...s.extraSizes,{id:uid(),w:placeW||"3",h:placeH||"3",copies:1}]}))} disabled={!uploadedImg}>
        + Add Size Variant
      </button>
      <button style={{...S.btn("primary"),width:"100%",padding:isMobile?"14px":"9px",fontSize:isMobile?14:11}} onClick={autoPlace} disabled={!uploadedImg||!placeW||!placeH}>
        {extraSizes.length>0?`Auto-Place All Sizes (${1+extraSizes.length})`:`Auto-Place ${copies} ${copies===1?"Copy":"Copies"}`}
      </button>
      {selectedItem&&!isMobile&&(
        <div style={S.divider}>
          <div style={S.label}>Selected Copy</div>
          <div style={{fontSize:11,color:C.accent,marginBottom:5,display:"flex",alignItems:"center",gap:5}}>
            {selectedGroup&&<span style={S.dot(selectedGroup.color)}/>}{selectedItem.name.replace(/\.[^.]+$/,"")}
          </div>
          <div style={S.row}>
            <div style={{flex:1}}><div style={S.label}>X (in)</div><input style={S.input} type="number" step="0.05" value={selectedItem.x.toFixed(3)} onChange={e=>updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,x:snap(parseFloat(e.target.value)||0)})}))}/></div>
            <div style={{flex:1}}><div style={S.label}>Y (in)</div><input style={S.input} type="number" step="0.05" value={selectedItem.y.toFixed(3)} onChange={e=>updActive(s=>({placements:s.placements.map(p=>p.id!==selected?p:{...p,y:snap(parseFloat(e.target.value)||0)})}))}/></div>
          </div>
          <div style={{...S.row,marginTop:4,flexWrap:"wrap",gap:3}}>
            <button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:9}} onClick={()=>rotateSelected(90)}>↻90°</button>
            <button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:9}} onClick={()=>rotateSelected(-90)}>↺90°</button>
            <button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:9}} onClick={()=>flipSelected("h")}>↔Flip</button>
            <button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:9}} onClick={()=>flipSelected("v")}>↕Flip</button>
            <button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:9}} onClick={duplicateSelected}>⊕Dupe</button>
          </div>
          <button style={{...S.btn("danger"),width:"100%",marginTop:5}} onClick={deleteSelected}>Delete This Copy</button>
        </div>
      )}
    </div>
  );

  const layersPanelJsx=(
    <>
      <div style={{flex:1,overflowY:"auto",padding:"8px 8px 5px"}} onDragOver={e=>{
        e.preventDefault(); e.dataTransfer.dropEffect="move";
        // Auto-scroll layers panel when dragging near edges
        const el=e.currentTarget,rect=el.getBoundingClientRect();
        const zone=60,speed=18;
        const topDist=e.clientY-rect.top,botDist=rect.bottom-e.clientY;
        if(topDist<zone)el.scrollTop-=speed*(1-topDist/zone);
        else if(botDist<zone)el.scrollTop+=speed*(1-botDist/zone);
      }} onDrop={e=>{e.preventDefault();setDragOverId(null);}} onContextMenu={e=>{
        // Right-click on empty area
        if(e.target.closest('[data-layer-row]'))return;
        e.preventDefault();
        setLayerCtx({x:e.clientX,y:e.clientY,type:"empty"});
      }}>
        {groups.length===0&&<div style={{fontSize:13,color:C.surface2,textAlign:"center",marginTop:24,lineHeight:1.9}}>No images on this sheet.<br/>Image → Auto-Place</div>}
        {groups.map(g=>{
          const gp=placements.filter(p=>p.groupId===g.id);
          const isSel=selectedItem?.groupId===g.id,isHov=hoveredGroup===g.id;
          const{warn,caution}=g.naturalW?nativeRes(g.naturalW,g.naturalH,g.w,g.h,sheetDPI):{};
          const isCollapsed=collapsedGroups.has(g.id);
          return(
            <div key={g.id}>
              <div data-layer-row="group" style={{...S.grpRow(isHov,isSel),boxShadow:dragOverId===g.id?"inset 0 2px 0 #6366f1":"none",WebkitUserDrag:"element",cursor:dragLayer?"grabbing":"pointer"}}
                draggable="true" onDragStart={e=>{e.dataTransfer.setData("text/plain",g.id.toString());e.dataTransfer.effectAllowed="move";setDragLayer({type:"group",id:g.id});}}
                onDragEnd={()=>{setDragLayer(null);setDragOverId(null);}}
                onDragOver={e=>{e.preventDefault();setDragOverId(g.id);}} onDragLeave={()=>setDragOverId(null)}
                onDrop={e=>{e.preventDefault();setDragOverId(null);if(!dragLayer)return;
                  if(dragLayer.type==="placement"){
                    // Move placement to this group
                    updActive(s=>({placements:s.placements.map(p=>p.id===dragLayer.id?{...p,groupId:g.id,color:g.color}:p)}));
                  } else if(dragLayer.type==="group"&&dragLayer.id!==g.id){
                    // Reorder groups
                    updActive(s=>{const gs=[...s.groups];const fi=gs.findIndex(x=>x.id===dragLayer.id);const ti=gs.findIndex(x=>x.id===g.id);const[item]=gs.splice(fi,1);gs.splice(ti,0,item);return{groups:gs};});
                  }
                  setDragLayer(null);
                }}
                onMouseEnter={()=>setHoveredGroup(g.id)} onMouseLeave={()=>setHoveredGroup(null)}
                onClick={e=>{if(!gp[0])return;if(e.ctrlKey||e.metaKey){setMultiSelected(prev=>[...prev,...gp.map(p=>p.id).filter(id=>!prev.includes(id)&&id!==selected)]);if(!selected)setSelected(gp[0].id);}else{setSelected(gp[0].id);setMultiSelected(gp.slice(1).map(p=>p.id));setLeftTab("add");if(isMobile)setDrawer(null);}}}
                onContextMenu={e=>{e.preventDefault();e.stopPropagation();setLayerCtx({x:e.clientX,y:e.clientY,type:"group",id:g.id,groupId:g.id});if(gp[0])setSelected(gp[0].id);}}>
                <span style={{cursor:"pointer",fontSize:11,color:C.muted,width:16,textAlign:"center",flexShrink:0,userSelect:"none"}} onClick={e=>{e.stopPropagation();toggleGroupCollapse(g.id);}} title={isCollapsed?"Expand group":"Collapse group"}>{isCollapsed?"▸":"▾"}</span>
                <div style={{...S.dot(g.color),width:10,height:10}}/>
                <div style={{flex:1,minWidth:0}}>
                  {editingGroupId===g.id?(
                    <input style={{background:"transparent",border:"none",borderBottom:`1px solid ${C.accent}`,color:C.text,fontSize:13,width:"100%",outline:"none",padding:"0 2px"}}
                      autoFocus value={editingGroupName} onChange={e=>setEditingGroupName(e.target.value)}
                      onBlur={()=>{if(editingGroupName.trim())renameGroup(g.id,editingGroupName.trim());setEditingGroupId(null);}}
                      onKeyDown={e=>{if(e.key==="Enter"){if(editingGroupName.trim())renameGroup(g.id,editingGroupName.trim());setEditingGroupId(null);}e.stopPropagation();}}
                      onClick={e=>e.stopPropagation()}/>
                  ):(
                    <div style={{fontSize:isMobile?14:13,color:C.textSoft,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={"Double-click to rename · Right-click for options"}
                      onDoubleClick={e=>{e.stopPropagation();setEditingGroupId(g.id);setEditingGroupName(g.name);}}>{g.name}</div>
                  )}
                  <div style={{fontSize:9,color:C.muted}}>{gp.length}× · {sqIn(gp).toFixed(1)} sq in</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
                  <span style={{fontSize:11,cursor:"pointer",opacity:gp.some(p=>p.visible===false)?0.4:0.7}} onClick={e=>{e.stopPropagation();toggleGroupVisible(g.id);}} title="Toggle visibility">{gp.some(p=>p.visible===false)?"🔇":"👁"}</span>
                  <span style={{fontSize:11,cursor:"pointer",opacity:gp.some(p=>p.locked)?1:0.4}} onClick={e=>{e.stopPropagation();toggleGroupLock(g.id);}} title="Toggle lock">{gp.some(p=>p.locked)?"🔒":"🔓"}</span>
                </div>
              </div>
              {!isCollapsed&&gp.map((p,idx)=>{
                const pSel=p.id===selected||multiSelected.includes(p.id);
                const pHov=p.id===hoveredPlacement;
                return(
                <div data-layer-row="placement" key={p.id} style={{...S.copyRow(pSel),paddingLeft:28,background:pHov&&!pSel?C.hover:"inherit",boxShadow:dragOverId===p.id?"inset 0 2px 0 #6366f1":"none",WebkitUserDrag:"element",cursor:dragLayer?"grabbing":"pointer"}}
                  draggable="true" onDragStart={e=>{e.dataTransfer.setData("text/plain",p.id.toString());e.dataTransfer.effectAllowed="move";setDragLayer({type:"placement",id:p.id,groupId:g.id});}}
                  onDragEnd={()=>{setDragLayer(null);setDragOverId(null);}}
                  onDragOver={e=>{e.preventDefault();setDragOverId(p.id);}} onDragLeave={()=>setDragOverId(null)}
                  onDrop={e=>{e.preventDefault();setDragOverId(null);if(!dragLayer||dragLayer.id===p.id)return;
                    if(dragLayer.type==="placement"){
                    // Reorder placements within or across groups
                    updActive(s=>{
                      const ps=[...s.placements];
                      const fi=ps.findIndex(x=>x.id===dragLayer.id);
                      const ti=ps.findIndex(x=>x.id===p.id);
                      const[item]=ps.splice(fi,1);
                      item.groupId=g.id; item.color=g.color; // move to target's group
                      ps.splice(ti,0,item);
                      return{placements:ps};
                    });}
                    setDragLayer(null);
                  }}
                  onMouseEnter={()=>setHoveredPlacement(p.id)} onMouseLeave={()=>setHoveredPlacement(null)}
                  onClick={e=>{if(e.ctrlKey||e.metaKey){setMultiSelected(prev=>prev.includes(p.id)?prev.filter(id=>id!==p.id):[...prev,p.id]);}else{setSelected(p.id);setMultiSelected([]);}if(isMobile)setDrawer(null);}}
                  onContextMenu={e=>{e.preventDefault();e.stopPropagation();setSelected(p.id);setLayerCtx({x:e.clientX,y:e.clientY,type:"placement",id:p.id,groupId:g.id});}}>
                  <div style={{...S.dot(g.color),width:6,height:6,opacity:0.5}}/>
                  {editingPlacementId===p.id?(
                    <input style={{background:"transparent",border:"none",borderBottom:`1px solid ${C.accent}`,color:C.text,fontSize:12,flex:1,outline:"none",padding:"0 2px"}}
                      autoFocus value={editingPlacementName} onChange={e=>setEditingPlacementName(e.target.value)}
                      onBlur={()=>{if(editingPlacementName.trim())renamePlacement(p.id,editingPlacementName.trim());setEditingPlacementId(null);}}
                      onKeyDown={e=>{if(e.key==="Enter"){if(editingPlacementName.trim())renamePlacement(p.id,editingPlacementName.trim());setEditingPlacementId(null);}e.stopPropagation();}}
                      onClick={e=>e.stopPropagation()}/>
                  ):(
                    <span style={{fontSize:12,color:pSel?C.amber:C.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                      title="Double-click to rename · Right-click for options"
                      onDoubleClick={e=>{e.stopPropagation();setEditingPlacementId(p.id);setEditingPlacementName(p.name||`copy ${idx+1}`);}}>{p.name||`copy ${idx+1}`}</span>
                  )}
                  <span style={{fontSize:10,color:C.muted}}>{p.w.toFixed(1)}"×{p.h.toFixed(1)}"</span>
                  {p.naturalW>0&&(()=>{const{warn:pw,caution:pc,effDpi:pd}=nativeRes(p.naturalW,p.naturalH,p.w,p.h,sheetDPI);return <span style={{fontSize:9,color:pw?C.red:pc?C.amber:C.greenBright,fontWeight:700}}>{Math.round(pd)}{pw?" LOW":""}</span>;})()}
                  {p.rotation?<span style={{fontSize:9,color:C.muted,marginLeft:2}}>{p.rotation}°</span>:null}
                  <span style={{fontSize:10,cursor:"pointer",opacity:p.visible===false?0.4:0.7,marginLeft:2}} onClick={e=>{e.stopPropagation();toggleVisible(p.id);}} title={p.visible===false?"Show":"Hide"}>{p.visible===false?"🔇":"👁"}</span>
                  <span style={{fontSize:10,cursor:"pointer",opacity:p.locked?1:0.4,marginLeft:1}} onClick={e=>{e.stopPropagation();toggleLock(p.id);}} title={p.locked?"Unlock":"Lock"}>{p.locked?"🔒":"🔓"}</span>
                </div>
              );})}
            </div>
          );
        })}
      </div>
      <div style={{padding:"7px 10px",borderTop:`1px solid ${C.border}`,fontSize:9,color:C.muted,lineHeight:1.9}}>
        {sheets.map(s=>(
          <div key={s.id} style={{display:"flex",justifyContent:"space-between",cursor:"pointer",color:s.id===activeId?C.accent:C.muted,marginBottom:1}} onClick={()=>{switchTab(s.id);if(isMobile)setDrawer(null);}}>
            <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:130}}>{s.label}</span>
            <span>{s.placements.length}i · {sqIn(s.placements).toFixed(0)}sq"</span>
          </div>
        ))}
      </div>
    </>
  );

  // ── Shared modals ──
  const modalsJsx = (
    <>
      {showSave&&(
        <div style={S.modal} onClick={()=>setShowSave(false)}>
          <div style={S.modalBox} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}><span style={{fontSize:12,fontWeight:700,color:C.accent,letterSpacing:"0.1em"}}>💾 SAVE / LOAD</span><button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:10,minHeight:"unset"}} onClick={()=>setShowSave(false)}>✕</button></div>
            <div style={{padding:"12px 14px",borderBottom:`1px solid ${C.border}`}}>
              <div style={S.label}>Export Current Sheet — {active.label}</div>
              <div style={{display:"flex",gap:6,marginTop:5}}><input style={{...S.input,flex:1}} placeholder="Project name…" value={saveName} onChange={e=>setSaveName(e.target.value)} onKeyDown={e=>{e.stopPropagation();if(e.key==="Enter")saveProject();}}/><button style={S.btn("primary")} onClick={saveProject}>Export</button></div>
              {saveStatus&&<div style={{...(saveStatus.startsWith("✓")?S.ok:S.warn),marginTop:6}}>{saveStatus}</div>}
              <div style={{fontSize:8,color:C.muted,marginTop:4}}>Current sheet + images + zoom/scroll embedded as .gangowl file.</div>
              <div style={{display:"flex",gap:6,marginTop:8}}>
                <label style={{...S.btn("d"),flex:1,fontSize:10,cursor:"pointer"}} title="Load .gangowl project file">⬆ Import .gangowl<input type="file" accept=".gangowl,.json" style={{display:"none"}} onChange={importProject}/></label>
              </div>
            </div>
            <div style={{padding:"10px 14px",flex:1,overflowY:"auto"}}>
              <div style={S.label}>Saved ({saveList.length})</div>
              {saveLoading&&<div style={{fontSize:10,color:C.muted,marginTop:7}}>Loading…</div>}
              {!saveLoading&&!saveList.length&&<div style={{fontSize:10,color:C.surface2,marginTop:9}}>No saves yet.</div>}
              {saveList.map(s=>(
                <div key={s.name} style={S.slot} onClick={()=>loadProject(s)}>
                  <div style={{flex:1}}><div style={{fontSize:12,color:C.text}}>{s.name}</div><div style={{fontSize:9,color:C.muted,marginTop:1}}>{s.sheets?.length||1} sheet{(s.sheets?.length||1)!==1?"s":""} · {s.sheets?.reduce((a,sh)=>a+(sh.placements?.length||0),0)||0} items</div><div style={{fontSize:8,color:C.surface2}}>{new Date(s.savedAt).toLocaleString()}</div></div>
                  <button style={{...S.btn("primary"),padding:"5px 9px",fontSize:9,minHeight:"unset"}}>Load</button>
                  <button style={{...S.btn("danger"),padding:"5px 7px",fontSize:9,minHeight:"unset"}} onClick={e=>deleteSave(s.name,e)}>✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {showPresets&&(
        <div style={S.modal} onClick={()=>setShowPresets(false)}>
          <div style={{...S.modalBox,width:isMobile?"94vw":360}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}><span style={{fontSize:12,fontWeight:700,color:C.accent,letterSpacing:"0.1em"}}>⚙ PRESETS</span><button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:10,minHeight:"unset"}} onClick={()=>setShowPresets(false)}>✕</button></div>
            <div style={{padding:"12px 14px",borderBottom:`1px solid ${C.border}`}}>
              <div style={S.label}>Save Current Settings</div>
              <div style={{display:"flex",gap:6,marginTop:5}}><input style={{...S.input,flex:1}} placeholder="Standard 22×200 DTF" value={presetName} onChange={e=>setPresetName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&savePreset()}/><button style={S.btn("primary")} onClick={savePreset}>Save</button></div>
            </div>
            <div style={{padding:"10px 14px",flex:1,overflowY:"auto"}}>
              <div style={S.label}>Templates</div>
              {BUILT_IN_TEMPLATES.map(p=>(
                <div key={p.name} style={S.slot} onClick={()=>loadPreset(p)}>
                  <div style={{flex:1}}><div style={{fontSize:12,color:C.text}}>{p.name}</div><div style={{fontSize:9,color:C.muted,marginTop:1}}>{p.sheetW}"×{p.sheetH}" · {p.sheetDPI}dpi{p.margin?` · ${p.margin}" margin`:""}</div></div>
                  <button style={{...S.btn("primary"),padding:"5px 9px",fontSize:9,minHeight:"unset"}}>Use</button>
                </div>
              ))}
              {presets.length>0&&<div style={{...S.label,marginTop:10}}>Custom Presets ({presets.length})</div>}
              {presets.map(p=>(
                <div key={p.name} style={S.slot} onClick={()=>loadPreset(p)}>
                  <div style={{flex:1}}><div style={{fontSize:12,color:C.text}}>{p.name}</div><div style={{fontSize:9,color:C.muted,marginTop:1}}>{p.sheetW}"×{p.sheetH}" · {p.sheetDPI}dpi{p.margin?` · ${p.margin}" margin`:""}</div></div>
                  <button style={{...S.btn("primary"),padding:"5px 9px",fontSize:9,minHeight:"unset"}}>Use</button>
                  <button style={{...S.btn("danger"),padding:"5px 7px",fontSize:9,minHeight:"unset"}} onClick={e=>deletePreset(p.name,e)}>✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {showCSV&&(
        <div style={S.modal} onClick={()=>setShowCSV(false)}>
          <div style={{...S.modalBox,width:isMobile?"96vw":540}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}><span style={{fontSize:12,fontWeight:700,color:C.accent,letterSpacing:"0.1em"}}>📋 JOB SUMMARY</span><div style={{display:"flex",gap:5}}><button style={{...S.btn("success"),minHeight:"unset",padding:"5px 10px",fontSize:9}} onClick={downloadCSV}>⬇ CSV</button><button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:10,minHeight:"unset"}} onClick={()=>setShowCSV(false)}>✕</button></div></div>
            <div style={{padding:"12px 14px",flex:1,overflowY:"auto"}}>
              {sheets.map(s=>{const tSq=sqIn(s.placements);const ut=((s.sheetW-s.margin*2)*(s.sheetH-s.margin*2))>0?Math.min(100,(tSq/((s.sheetW-s.margin*2)*(s.sheetH-s.margin*2)))*100):0;return(
                <div key={s.id} style={{marginBottom:14}}>
                  <div style={{fontSize:11,color:C.accent,fontWeight:700,marginBottom:5,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}><span>{s.label}</span><span style={{fontSize:9,color:C.muted}}>{s.placements.length} items · {ut.toFixed(1)}%</span>{s.inkCostPerSqIn>0&&<span style={{fontSize:9,color:C.greenBright}}>~${(tSq*s.inkCostPerSqIn).toFixed(2)}</span>}</div>
                  {s.groups.length===0?<div style={{fontSize:9,color:C.surface2}}>No designs.</div>:(
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,minWidth:400}}>
                        <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>{["Design","Notes","Qty","W","H","Rot","EffDPI","Status"].map(h=><th key={h} style={{padding:"3px 6px",textAlign:"left",color:C.muted,fontWeight:400,fontSize:8,textTransform:"uppercase"}}>{h}</th>)}</tr></thead>
                        <tbody>{s.groups.map(g=>{const gp=s.placements.filter(p=>p.groupId===g.id);const{effDpi,warn,caution}=g.naturalW?nativeRes(g.naturalW,g.naturalH,g.w,g.h,s.sheetDPI):{effDpi:0,warn:false,caution:false};return(<tr key={g.id} style={{borderBottom:`1px solid #1a1929`}}><td style={{padding:"4px 6px",color:C.text,whiteSpace:"nowrap"}}><span style={{...S.dot(g.color),display:"inline-block",marginRight:4,verticalAlign:"middle"}}/>{g.name}</td><td style={{padding:"4px 6px",color:C.muted,maxWidth:90,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{g.notes||"—"}</td><td style={{padding:"4px 6px",color:C.text}}>{gp.length}</td><td style={{padding:"4px 6px",color:C.text}}>{g.w.toFixed(2)}"</td><td style={{padding:"4px 6px",color:C.text}}>{g.h.toFixed(2)}"</td><td style={{padding:"4px 6px",color:C.muted}}>{gp[0]?.rotation?`${gp[0].rotation}°`:"—"}</td><td style={{padding:"4px 6px",color:C.muted}}>{Math.round(effDpi)||"?"}</td><td style={{padding:"4px 6px",color:warn?C.red:caution?C.amber:C.greenBright,fontWeight:700}}>{warn?"LOW":caution?"CAUTION":"OK"}</td></tr>);})}</tbody>
                      </table>
                    </div>
                  )}
                </div>
              );})}
            </div>
          </div>
        </div>
      )}
      {showFillConfirm&&(
        <div style={S.modal} onClick={()=>setShowFillConfirm(false)}>
          <div style={{...S.modalBox,width:isMobile?"90vw":320}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}><span style={{fontSize:12,fontWeight:700,color:C.accent}}>⬛ Fill Sheet</span></div>
            <div style={{padding:"14px 16px"}}>
              <div style={{fontSize:13,color:C.text,lineHeight:1.7,marginBottom:10}}>Pack all {groups.length} design{groups.length!==1?"s":""} into remaining space on <strong style={{color:C.accent}}>{active.label}</strong>.</div>
              <div style={{fontSize:10,color:C.muted,marginBottom:10}}>Existing placements won't move.</div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                <span style={{fontSize:10,color:C.muted}}>Auto-rotate for best fit</span>
                <Toggle on={autoRotateFill} onClick={()=>updActive({autoRotateFill:!autoRotateFill})}/>
              </div>
              <div style={{display:"flex",gap:8}}><button style={{...S.btn("primary"),flex:1}} onClick={doFillSheet}>Fill Now</button><button style={{...S.btn("ghost"),flex:1}} onClick={()=>setShowFillConfirm(false)}>Cancel</button></div>
            </div>
          </div>
        </div>
      )}
      {showExportDialog&&(
        <div style={S.modal} onClick={()=>setShowExportDialog(false)}>
          <div style={{...S.modalBox,width:isMobile?"90vw":360}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}>
              <span style={{fontSize:12,fontWeight:700,color:C.accent,letterSpacing:"0.1em"}}>⬇ EXPORT {exportAllPending?"ALL SHEETS":active.label.toUpperCase()}</span>
              <button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:10,minHeight:"unset"}} onClick={()=>setShowExportDialog(false)}>✕</button>
            </div>
            <div style={{padding:"16px 18px",display:"flex",flexDirection:"column",gap:14}}>
              <div>
                <div style={{fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>Format</div>
                <div style={{display:"flex",gap:6}}>
                  {["png","jpeg","webp","pdf"].map(f=>(
                    <button key={f} style={{flex:1,padding:"8px 0",borderRadius:6,border:`1px solid ${exportFormat===f?C.accentSolid:C.border}`,background:exportFormat===f?C.selected:"transparent",color:exportFormat===f?C.accent:C.muted,cursor:"pointer",fontSize:11,fontWeight:700,textTransform:"uppercase"}} onClick={()=>setExportFormat(f)}>{f}</button>
                  ))}
                </div>
              </div>
              {exportFormat!=="png"&&exportFormat!=="pdf"&&(
                <div>
                  <div style={{fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>Quality — {Math.round(exportQuality*100)}%</div>
                  <input type="range" min="0.1" max="1" step="0.05" value={exportQuality} onChange={e=>setExportQuality(parseFloat(e.target.value))} style={{width:"100%",accentColor:C.accentSolid}}/>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:C.muted,marginTop:2}}><span>Smaller file</span><span>Higher quality</span></div>
                </div>
              )}
              <div style={{fontSize:10,color:C.muted,lineHeight:1.5}}>
                {exportFormat==="png"&&"Lossless with transparency. Best for print production."}
                {exportFormat==="jpeg"&&"Lossy compression, no transparency. Smaller file size."}
                {exportFormat==="webp"&&"Modern format, lossy/lossless. Good compression with quality."}
                {exportFormat==="pdf"&&"PDF document with embedded image. Compatible with RIP software."}
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0"}}>
                <span style={{fontSize:10,color:C.muted}}>Mirror for DTF</span>
                <Toggle on={mirrorExport} onClick={()=>updActive({mirrorExport:!mirrorExport})}/>
              </div>
              {sheets.length>1&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0"}}>
                <span style={{fontSize:10,color:C.muted}}>Export all sheets ({sheets.filter(s=>s.placements.length>0).length} with content)</span>
                <Toggle on={exportAllPending} onClick={()=>setExportAllPending(!exportAllPending)}/>
              </div>}
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.muted}}>
                <span>{exportAllPending?`${sheets.filter(s=>s.placements.length>0).length} sheets`:active.label} · {sheetW}"×{sheetH}" @ {sheetDPI}dpi</span>
                <span>{exportAllPending?sheets.reduce((a,s)=>a+s.placements.length,0):placements.length} items</span>
              </div>
              <button style={{...S.btn("primary"),padding:"10px 0",fontSize:12,width:"100%"}} onClick={()=>startExport(exportAllPending)}>
                Export {exportFormat.toUpperCase()}{exportAllPending?" (All Sheets)":""}
              </button>
            </div>
          </div>
        </div>
      )}
      {showSettings&&(
        <div style={S.modal} onClick={()=>setShowSettings(false)}>
          <div style={{...S.modalBox,width:isMobile?"90vw":360}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}><span style={{fontSize:13,fontWeight:700,color:C.accent}}>Settings</span><button style={{...S.btn("ghost"),padding:"3px 7px",fontSize:10,minHeight:"unset"}} onClick={()=>setShowSettings(false)}>✕</button></div>
            <div style={{padding:"16px 18px",display:"flex",flexDirection:"column",gap:16}}>
              <div>
                <div style={S.label}>UI Scale — {Math.round(uiScale*100)}%</div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6}}>
                  <button style={{...S.btn("ghost"),padding:"4px 10px",fontSize:14,minHeight:"unset"}} onClick={()=>setUiScale(s=>Math.max(0.7,+(s-0.1).toFixed(1)))}>−</button>
                  <input type="range" min="0.7" max="1.8" step="0.1" value={uiScale} onChange={e=>setUiScale(parseFloat(e.target.value))} style={{flex:1,accentColor:C.accentSolid}}/>
                  <button style={{...S.btn("ghost"),padding:"4px 10px",fontSize:14,minHeight:"unset"}} onClick={()=>setUiScale(s=>Math.min(1.8,+(s+0.1).toFixed(1)))}>+</button>
                </div>
              </div>
              <div>
                <div style={S.label}>Theme</div>
                <div style={{display:"flex",gap:6,marginTop:6}}>
                  {[["dark","Dark"],["light","Light"],["midnight","Midnight"]].map(([k,label])=>(
                    <button key={k} style={{...S.btn(theme===k?"primary":"ghost"),flex:1,fontSize:11}} onClick={()=>setTheme(k)}>{label}</button>
                  ))}
                </div>
              </div>
              <button style={{...S.btn("ghost"),fontSize:10}} onClick={()=>{setUiScale(1);setTheme("dark");}}>Reset Defaults</button>
            </div>
          </div>
        </div>
      )}
      {showExportAd&&<ExportAd onClose={onExportAdDone}/>}
      {appLoading&&(
        <div style={S.overlay}>
          <div style={S.spinner}/>
          <div style={{fontSize:12,color:C.accent,marginTop:8}}>Loading project…</div>
        </div>
      )}
      {nestingInProgress&&(
        <div style={S.overlay}>
          <div style={S.spinner}/>
          <div style={{fontSize:12,color:C.accent,marginTop:8}}>{nestingProgress||"Calculating placement…"}</div>
        </div>
      )}
      {batchPlacing&&(
        <div style={S.overlay}>
          <div style={S.spinner}/>
          <div style={{fontSize:12,color:C.accent,marginTop:8}}>{batchProgress||"Processing batch…"}</div>
        </div>
      )}
      {batchFiles&&!batchPlacing&&(
        <div style={S.modal}>
          <div style={{...S.modalBox,width:isMobile?"96vw":620,maxHeight:"86vh"}}>
            <div style={S.modalHead}>
              <span style={{fontWeight:800,fontSize:11,letterSpacing:"0.08em",color:C.accent}}>BATCH UPLOAD</span>
              <button style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16,padding:0}} onClick={()=>setBatchFiles(null)}>✕</button>
            </div>
            <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:9,color:C.muted}}>Auto-rotate</span>
                <Toggle on={autoRotatePlace} onClick={()=>updActive({autoRotatePlace:!autoRotatePlace})}/>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:9,color:C.muted}}>Auto-distribute</span>
                <Toggle on={autoDistribute} onClick={()=>updActive({autoDistribute:!autoDistribute})}/>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:9,color:C.muted}}>Gap</span>
                <input style={{...S.input,width:50,fontSize:10}} type="number" min="0" step="0.05" value={gap} onChange={e=>updActive({gap:parseFloat(e.target.value)||0})}/>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:4,marginLeft:"auto"}}>
                <span style={{fontSize:9,color:C.muted}}>All qty</span>
                <input style={{...S.input,width:48,fontSize:10}} type="number" min="1" max="999" value={batchAllQty} placeholder="—" onChange={e=>setBatchAllQty(e.target.value)}/>
                <button style={{...S.btn("ghost"),padding:"3px 8px",fontSize:9,minHeight:"unset"}} onClick={()=>{const v=parseInt(batchAllQty)||1;setBatchFiles(prev=>prev?prev.map(b=>({...b,copies:v,sizes:b.sizes?.map(s=>({...s,copies:v}))})):prev);}}>Apply</button>
              </div>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:"8px 14px"}}>
              {batchFiles.map((bf,i)=>{
                const ar=bf.naturalH>0?bf.naturalW/bf.naturalH:1;
                const sizes=bf.sizes||[{id:"base",w:bf.w||"1",h:bf.h||"1",copies:bf.copies||1}];
                const updBf=(patch)=>setBatchFiles(prev=>prev?prev.map(b=>b.id===bf.id?{...b,...patch}:b):prev);
                const updSize=(sizeId,patch)=>{
                  if(sizeId==="base"){
                    // Update both the batch file and the base size entry if sizes array exists
                    if(bf.sizes) setBatchFiles(prev=>prev?prev.map(b=>b.id!==bf.id?b:{...b,...patch,sizes:b.sizes.map((s,i)=>i===0?{...s,...patch}:s)}):prev);
                    else updBf(patch);
                  }
                  else setBatchFiles(prev=>prev?prev.map(b=>b.id!==bf.id?b:{...b,sizes:(b.sizes||[]).map(s=>s.id===sizeId?{...s,...patch}:s)}):prev);
                };
                const doTrim=()=>{
                  if(bf.trimmed){
                    // Revert to original
                    const origSrc=bf.originalSrc||bf.src;
                    const img2=cachedImg(origSrc);
                    if(img2&&img2.naturalWidth){
                      updBf({src:origSrc,naturalW:img2.naturalWidth,naturalH:img2.naturalHeight,w:(img2.naturalWidth/sheetDPI).toFixed(3),h:(img2.naturalHeight/sheetDPI).toFixed(3),trimmed:false});
                    }
                  } else {
                    // Apply trim
                    const img2=cachedImg(bf.src);
                    if(img2&&img2.naturalWidth){
                      const t=trimImage(img2);
                      if(t){
                        cachedImg(t.src);
                        updBf({originalSrc:bf.originalSrc||bf.src,src:t.src,naturalW:t.naturalW,naturalH:t.naturalH,w:(t.naturalW/sheetDPI).toFixed(3),h:(t.naturalH/sheetDPI).toFixed(3),trimmed:true});
                      }
                    }
                  }
                };
                return <div key={bf.id} style={{marginBottom:10,padding:8,background:C.selected,borderRadius:6,border:`1px solid ${C.border}`}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
                    <img src={bf.src} style={{width:40,height:40,objectFit:"contain",borderRadius:4,border:`1px solid ${C.border}`,background:C.bg}} alt=""/>
                    <span style={{flex:1,fontSize:10,color:C.accent,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{bf.name}</span>
                    <div style={{display:"flex",alignItems:"center",gap:3}}>
                      <span style={{fontSize:8,color:C.muted}}>Trim</span>
                      <Toggle on={!!bf.trimmed} onClick={doTrim}/>
                    </div>
                    <button style={{...S.btn("ghost"),padding:"2px 6px",fontSize:9,color:"#ef4444"}} onClick={()=>setBatchFiles(prev=>{const n=prev.filter(b=>b.id!==bf.id);return n.length?n:null;})}>✕</button>
                  </div>
                  {sizes.map((sz,si)=><div key={sz.id} style={{display:"flex",gap:4,alignItems:"center",marginBottom:3}}>
                    <span style={{fontSize:8,color:C.muted,minWidth:12}}>{si===0?"":"#"+(si+1)}</span>
                    <input style={{...S.input,flex:1,fontSize:10}} type="number" min="0.01" step="0.1" value={sz.w||""} onChange={e=>{const v=e.target.value;const pv=parseFloat(v);if(!v||!isFinite(pv)||pv<=0){updSize(sz.id,{w:v});return;}updSize(sz.id,ar>0&&isFinite(ar)?{w:v,h:(pv/ar).toFixed(3)}:{w:v});}}/>
                    <span style={{fontSize:8,color:C.muted}}>×</span>
                    <input style={{...S.input,flex:1,fontSize:10}} type="number" min="0.01" step="0.1" value={sz.h||""} onChange={e=>{const v=e.target.value;const pv=parseFloat(v);if(!v||!isFinite(pv)||pv<=0){updSize(sz.id,{h:v});return;}updSize(sz.id,ar>0&&isFinite(ar)?{h:v,w:(pv*ar).toFixed(3)}:{h:v});}}/>
                    <span style={{fontSize:8,color:C.muted}}>qty</span>
                    <input style={{...S.input,width:48,fontSize:10}} type="number" min="1" max="999" value={sz.copies||1} onChange={e=>updSize(sz.id,{copies:parseInt(e.target.value)||1})}/>
                    {si>0&&<button style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:10,padding:"0 2px"}} onClick={()=>setBatchFiles(prev=>prev.map(b=>b.id!==bf.id?b:{...b,sizes:b.sizes.filter(s=>s.id!==sz.id)}))}>✕</button>}
                  </div>)}
                  <button style={{fontSize:8,color:C.accent,background:"none",border:"none",cursor:"pointer",padding:"2px 0",opacity:0.7}} onClick={()=>{
                    const baseW=sizes[0]?.w||bf.w,baseH=sizes[0]?.h||bf.h;
                    const newSize={id:uid(),w:baseW,h:baseH,copies:1};
                    if(bf.sizes) updBf({sizes:[...bf.sizes,newSize]});
                    else updBf({sizes:[{id:"base",w:bf.w,h:bf.h,copies:bf.copies||1},newSize]});
                  }}>+ Add Size</button>
                </div>;
              })}
            </div>
            <div style={{padding:"10px 14px",borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <button style={{...S.btn("ghost"),fontSize:10}} onClick={()=>{const inp=document.createElement("input");inp.type="file";inp.accept="image/*";inp.multiple=true;inp.onchange=async(e)=>{const files=[...e.target.files];if(!files.length)return;const items=await Promise.all(files.map(file=>new Promise(resolve=>{const url=URL.createObjectURL(file);const img=new Image();img.onload=()=>{cachedImg(url);let src=url,nw=img.naturalWidth,nh=img.naturalHeight;if(autoTrimRef.current){const t=trimImage(img);if(t){src=t.src;nw=t.naturalW;nh=t.naturalH;cachedImg(src);}}resolve({id:uid(),file,src,name:file.name,naturalW:nw,naturalH:nh,w:(nw/sheetDPI).toFixed(3),h:(nh/sheetDPI).toFixed(3),lockSide:"width",copies:1,ready:true,error:null});};img.onerror=()=>resolve(null);img.src=url;})));setBatchFiles(prev=>[...prev,...items.filter(Boolean)]);};inp.click();}}>+ Add More</button>
              <button style={{...S.btn("primary"),fontSize:11,padding:"8px 24px"}} onClick={batchPlace}>
                Place All ({batchFiles.reduce((s,bf)=>{const sizes=bf.sizes||[{copies:bf.copies||1}];return s+sizes.reduce((ss,sz)=>ss+(parseInt(sz.copies)||1),0);},0)} items)
              </button>
            </div>
          </div>
        </div>
      )}
      {exporting&&(
        <div style={S.overlay}>
          <div style={S.spinner}/>
          <div style={{width:240,background:C.border,borderRadius:4,height:10,overflow:"hidden",marginTop:8}}>
            <div style={{height:"100%",background:C.accentSolid,borderRadius:4,width:`${exportPct}%`,transition:"width 0.15s"}}/>
          </div>
          <div style={{fontSize:12,color:C.accent,marginTop:6}}>{exportProgress||"Preparing…"} — {exportPct}%</div>
          {exportAllMode&&<div style={{fontSize:9,color:C.muted}}>Exporting all sheets…</div>}
          {/iPad|iPhone|iPod/.test(navigator.userAgent)&&<div style={{fontSize:9,color:C.muted,textAlign:"center",maxWidth:260}}>On iOS the image will open in a new tab — use share → Save to Photos</div>}
          <button style={{marginTop:12,padding:"6px 20px",borderRadius:6,border:`1px solid ${C.border}`,background:"transparent",color:C.muted,cursor:"pointer",fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase"}} onClick={cancelExport}>Cancel</button>
        </div>
      )}
    </>
  );

  return (
    <div style={S.app} onContextMenu={e=>{if(!e.defaultPrevented)e.preventDefault();}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none} input,textarea,select{user-select:text;-webkit-user-select:text} ::-webkit-scrollbar{width:5px;background:${C.bg}} ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px} input:focus,select:focus,textarea:focus{border-color:#6366f1!important;outline:none} select{appearance:none} button{touch-action:manipulation} textarea{resize:vertical} .tab-cls{opacity:0;transition:opacity 0.1s} .sht:hover .tab-cls{opacity:1}`}</style>

      {/* ── Logo / top bar (mobile only) ── */}
      {isMobile&&(
        <div style={{...S.logo,justifyContent:"space-between",padding:"10px 14px 9px",borderBottom:`1px solid ${C.border}`}}>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            <span style={{fontSize:16}}>🦉</span>
            <span>Gang<span style={{color:C.amber}}>Owl</span></span>

          </div>
          <div style={{display:"flex",gap:6}}>
            <button style={{...S.btn("ghost"),padding:"5px 9px",fontSize:11,minHeight:"unset"}} onClick={()=>setShowPresets(true)}>⚙</button>
            <button style={{...S.btn("ghost"),padding:"5px 9px",fontSize:11,minHeight:"unset"}} onClick={()=>setShowShortcuts(true)} title="Keyboard Shortcuts (?)">?</button>
            <button style={{...S.btn("ghost"),padding:"5px 9px",fontSize:11,minHeight:"unset"}} onClick={()=>setShowSave(true)}>💾</button>
          </div>
        </div>
      )}

      {isWeb&&<AdSlot variant="banner" style={{width:"100%",background:C.surface,borderBottom:`1px solid ${C.border}`}}/>}
      <div style={S.topRow}>
        {/* ── LEFT sidebar (tablet+desktop) ── */}
        <div style={S.left}>
          <div style={S.logo}>
            <span style={{fontSize:15}}>🦉</span>
            <span>Gang<span style={{color:C.amber}}>Owl</span></span>
            <span style={{marginLeft:"auto"}}/>
            <button style={{...S.btn("ghost"),padding:"3px 6px",fontSize:9,minHeight:"unset"}} onClick={()=>setShowPresets(true)}>⚙</button>
            <button style={{...S.btn("ghost"),padding:"3px 6px",fontSize:9,minHeight:"unset"}} onClick={()=>setShowSave(true)}>💾</button>
            <button style={{...S.btn("ghost"),padding:"3px 6px",fontSize:9,minHeight:"unset"}} onClick={()=>setShowSettings(true)} title="Settings">🎨</button>
          </div>
          <div style={S.ltabs}>
            <button style={S.ltab(leftTab==="sheet")} onClick={()=>setLeftTab("sheet")}>Sheet</button>
            <button style={S.ltab(leftTab==="add")} onClick={()=>setLeftTab("add")}>Image</button>
          </div>
          {leftTab==="sheet"?sheetPanelJsx:addImagePanelJsx}
        </div>

        {/* ── MAIN canvas ── */}
        <div style={S.main}>
          {/* Sheet tab bar */}
          <div style={S.sheetTabBar}>
            {sheets.map(s=>(
              <div key={s.id} className="sht" draggable={editingTabId!==s.id} style={{...S.sheetTab(s.id===activeId),...(dragOverTabId===s.id?{borderLeft:`2px solid ${C.accentSolid}`}:{})}} onClick={()=>switchTab(s.id)} onContextMenu={e=>{e.preventDefault();setTabCtx({x:e.clientX,y:e.clientY,sheetId:s.id});}}
                onDragStart={e=>{setDragTabId(s.id);e.dataTransfer.effectAllowed="move";}}
                onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect="move";if(s.id!==dragTabId)setDragOverTabId(s.id);}}
                onDragLeave={()=>setDragOverTabId(null)}
                onDrop={e=>{e.preventDefault();setDragOverTabId(null);if(!dragTabId||dragTabId===s.id)return;setSheets(prev=>{const arr=[...prev];const fromIdx=arr.findIndex(x=>x.id===dragTabId);const toIdx=arr.findIndex(x=>x.id===s.id);if(fromIdx<0||toIdx<0)return prev;const [moved]=arr.splice(fromIdx,1);arr.splice(toIdx,0,moved);return arr;});}}
                onDragEnd={()=>{setDragTabId(null);setDragOverTabId(null);}}>
                {editingTabId===s.id?(
                  <input ref={tabInputRef} style={{background:"transparent",border:"none",borderBottom:`1px solid ${C.accent}`,color:C.text,fontSize:10,width:Math.max(60,editingTabLabel.length*7+10),outline:"none",padding:"0 2px"}}
                    value={editingTabLabel} onChange={e=>setEditingTabLabel(e.target.value)} onBlur={commitRenameTab} onKeyDown={e=>{if(e.key==="Enter")commitRenameTab();e.stopPropagation();}} onClick={e=>e.stopPropagation()}/>
                ):(
                  <span onDoubleClick={e=>startRenameTab(s.id,s.label,e)} style={{maxWidth:100,overflow:"hidden",textOverflow:"ellipsis"}}>{s.label}</span>
                )}
                {s.placements.length>0&&<span style={{fontSize:8,color:C.muted}}>{s.placements.length}</span>}
                <div style={{display:"flex",gap:1,marginLeft:2}}>
                  <span className="tab-cls" style={{fontSize:10,color:C.muted,cursor:"pointer",padding:"0 2px"}} title="Duplicate" onClick={e=>duplicateSheet(s.id,e)}>⧉</span>
                  <span className="tab-cls" style={{fontSize:12,color:C.muted,cursor:"pointer",padding:"0 2px"}} onClick={e=>closeSheet(s.id,e)}>×</span>
                </div>
              </div>
            ))}
            <button style={S.addTabBtn} onClick={addSheet}>+</button>
          </div>

          {/* Toolbar */}
          <div style={S.toolbar}>
            <div style={{display:"flex",gap:2,marginRight:4}}>
              <button style={{padding:"4px 8px",minHeight:26,fontSize:9,borderRadius:4,border:`1px solid ${activeTool==="select"?C.accentSolid:C.border}`,background:activeTool==="select"?C.selected:"transparent",color:activeTool==="select"?C.accent:C.muted,cursor:"pointer",fontWeight:700,letterSpacing:"0.06em"}} onClick={()=>setActiveTool("select")} title="Select/Move (V)">↖</button>
              <button style={{padding:"4px 8px",minHeight:26,fontSize:9,borderRadius:4,border:`1px solid ${activeTool==="pan"?C.accentSolid:C.border}`,background:activeTool==="pan"?C.selected:"transparent",color:activeTool==="pan"?C.accent:C.muted,cursor:"pointer",fontWeight:700,letterSpacing:"0.06em"}} onClick={()=>setActiveTool("pan")} title="Pan/Hand (H)">✋</button>
            </div>
            <div style={{display:"flex",gap:2,marginRight:4}}>
              <button style={{padding:"4px 7px",minHeight:26,fontSize:11,borderRadius:4,border:`1px solid ${C.border}`,background:"transparent",color:undoStack.current.length?C.text:C.muted,cursor:undoStack.current.length?"pointer":"default",opacity:undoStack.current.length?1:0.35}} onClick={undo} title="Undo (Ctrl+Z)">↩</button>
              <button style={{padding:"4px 7px",minHeight:26,fontSize:11,borderRadius:4,border:`1px solid ${C.border}`,background:"transparent",color:redoStack.current.length?C.text:C.muted,cursor:redoStack.current.length?"pointer":"default",opacity:redoStack.current.length?1:0.35}} onClick={redo} title="Redo (Ctrl+Y)">↪</button>
            </div>
            {(selected||multiSelected.length>0)&&!isMobile&&<div style={{display:"flex",gap:1,marginRight:4}}>
              {[{m:"left",t:"Align left",l:"⫷"},{m:"centerH",t:"Center H",l:"⫿"},{m:"right",t:"Align right",l:"⫸"},{m:"top",t:"Align top",l:"⊤"},{m:"centerV",t:"Center V",l:"⊡"},{m:"bottom",t:"Align bottom",l:"⊥"},{m:"distributeH",t:"Distribute H",l:"⋯"},{m:"distributeV",t:"Distribute V",l:"⋮"}].map(({m,t,l})=>(
                <button key={m} style={{padding:"3px 5px",minHeight:22,fontSize:10,borderRadius:3,border:`1px solid ${C.border}`,background:"transparent",color:C.muted,cursor:"pointer"}} onClick={()=>alignSelected(m)} title={t}>{l}</button>
              ))}
            </div>}
            <span style={{fontSize:isMobile?10:11,color:C.muted,flex:1}}>{placements.length} item{placements.length!==1?"s":""} · {groups.length} design{groups.length!==1?"s":""}</span>
            {selected&&<button style={{...S.btn("danger"),padding:isMobile?"0 6px":"6px 11px"}} onClick={deleteSelected} title="Delete selected (Del)">{isMobile?"✕":"Delete"}</button>}
            {groups.length>0&&<button style={{...S.btn("d"),padding:isMobile?"0 6px":"6px 11px"}} onClick={()=>setShowFillConfirm(true)} title="Auto-fill sheet with designs">⬛</button>}
            <button style={{...S.btn("d"),padding:isMobile?"0 6px":"6px 11px"}} onClick={()=>setShowCSV(true)} title="View job summary / export CSV">📋</button>
            <button style={{...S.btn("primary"),opacity:placements.length===0?0.35:1,padding:isMobile?"0 6px":"6px 11px"}} onClick={()=>{setExportAllPending(false);setShowExportDialog(true);}} disabled={placements.length===0||exporting} title="Export this sheet">⬇</button>
            <button style={{...S.btn("warning"),opacity:sheets.every(s=>s.placements.length===0)?0.35:1,padding:isMobile?"0 6px":"6px 11px"}} onClick={()=>{setExportAllPending(true);setShowExportDialog(true);}} disabled={exporting} title="Export all sheets">⬇A</button>
          </div>

          {/* Util bar */}
          <div style={{padding:"3px 11px 0",background:C.surface,borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:7,paddingBottom:3}}>
              <div style={{fontSize:9,color:C.muted,whiteSpace:"nowrap"}}>util</div>
              <div style={{flex:1,background:C.border,borderRadius:3,height:5,overflow:"hidden"}}><div style={S.utilBar(utilPct)}/></div>
              <div style={{fontSize:9,color:utilPct>90?C.red:utilPct>70?C.amber:C.greenBright,whiteSpace:"nowrap"}}>{utilPct.toFixed(1)}%</div>
              {estCost&&<div style={{fontSize:9,color:C.greenBright,whiteSpace:"nowrap"}}>~${estCost}</div>}
              {zoom!==1&&<button style={{fontSize:9,color:C.muted,background:"transparent",border:"none",cursor:"pointer",padding:"0 4px"}} onClick={()=>{setZoom(1);setPanX(0);setPanY(0);const w=canvasWrapRef.current;if(w){w.scrollLeft=0;w.scrollTop=0;}}}>reset zoom</button>}
              <button style={{fontSize:9,color:showRulers?C.accent:C.muted,background:"transparent",border:"none",cursor:"pointer",padding:"0 4px",fontWeight:showRulers?700:400}} onClick={()=>setShowRulers(r=>!r)} title="Toggle Rulers (Ctrl+R)">📏</button>
            </div>
          </div>

          {/* Canvas with rulers */}
          <div style={{flex:1,position:"relative",overflow:"hidden"}}>
            {showRulers&&<>
              <div style={{position:"absolute",top:0,left:0,width:RULER_SIZE,height:RULER_SIZE,background:C.surface,zIndex:5,borderRight:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`}}/>
              <canvas ref={hRulerRef} style={{position:"absolute",top:0,left:RULER_SIZE,right:0,height:RULER_SIZE,zIndex:4,display:"block"}}/>
              <canvas ref={vRulerRef} style={{position:"absolute",top:RULER_SIZE,left:0,bottom:0,width:RULER_SIZE,zIndex:4,display:"block"}}/>
            </>}
            <div ref={canvasWrapRef} style={{...S.canvasWrap,position:"absolute",top:showRulers?RULER_SIZE:0,left:showRulers?RULER_SIZE:0,right:0,bottom:0,flex:"unset",display:"grid",placeItems:"center"}} onContextMenu={e=>e.preventDefault()} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";}} onDrop={onDragDropFile}>
              <div style={{padding:isMobile?10:40}}>
                <canvas ref={canvasRef}
                  style={{display:"block",cursor:rotating?"alias":desktopPanRef.current?"grabbing":resizing?(resizing.corner==="tl"||resizing.corner==="br"?"nwse-resize":"nesw-resize"):dragging?"grabbing":isPanMode?"grab":hoverCursor||"crosshair",touchAction:"none"}}
                  onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={()=>{if(!dragging&&!rotating&&!resizing) onMU();}}
                  onContextMenu={onCtx}
                  onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}/>
              </div>
            </div>
          </div>

          <div style={S.statusBar}>
            <span>{active.label} · {sheetW}"×{sheetH}" @ {sheetDPI}dpi</span>
            {margin>0&&<span style={{color:"#ef4444"}}>{margin}" margin</span>}
            <span style={{color:C.accent,cursor:"pointer",userSelect:"none"}} onClick={()=>{
              const wrap=canvasWrapRef.current;if(!wrap)return;
              const wW=wrap.clientWidth-80,wH=wrap.clientHeight-80;
              const cw=sheetW*SCREEN_DPI*previewScale,ch=sheetH*SCREEN_DPI*previewScale;
              setZoom(Math.min(wW/cw,wH/ch,1));
            }} title="Click to fit view (Ctrl+0)">{Math.round(zoom*100)}%</span>
            {snapToGrid&&<span style={{color:C.greenBright}}>snap {snapSize}"</span>}
            <span>{sheets.length} sheet{sheets.length!==1?"s":""}</span>
            {!showLayers&&!isMobile&&<button style={{fontSize:10,color:C.accent,background:"transparent",border:`1px solid ${C.border}`,borderRadius:4,cursor:"pointer",padding:"2px 8px",marginLeft:4}} onClick={()=>setShowLayers(true)} title="Show layers panel">Layers</button>}
            {updateStatus&&<span style={{fontSize:11,color:"#4ade80",marginLeft:8,fontWeight:"bold"}}>{updateStatus}</span>}
            <span style={{marginLeft:"auto",fontSize:9,color:C.muted}}>Ctrl+Z/Y · Del · Ctrl+D · Ctrl+0</span>
          </div>
        </div>

        {/* ── RIGHT layers (tablet+desktop) ── */}
        {showLayers&&!isMobile&&<div style={S.right}>
          <div style={{...S.panelHead,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <span>Layers · {active.label}</span>
            <button style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontSize:12,padding:"0 4px"}} onClick={()=>setShowLayers(false)} title="Hide layers panel">✕</button>
          </div>
          {layersPanelJsx}
          {isWeb&&<AdSlot variant="sidebar" style={{flexShrink:0,margin:"8px",height:200,maxHeight:200,overflow:"hidden"}}/>}
        </div>}
      </div>

      {/* ── Mobile bottom nav ── */}
      {isMobile&&(
        <div style={S.mobileNav}>
          {[
            {id:"sheet",icon:"⚙",label:"Sheet"},
            {id:"add",icon:"➕",label:"Add"},
            {id:"layers",icon:"☰",label:"Layers"},
            {id:"sheets",icon:"📄",label:"Sheets"},
          ].map(({id,icon,label})=>(
            <button key={id} style={S.mobileNavBtn(drawer===id)} onClick={()=>setDrawer(d=>d===id?null:id)}>
              <span style={{fontSize:18}}>{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Mobile drawers ── */}
      {isMobile&&<>
        <Drawer open={drawer==="sheet"} onClose={()=>setDrawer(null)} title="Sheet Setup">{sheetPanelJsx}</Drawer>
        <Drawer open={drawer==="add"} onClose={()=>setDrawer(null)} title="Image">{addImagePanelJsx}</Drawer>
        <Drawer open={drawer==="layers"} onClose={()=>setDrawer(null)} title={`Layers · ${active.label}`} height="70vh">
          <div style={{display:"flex",flexDirection:"column",height:"100%"}}>{layersPanelJsx}</div>
        </Drawer>
        <Drawer open={drawer==="sheets"} onClose={()=>setDrawer(null)} title={`Sheets (${sheets.length})`} height="60vh">
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {sheets.map(s=>(
              <div key={s.id} style={{...S.slot,background:s.id===activeId?C.selected:C.bg,border:`1px solid ${s.id===activeId?C.accentSolid:C.border}`}} onClick={()=>{switchTab(s.id);setDrawer(null);}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,color:s.id===activeId?C.accent:C.text}}>{s.label}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:1}}>{s.sheetW}"×{s.sheetH}" · {s.sheetDPI}dpi · {s.placements.length} items</div>
                </div>
                <button style={{...S.btn("ghost"),padding:"5px 8px",fontSize:10,minHeight:"unset"}} onClick={e=>duplicateSheet(s.id,e)}>⧉</button>
                <button style={{...S.btn("danger"),padding:"5px 8px",fontSize:10,minHeight:"unset"}} onClick={e=>closeSheet(s.id,e)}>✕</button>
              </div>
            ))}
            <button style={{...S.btn("primary"),width:"100%",padding:"13px"}} onClick={addSheet}>+ New Sheet</button>
          </div>
        </Drawer>
      </>}

      {/* ── Context menu (mobile long-press) ── */}
      <ContextMenu x={ctxMenu.x} y={ctxMenu.y} canvasOnly={ctxMenu.canvasOnly} onClose={()=>setCtxMenu({x:null,y:null})}
        onDelete={()=>{deleteSelected();setCtxMenu({x:null,y:null});}}
        onDuplicate={()=>{duplicateSelected();setCtxMenu({x:null,y:null});}}
        onRotate={deg=>{rotateSelected(deg);setCtxMenu({x:null,y:null});}}
        onFlipH={()=>{flipSelected("h");setCtxMenu({x:null,y:null});}}
        onFlipV={()=>{flipSelected("v");setCtxMenu({x:null,y:null});}}
        onTrim={()=>{trimSelected();setCtxMenu({x:null,y:null});}}
        onCut={()=>{cutSelected();setCtxMenu({x:null,y:null});}}
        onCopy={()=>{copySelected();setCtxMenu({x:null,y:null});}}
        onPaste={()=>{pasteFromClipboard();setCtxMenu({x:null,y:null});}}/>

      {/* Layer context menu */}
      {layerCtx&&(
        <div style={{position:"fixed",inset:0,zIndex:700}} onClick={()=>setLayerCtx(null)}>
          <div style={{position:"absolute",left:Math.min(layerCtx.x,window.innerWidth-170),top:Math.min(layerCtx.y,window.innerHeight-300),background:C.surface2,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden",boxShadow:"0 8px 32px rgba(0,0,0,0.5)",width:175}} onClick={e=>e.stopPropagation()}>
            {(layerCtx.type==="empty"?[
              {label:"➕ Image",fn:()=>{setLeftTab("add");if(isMobile)setDrawer("add");setLayerCtx(null);}},
              {label:"📁 New Group",fn:()=>{addEmptyGroup();setLayerCtx(null);}},
            ]:layerCtx.type==="group"?[
              {label:"✏ Rename",fn:()=>{const g=groups.find(g=>g.id===layerCtx.groupId);if(g){setEditingGroupId(g.id);setEditingGroupName(g.name);}setLayerCtx(null);}},
              {label:"⊕ Duplicate Group",fn:()=>{duplicateGroup(layerCtx.groupId);setLayerCtx(null);}},
              {label:"✕ Delete Group",fn:()=>{deleteGroup(layerCtx.groupId);setLayerCtx(null);},danger:true},
            ]:[
              {label:"✏ Rename",fn:()=>{const p=placements.find(p=>p.id===layerCtx.id);setEditingPlacementId(layerCtx.id);setEditingPlacementName(p?.name||"");setLayerCtx(null);}},
              {label:"↻ Rotate 90°",fn:()=>{setSelected(layerCtx.id);rotateSelected(90);setLayerCtx(null);}},
              {label:"↺ Rotate −90°",fn:()=>{setSelected(layerCtx.id);rotateSelected(-90);setLayerCtx(null);}},
              {label:"↔ Flip H",fn:()=>{setSelected(layerCtx.id);flipSelected("h");setLayerCtx(null);}},
              {label:"↕ Flip V",fn:()=>{setSelected(layerCtx.id);flipSelected("v");setLayerCtx(null);}},
              {label:"✂ Trim Transparent",fn:()=>{setSelected(layerCtx.id);setTimeout(()=>trimSelected(),0);setLayerCtx(null);}},
              {label:"⊕ Duplicate",fn:()=>{setSelected(layerCtx.id);setTimeout(()=>duplicateSelected(),0);setLayerCtx(null);}},
              {label:"✕ Delete",fn:()=>{setSelected(layerCtx.id);setTimeout(()=>deleteSelected(),0);setLayerCtx(null);},danger:true},
            ]).map(({label,fn,danger})=>(
              <div key={label} onClick={fn} style={{padding:"10px 14px",fontSize:12,color:danger?C.red:C.text,cursor:"pointer",borderBottom:`1px solid ${C.border}`}}>{label}</div>
            ))}
          </div>
        </div>
      )}

      {/* Tab context menu */}
      {tabCtx&&(
        <div style={{position:"fixed",inset:0,zIndex:700}} onClick={()=>setTabCtx(null)}>
          <div style={{position:"absolute",left:Math.min(tabCtx.x,window.innerWidth-150),top:Math.min(tabCtx.y,window.innerHeight-120),background:C.surface2,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden",boxShadow:"0 8px 32px rgba(0,0,0,0.5)",width:140}} onClick={e=>e.stopPropagation()}>
            {[
              {label:"✏ Rename",fn:()=>{const s=sheets.find(s=>s.id===tabCtx.sheetId);if(s)startRenameTab(tabCtx.sheetId,s.label,{stopPropagation:()=>{}});setTabCtx(null);}},
              {label:"⧉ Duplicate",fn:()=>{duplicateSheet(tabCtx.sheetId,{stopPropagation:()=>{}});setTabCtx(null);}},
              {label:"✕ Delete",fn:()=>{if(sheets.length>1)closeSheet(tabCtx.sheetId,{stopPropagation:()=>{}});setTabCtx(null);},danger:true},
            ].map(({label,fn,danger})=>(
              <div key={label} onClick={fn} style={{padding:"10px 14px",fontSize:12,color:danger?C.red:C.text,cursor:"pointer",borderBottom:`1px solid ${C.border}`}}>{label}</div>
            ))}
          </div>
        </div>
      )}

      {/* Resize tooltip */}
      {resizeTooltip&&(
        <div style={{position:"fixed",left:resizeTooltip.x,top:resizeTooltip.y,background:C.surface2,border:`1px solid ${C.border}`,borderRadius:5,padding:"4px 8px",fontSize:10,color:C.text,zIndex:600,pointerEvents:"none",boxShadow:"0 4px 12px rgba(0,0,0,0.4)",whiteSpace:"nowrap"}}>
          {resizeTooltip.w.toFixed(2)}" × {resizeTooltip.h.toFixed(2)}"
        </div>
      )}

      {/* Close tab confirmation */}
      {confirmDelete&&(
        <div style={S.modal} onClick={()=>setConfirmDelete(null)}>
          <div style={{...S.modalBox,width:isMobile?"90vw":320}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}><span style={{fontSize:13,fontWeight:700,color:C.red}}>Delete</span></div>
            <div style={{padding:"16px 18px"}}>
              <div style={{fontSize:13,color:C.text,marginBottom:12}}>Delete {confirmDelete.label}?</div>
              <div style={{display:"flex",gap:8}}>
                <button style={{...S.btn("danger"),flex:1}} onClick={()=>confirmDelete.groupId?doDeleteGroup(confirmDelete.groupId):doDelete(confirmDelete.ids)}>Delete</button>
                <button style={{...S.btn("ghost"),flex:1}} onClick={()=>setConfirmDelete(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {confirmClose&&(()=>{
        const cs=sheets.find(s=>s.id===confirmClose.sheetId);
        const csArea=cs?sqIn(cs.placements):0;
        return <div style={S.modal} onClick={()=>setConfirmClose(null)}>
          <div style={{...S.modalBox,width:isMobile?"90vw":340}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}><span style={{fontSize:13,fontWeight:700,color:C.accent}}>Close Sheet</span></div>
            <div style={{padding:"16px 18px"}}>
              <div style={{fontSize:13,color:C.text,marginBottom:6}}>Close <strong>"{confirmClose.label}"</strong>?</div>
              {confirmClose.hasContent&&<div style={{fontSize:11,color:C.amber,marginBottom:12}}>This sheet has {cs?.placements?.length||0} placed items ({csArea.toFixed(1)} sq in) that will be removed.</div>}
              {!confirmClose.hasContent&&<div style={{fontSize:11,color:C.muted,marginBottom:12}}>This sheet is empty.</div>}
              <div style={{display:"flex",gap:8}}>
                <button style={{...S.btn("danger"),flex:1}} onClick={()=>doCloseSheet(confirmClose.sheetId)}>Close</button>
                <button style={{...S.btn("ghost"),flex:1}} onClick={()=>setConfirmClose(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>;
      })()}
      {showShortcuts&&(
        <div style={S.modal} onClick={()=>setShowShortcuts(false)}>
          <div style={{...S.modalBox,width:isMobile?"90vw":360}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalHead}>
              <span style={{fontSize:13,fontWeight:700,color:C.accent}}>Keyboard Shortcuts</span>
              <button style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16,padding:0}} onClick={()=>setShowShortcuts(false)}>✕</button>
            </div>
            <div style={{padding:"12px 18px",fontSize:11,color:C.text}}>
              {[
                ["V","Select tool"],["H","Pan / Hand tool"],["Del / Backspace","Delete selected"],
                ["Ctrl+X","Cut"],["Ctrl+C","Copy"],["Ctrl+V","Paste"],["Ctrl+D","Duplicate"],
                ["Ctrl+A","Select all (cycles group → all)"],
                ["Ctrl+Z","Undo"],["Ctrl+Y / Ctrl+Shift+Z","Redo"],
                ["Ctrl+0","Fit view"],["Ctrl+G","Toggle grid"],["Ctrl+R","Toggle rulers"],
                ["Arrow keys","Nudge selected"],["Shift + Arrows","Nudge 10×"],
                ["?","This dialog"],
              ].map(([key,desc])=><div key={key} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${C.border}`}}>
                <span style={{fontFamily:"monospace",fontSize:10,color:C.accent,minWidth:140}}>{key}</span>
                <span style={{color:C.muted,textAlign:"right"}}>{desc}</span>
              </div>)}
            </div>
          </div>
        </div>
      )}

      {modalsJsx}
    </div>
  );
}
