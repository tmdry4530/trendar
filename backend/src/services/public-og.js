import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { escapeXml } from '../utils/public-output.js';
import { createTtlCache } from '../utils/ttl-cache.js';
import { formatDailyRate } from './public-badge.js';

const FONT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
export const OG_FONT_PATHS = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf', 'IBMPlexMono-Medium.ttf'].map((file) => resolve(FONT_DIR, file));
export const RESVG_WASM_PATH = createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');

const WIDTH = 1200;
const HEIGHT = 630;
const BG = '#0d0f12';
const ACCENT = '#3ddc84';
const TEXT = '#e6e9ef';
const MUTED = '#8b93a1';
const FAINT = '#5b6472';
const LINE = '#232830';
const SANS = 'IBM Plex Sans';
const MONO = 'IBM Plex Mono';
const ESTIMATED = new Set(['creation', 'partial']);

function truncate(value, max) {
  const chars = [...String(value ?? '')];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function text(content, { x, y, size, family = SANS, weight = 400, fill = TEXT, anchor = 'start', spacing }) {
  const letterSpacing = spacing == null ? '' : ` letter-spacing="${spacing}"`;
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${letterSpacing}>${content}</text>`;
}

function formatUtc(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function rateMarkup(rate, baselineSource, estSize) {
  const estimate = ESTIMATED.has(baselineSource) ? `<tspan dx="${Math.round(estSize / 2.5)}" fill="${MUTED}" font-size="${estSize}">est.</tspan>` : '';
  return `${escapeXml(formatDailyRate(rate))}${estimate}`;
}

function frame(body, footer) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>`
    + `<rect width="${WIDTH}" height="6" fill="${ACCENT}"/>`
    + `<circle cx="94" cy="80" r="16" fill="none" stroke="${ACCENT}" stroke-width="3"/><circle cx="94" cy="80" r="7" fill="none" stroke="${ACCENT}" stroke-width="2"/><circle cx="94" cy="80" r="2.5" fill="${ACCENT}"/>`
    + text('Trendar', { x: 124, y: 91, size: 32, weight: 600 })
    + text('Rising GitHub repos', { x: 1120, y: 90, size: 22, family: MONO, weight: 500, fill: MUTED, anchor: 'end' })
    + body
    + `<line x1="80" y1="560" x2="1120" y2="560" stroke="${LINE}" stroke-width="2"/>`
    + (footer ? text(escapeXml(footer), { x: 80, y: 598, size: 20, family: MONO, weight: 500, fill: FAINT }) : '')
    + '</svg>';
}

export function feedOgSvg({ feedName, rows = [], updatedAt = null } = {}) {
  let body = text('TRENDING', { x: 80, y: 160, size: 22, family: MONO, weight: 500, fill: ACCENT, spacing: 3 })
    + text(escapeXml(truncate(feedName, 34)), { x: 80, y: 222, size: 56, weight: 600 });
  const top = rows.slice(0, 5);
  if (top.length === 0) {
    body += text('Collecting data', { x: 80, y: 360, size: 34, fill: MUTED });
  }
  top.forEach((row, index) => {
    const y = 300 + index * 56;
    body += text(`#${escapeXml(row.rank ?? index + 1)}`, { x: 80, y, size: 26, family: MONO, weight: 500, fill: FAINT })
      + text(escapeXml(truncate(row.full_name, 40)), { x: 150, y, size: 30 })
      + text(rateMarkup(row.rate_24h, row.baseline_source, 20), { x: 1120, y, size: 28, family: MONO, weight: 500, fill: ACCENT, anchor: 'end' });
    if (index < top.length - 1) body += `<line x1="80" y1="${y + 20}" x2="1120" y2="${y + 20}" stroke="${LINE}" stroke-width="1"/>`;
  });
  const updated = formatUtc(updatedAt);
  return frame(body, updated ? `Updated ${updated}` : 'trendar');
}

export function repoOgSvg({ full_name, stars, rate_24h = null, baseline_source = null, bestLabel = null } = {}) {
  const fullName = String(full_name ?? '');
  const slash = fullName.indexOf('/');
  const owner = slash === -1 ? '' : fullName.slice(0, slash);
  const name = slash === -1 ? fullName : fullName.slice(slash + 1);
  let body = '';
  if (owner) body += text(`${escapeXml(truncate(owner, 48))} /`, { x: 80, y: 190, size: 34, fill: MUTED });
  body += text(escapeXml(truncate(name, 30)), { x: 80, y: 268, size: 64, weight: 600 });
  if (bestLabel) {
    const label = truncate(bestLabel, 48);
    const pillWidth = Math.round([...label].length * 14.5) + 40;
    body += `<rect x="80" y="300" width="${pillWidth}" height="44" rx="22" fill="none" stroke="${ACCENT}" stroke-width="2"/>`
      + text(escapeXml(label), { x: 100, y: 330, size: 24, family: MONO, weight: 500, fill: ACCENT });
  }
  const starsValue = Number.isFinite(Number(stars)) ? Math.round(Number(stars)).toLocaleString('en-US') : '-';
  body += text('TOTAL STARS', { x: 80, y: 420, size: 20, family: MONO, weight: 500, fill: MUTED, spacing: 2 })
    + text(escapeXml(starsValue), { x: 80, y: 494, size: 60, weight: 600 })
    + text('PER DAY', { x: 560, y: 420, size: 20, family: MONO, weight: 500, fill: MUTED, spacing: 2 })
    + (rate_24h == null
      ? text('collecting data', { x: 560, y: 488, size: 36, fill: MUTED })
      : text(rateMarkup(rate_24h, baseline_source, 26), { x: 560, y: 492, size: 54, family: MONO, weight: 500, fill: ACCENT }));
  return frame(body, 'Live GitHub star velocity on Trendar');
}

let wasmReady = null;

function ensureWasm(wasmPath) {
  if (!wasmReady) {
    wasmReady = readFile(wasmPath).then((bytes) => initWasm(bytes)).catch((error) => {
      wasmReady = null;
      throw error;
    });
  }
  return wasmReady;
}

export function createResvgPngRenderer({ wasmPath = RESVG_WASM_PATH, fontPaths = OG_FONT_PATHS } = {}) {
  for (const path of [wasmPath, ...fontPaths]) {
    if (!existsSync(path)) throw new Error(`OG asset missing: ${path}`);
  }
  let fontsReady = null;
  function loadFonts() {
    if (!fontsReady) {
      fontsReady = Promise.all(fontPaths.map((path) => readFile(path))).catch((error) => {
        fontsReady = null;
        throw error;
      });
    }
    return fontsReady;
  }
  return async function renderPng(svg) {
    const [, fontBuffers] = await Promise.all([ensureWasm(wasmPath), loadFonts()]);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: WIDTH },
      font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: SANS, sansSerifFamily: SANS, monospaceFamily: MONO },
    });
    try {
      const image = resvg.render();
      try {
        return Buffer.from(image.asPng());
      } finally {
        image.free();
      }
    } finally {
      resvg.free();
    }
  };
}

// A process-wide token bucket limits bursts to five and sustains one fresh
// render per second, even across IPs/renderers. Cached and generic images are free.
const RENDER_BURST_CAPACITY = 5;
const TOKEN_REFILL_MS = 1000;
const BUDGET_EXHAUSTED = new Error('OG fresh-render budget exhausted');
let renderTokens = RENDER_BURST_CAPACITY;
let lastTokenRefillAt = Date.now();

function takeRenderBudget() {
  const time = Date.now();
  renderTokens = Math.min(RENDER_BURST_CAPACITY, renderTokens + Math.max(0, time - lastTokenRefillAt) / TOKEN_REFILL_MS);
  lastTokenRefillAt = time;
  if (renderTokens < 1) return false;
  renderTokens -= 1;
  return true;
}

function genericOgSvg() {
  return frame(
    text('Discover what is rising.', { x: 80, y: 280, size: 60, weight: 600 })
      + text('Trending GitHub projects on Trendar', { x: 80, y: 370, size: 32, fill: MUTED }),
    'Live GitHub star velocity on Trendar',
  );
}

export function createOgRenderer({ renderPng, fallbackPng, maxEntries = 2000, log = console }) {
  const cache = createTtlCache({ ttlMs: Infinity, maxEntries });
  let genericPng = null;

  // Memoize both success and failure: unknown URLs must never cause fresh work.
  // fallbackPng remains the supplied static image, used only if resvg fails.
  function getFallbackPng() {
    if (!genericPng) {
      genericPng = setImmediate().then(() => renderPng(genericOgSvg())).catch((error) => {
        log.error('[public] generic og render failed', { message: error?.message });
        return fallbackPng;
      });
    }
    return genericPng;
  }

  async function render({ key, revision, svg }) {
    try {
      const buffer = await cache.getOrCompute(`${key}:${revision}`, async () => {
        if (!takeRenderBudget()) throw BUDGET_EXHAUSTED;
        await setImmediate();
        return renderPng(svg);
      });
      return { buffer, fallback: false };
    } catch (error) {
      if (error !== BUDGET_EXHAUSTED) log.error('[public] og render failed', { key, message: error?.message });
      return { buffer: await getFallbackPng(), fallback: true };
    }
  }
  return { render, fallbackPng, getFallbackPng };
}
