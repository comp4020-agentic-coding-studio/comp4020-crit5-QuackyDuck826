// Canvas rendering — reads GameState, never mutates it. Trails are drawn
// procedurally from angle + direction rather than stored history, so state
// stays plain data.
import {
  EFFECT_DURATION,
  HAZARD_RADIUS_FRACTION,
  hazardLifeFraction,
  isTelegraphing,
  PLAYER_RADIUS_FRACTION,
  warningProgress,
  type Effect,
  type GameState,
  type Hazard,
  type PendingSpawn,
} from "./game";

type Rgb = readonly [number, number, number];

const COLORS = {
  bg: [5, 6, 10] as Rgb,
  ring: [150, 220, 255] as Rgb,
  player: [123, 232, 255] as Rgb,
  danger: [255, 106, 61] as Rgb,
  score: [200, 230, 255] as Rgb,
  closeCall: [110, 255, 210] as Rgb,
  lastSecond: [255, 221, 90] as Rgb,
};

function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a))})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// A hazard is born red, ages through orange into yellow over its lifetime,
// then (via the telegraph alpha below) fades out — so its color alone tells
// you how much longer it's safe to treat as a threat.
const HAZARD_COLOR_STOPS: ReadonlyArray<readonly [number, Rgb]> = [
  [0, [255, 70, 50]],
  [0.5, [255, 150, 40]],
  [1, [255, 225, 70]],
];

function hazardColor(ageFraction: number): Rgb {
  const t = clamp(ageFraction, 0, 1);
  for (let i = 0; i < HAZARD_COLOR_STOPS.length - 1; i++) {
    const [t0, c0] = HAZARD_COLOR_STOPS[i];
    const [t1, c1] = HAZARD_COLOR_STOPS[i + 1];
    if (t <= t1) {
      const localT = (t - t0) / (t1 - t0);
      return [lerp(c0[0], c1[0], localT), lerp(c0[1], c1[1], localT), lerp(c0[2], c1[2], localT)];
    }
  }
  return HAZARD_COLOR_STOPS[HAZARD_COLOR_STOPS.length - 1][1];
}

function pointOn(center: number, radius: number, angle: number): [number, number] {
  return [center + radius * Math.cos(angle), center + radius * Math.sin(angle)];
}

function ringAlphaFor(state: GameState): number {
  if (!state.gameOver || state.gameOverAt == null) return 1;
  const elapsed = state.time - state.gameOverAt;
  const fade = clamp((elapsed - 0.2) / 0.8, 0, 1);
  return 1 - fade;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A fixed field of background stars, positioned by hashing the index rather
// than Math.random(), so the same star sits in the same spot every frame —
// only their twinkle (driven by state.time) moves.
const STAR_COUNT = 70;

function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function drawStarField(
  ctx: CanvasRenderingContext2D,
  time: number,
  count: number,
  width: number,
  height: number,
  scale: number,
) {
  for (let i = 0; i < count; i++) {
    const fx = hash(i * 1.618);
    const fy = hash(i * 2.718 + 4.2);
    const hue = hash(i * 3.14) * 360;
    const twinkle = 0.5 + 0.5 * Math.sin(time * (0.5 + fx) + i * 3.1);
    ctx.fillStyle = rgba(hslToRgb(hue, 0.45, 0.82), 0.12 + twinkle * 0.35);
    ctx.beginPath();
    ctx.arc(fx * width, fy * height, scale * (0.0012 + fy * 0.0022), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStars(ctx: CanvasRenderingContext2D, state: GameState, size: number) {
  drawStarField(ctx, state.time, STAR_COUNT, size, size, size);
}

// The game canvas is a centered square (it needs equal-radius orbit math), so
// on a widescreen window there's letterboxed space to either side of it. This
// draws the same star language across that full window rectangle on a
// separate canvas behind the game one, so the margins aren't just flat bg.
export function drawAmbientStars(
  ctx: CanvasRenderingContext2D,
  time: number,
  width: number,
  height: number,
) {
  ctx.clearRect(0, 0, width, height);
  const scale = Math.min(width, height);
  const count = Math.round(STAR_COUNT * ((width * height) / (scale * scale)));
  drawStarField(ctx, time, count, width, height, scale);
}

// What everything else orbits: a shaded core whose own boundary and inner
// contours warp continuously (two overlapping sine waves per layer, phase
// driven by state.time) — a liquid ripple across the surface itself, not a
// pulse of rings expanding outward. It also breathes (slow size oscillation)
// and drifts through hues (slow color cycle) on top of that ripple texture.
const PLANET_SEGMENTS = 72;
const PLANET_RIPPLE_LAYERS = 3;
const PLANET_BREATHE_PERIOD = 9;
const PLANET_HUE_PERIOD = 45;

function warpedRadiusAt(
  baseRadius: number,
  angle: number,
  time: number,
  phase: number,
  ampScale = 1,
  freqScale = 1,
  speedScale = 1,
): number {
  // Snapping to a whole number of lobes around the circle keeps the shape a
  // closed ring — a non-integer frequency would make angle 2π land on a
  // different radius than angle 0, tearing the path open right where it
  // closes (angle 0, the right side of the ring).
  const lobes1 = Math.max(1, Math.round(3 * freqScale));
  const lobes2 = Math.max(1, Math.round(5 * freqScale));
  const w1 = Math.sin(angle * lobes1 + time * 1.1 * speedScale + phase) * 0.06 * ampScale;
  const w2 = Math.sin(angle * lobes2 - time * 0.7 * speedScale + phase * 1.4) * 0.03 * ampScale;
  return baseRadius * (1 + w1 + w2);
}

// General warped-circle tracer, centered anywhere — the planet's surface,
// the play ring, the ambient noodle rings, and effect bursts all reuse this
// so every warp in the scene shares the same liquid-ripple language.
function traceWarpedCircleAt(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  baseRadius: number,
  time: number,
  phase: number,
  ampScale = 1,
  freqScale = 1,
  speedScale = 1,
) {
  ctx.beginPath();
  for (let i = 0; i <= PLANET_SEGMENTS; i++) {
    const angle = (i / PLANET_SEGMENTS) * Math.PI * 2;
    const r = warpedRadiusAt(baseRadius, angle, time, phase, ampScale, freqScale, speedScale);
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function traceWarpedCircle(
  ctx: CanvasRenderingContext2D,
  center: number,
  baseRadius: number,
  time: number,
  phase: number,
  ampScale = 1,
  freqScale = 1,
  speedScale = 1,
) {
  traceWarpedCircleAt(ctx, center, center, baseRadius, time, phase, ampScale, freqScale, speedScale);
}

function drawPlanet(ctx: CanvasRenderingContext2D, state: GameState, center: number, radius: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const breathe = 1 + 0.1 * Math.sin((state.time / PLANET_BREATHE_PERIOD) * Math.PI * 2);
  const liveRadius = radius * breathe;
  const hue = (state.time / PLANET_HUE_PERIOD) * 360;
  const core = hslToRgb(hue, 0.6, 0.62);
  const edge = hslToRgb(hue + 30, 0.55, 0.09);

  ctx.shadowColor = rgba(core, 0.55);
  ctx.shadowBlur = liveRadius * 0.4;

  const gradient = ctx.createRadialGradient(
    center - liveRadius * 0.35,
    center - liveRadius * 0.35,
    liveRadius * 0.05,
    center,
    center,
    liveRadius,
  );
  gradient.addColorStop(0, rgba(core, 1));
  gradient.addColorStop(1, rgba(edge, 1));
  ctx.fillStyle = gradient;
  traceWarpedCircle(ctx, center, liveRadius, state.time, 0);
  ctx.fill();

  ctx.shadowBlur = 0;
  for (let i = 1; i <= PLANET_RIPPLE_LAYERS; i++) {
    const layerRadius = liveRadius * (1 - i * 0.24);
    const phase = i * 1.9 + state.time * 0.35;
    traceWarpedCircle(ctx, center, layerRadius, state.time, phase);
    ctx.strokeStyle = rgba(COLORS.ring, 0.16);
    ctx.lineWidth = Math.max(1, liveRadius * 0.012);
    ctx.stroke();
  }

  ctx.restore();
}

// Ambient, thick, noodle-like rings warping in and out of the play area — one
// tucked between the planet and the orbit path, two drifting past it toward
// the canvas edge — sharing the planet's ripple language so the whole scene
// reads as one living, wobbly thing rather than a rigid track with a blob in
// the middle. Kept to just a few (fewer, bigger wobbles rather than a tangle
// of thin curly ones) and each a distinctly different thickness, so they
// read as a handful of fat cosmic noodles instead of clutter. Each ring
// drifts through its own slow hue for a candy, many-colored feel.
const NOODLE_HUE_PERIOD = 30;

interface NoodleRing {
  radiusFraction: number; // of ringRadius
  widthFraction: number; // of ringRadius
  ampScale: number;
  freqScale: number;
  speedScale: number;
  phase: number;
  hueOffset: number;
  alpha: number;
}

// Each ring's max possible reach (radiusFraction * (1 + worst-case wobble) +
// half its own width) is kept comfortably under ~1.39 — the distance from
// center to the canvas edge, in ringRadius units, since the canvas is
// always sized to the smaller viewport dimension — so no noodle gets
// clipped by the screen edge.
const NOODLE_RINGS: readonly NoodleRing[] = [
  { radiusFraction: 0.62, widthFraction: 0.09, ampScale: 1.4, freqScale: 0.55, speedScale: 0.5, phase: 0.6, hueOffset: 30, alpha: 0.14 },
  { radiusFraction: 1.1, widthFraction: 0.22, ampScale: 1.15, freqScale: 0.45, speedScale: -0.4, phase: 3.1, hueOffset: 200, alpha: 0.13 },
  { radiusFraction: 1.22, widthFraction: 0.05, ampScale: 0.8, freqScale: 0.65, speedScale: 0.35, phase: 5.2, hueOffset: 300, alpha: 0.1 },
];

// Rings start switched off and reveal one at a time as the score climbs, so
// the scene visibly fills in over a run instead of showing everything from
// the first second. Each unlocks NOODLE_REVEAL_SCORE_STEP points after the
// last (innermost first) and fades in over NOODLE_REVEAL_FADE_RANGE points
// rather than popping in on the exact threshold.
const NOODLE_REVEAL_SCORE_STEP = 100;
const NOODLE_REVEAL_FADE_RANGE = 20;

// The soft glow band hugging the orbit line (drawn in render(), not part of
// NOODLE_RINGS) joins the same build-up: hidden at the start, fading in
// alongside the first noodle ring rather than being visible from frame one.
function ringGlowRevealFor(state: GameState): number {
  return clamp((state.score - NOODLE_REVEAL_SCORE_STEP) / NOODLE_REVEAL_FADE_RANGE, 0, 1);
}

function drawNoodleRings(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  center: number,
  ringRadius: number,
  alpha: number,
) {
  if (alpha <= 0.02) return;
  ctx.save();
  for (let i = 0; i < NOODLE_RINGS.length; i++) {
    const ring = NOODLE_RINGS[i];
    const unlockScore = (i + 1) * NOODLE_REVEAL_SCORE_STEP;
    const reveal = clamp((state.score - unlockScore) / NOODLE_REVEAL_FADE_RANGE, 0, 1);
    if (reveal <= 0) continue;
    const hue = (state.time / NOODLE_HUE_PERIOD) * 360 + ring.hueOffset;
    const color = hslToRgb(hue, 0.55, 0.62);
    ctx.strokeStyle = rgba(color, alpha * ring.alpha * reveal);
    ctx.lineWidth = ringRadius * ring.widthFraction;
    traceWarpedCircle(
      ctx,
      center,
      ringRadius * ring.radiusFraction,
      state.time,
      ring.phase,
      ring.ampScale,
      ring.freqScale,
      ring.speedScale,
    );
    ctx.stroke();
  }
  ctx.restore();
}

// After a direction reversal, the trail regrows from the player outward
// (closest segment first) instead of the full trail snapping onto the other
// side, so a reversal reads as the trail starting fresh, not flipping.
const TRAIL_SEGMENTS = 8;
const TRAIL_GROW_DURATION = 0.35;

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  center: number,
  ringRadius: number,
  alpha: number,
) {
  const r = ringRadius * PLAYER_RADIUS_FRACTION;
  const sinceReversal =
    state.lastReversedAt === null ? Infinity : state.time - state.lastReversedAt;
  for (let i = TRAIL_SEGMENTS; i >= 1; i--) {
    const segmentDelay = ((i - 1) / TRAIL_SEGMENTS) * TRAIL_GROW_DURATION;
    const segmentGrowth = clamp(
      (sinceReversal - segmentDelay) / (TRAIL_GROW_DURATION / TRAIL_SEGMENTS),
      0,
      1,
    );
    if (segmentGrowth <= 0) continue;
    const trailAngle = state.playerAngle - state.playerDirection * i * 0.045;
    const wobble = Math.sin(state.time * 9 - i * 1.4);
    const flicker = 0.75 + 0.25 * Math.sin(state.time * 6 - i * 0.9);
    const [x, y] = pointOn(center, ringRadius + wobble * r * 0.5, trailAngle);
    ctx.fillStyle = rgba(COLORS.player, alpha * (0.4 - i * 0.04) * flicker * segmentGrowth);
    ctx.beginPath();
    ctx.arc(x, y, r * (1 - i * 0.07) * flicker * segmentGrowth, 0, Math.PI * 2);
    ctx.fill();
  }
  const [px, py] = pointOn(center, ringRadius, state.playerAngle);
  ctx.save();
  ctx.shadowColor = rgba(COLORS.player, alpha * 0.9);
  ctx.shadowBlur = r * 2.2;
  ctx.fillStyle = rgba(COLORS.player, alpha);
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  heading: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  ctx.beginPath();
  ctx.moveTo(r * 1.3, 0);
  ctx.lineTo(-r * 0.9, r * 0.9);
  ctx.lineTo(-r * 0.9, -r * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawDiamond(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rotation: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation + Math.PI / 4);
  ctx.fillRect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
  ctx.restore();
}

function drawHazard(ctx: CanvasRenderingContext2D, hazard: Hazard, state: GameState, center: number, ringRadius: number) {
  const lifeFraction = hazardLifeFraction(hazard, state.time);
  const telegraphing = isTelegraphing(hazard, state.time);
  const scale = telegraphing ? Math.max(0.15, lifeFraction / 0.2) : 1;
  const alpha = telegraphing ? Math.max(0.12, lifeFraction / 0.2) : 1;
  const color = hazardColor(1 - lifeFraction);
  const r = ringRadius * HAZARD_RADIUS_FRACTION * scale;
  const [x, y] = pointOn(center, ringRadius, hazard.angle);

  ctx.save();
  ctx.shadowColor = rgba(color, alpha * 0.8);
  ctx.shadowBlur = r * 1.8;

  if (hazard.kind === "moving") {
    for (let i = 4; i >= 1; i--) {
      const trailAngle = hazard.angle - hazard.direction * i * 0.05;
      const wobble = Math.sin(state.time * 7 + hazard.id * 1.7 - i * 1.1);
      const flicker = 0.7 + 0.3 * Math.sin(state.time * 5 + hazard.id - i * 0.8);
      const [tx, ty] = pointOn(center, ringRadius + wobble * r * 0.4, trailAngle);
      ctx.fillStyle = rgba(color, alpha * (0.28 - i * 0.045) * flicker);
      ctx.beginPath();
      ctx.arc(tx, ty, r * 0.6 * flicker, 0, Math.PI * 2);
      ctx.fill();
    }
    const heading = hazard.angle + hazard.direction * (Math.PI / 2);
    drawTriangle(ctx, x, y, r, heading, rgba(color, alpha));
  } else {
    // Rotate to the hazard's own position on the ring, so it reads as sitting
    // on the orbit path rather than just stamped over it.
    drawDiamond(ctx, x, y, r, hazard.angle, rgba(color, alpha));
  }
  ctx.restore();
}

// The warning: a large ring at the hazard's future spot that shrinks down to
// its actual size by the time it spawns, so a new hazard never appears
// without notice.
const WARNING_START_SCALE = 6;

function drawPendingSpawn(
  ctx: CanvasRenderingContext2D,
  pending: PendingSpawn,
  state: GameState,
  center: number,
  ringRadius: number,
) {
  const progress = warningProgress(pending, state.time);
  const targetR = ringRadius * HAZARD_RADIUS_FRACTION;
  const r = targetR * WARNING_START_SCALE + (targetR - targetR * WARNING_START_SCALE) * progress;
  const alpha = 0.18 + 0.32 * progress;
  const [x, y] = pointOn(center, ringRadius, pending.angle);

  ctx.strokeStyle = rgba(COLORS.danger, alpha);
  ctx.lineWidth = Math.max(1, ringRadius * 0.006);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

// The "+N" popup drifting outward as an effect fades. The close-call version
// passes a nonzero bounce for a squash-and-stretch pop; last-second stays flat.
function drawEffectLabel(
  ctx: CanvasRenderingContext2D,
  effect: Effect,
  color: Rgb,
  fade: number,
  t: number,
  center: number,
  ringRadius: number,
  bounce = 0,
) {
  const [lx, ly] = pointOn(center, ringRadius * (1 + 0.14 * t), effect.angle);
  ctx.shadowBlur = 0;
  ctx.fillStyle = rgba(color, fade);
  ctx.font = `700 ${Math.round(ringRadius * 0.09)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (bounce === 0) {
    ctx.fillText(`+${effect.amount}`, lx, ly);
    return;
  }
  ctx.save();
  ctx.translate(lx, ly);
  ctx.scale(1 + bounce, 1 - bounce * 0.6);
  ctx.fillText(`+${effect.amount}`, 0, 0);
  ctx.restore();
}

// A jagged, flickering star burst — angular and electric, unlike the soft
// noodle-warp used everywhere else — for the zap-like hazard-dodge effect.
// The flicker is quantized to ~10 steps/sec (not continuous) so it stutters
// like a spark rather than smoothly wobbling.
function drawZapRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  baseRadius: number,
  time: number,
  seed: number,
  spikes: number,
) {
  const flickerStep = Math.floor(time * 10);
  const segments = spikes * 2;
  ctx.beginPath();
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const isSpike = i % 2 === 0;
    const jitter = 1 + (hash(seed + i * 3.3 + flickerStep * 0.7) - 0.5) * 0.18;
    const r = baseRadius * (isSpike ? 1.3 : 0.8) * jitter;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// A jagged lightning-bolt line from (x, y) out along `angle`, instead of a
// plain spark ray — zigzagging sideways, tapering to a point at the tip.
function drawZapBolt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  len: number,
  seed: number,
) {
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const perpX = -dirY;
  const perpY = dirX;
  const segments = 4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (let s = 1; s <= segments; s++) {
    const along = s / segments;
    const jag = (hash(seed + s * 7.1) - 0.5) * len * 0.4 * (1 - along);
    const px = x + dirX * len * along + perpX * jag;
    const py = y + dirY * len * along + perpY * jag;
    ctx.lineTo(px, py);
  }
}

// A last-second reversal gets a hot, jagged zap — a flickering spiky burst
// with zigzagging lightning bolts, because that was a real, deliberate
// dodge and should read as sharp and electric, not soft like a close call.
function drawLastSecondEffect(
  ctx: CanvasRenderingContext2D,
  effect: Effect,
  state: GameState,
  center: number,
  ringRadius: number,
) {
  const t = clamp((state.time - effect.triggeredAt) / EFFECT_DURATION, 0, 1);
  const color = COLORS.lastSecond;
  const fade = 1 - t;
  const [x, y] = pointOn(center, ringRadius, effect.angle);

  ctx.save();
  ctx.shadowColor = rgba(color, fade * 0.8);
  ctx.shadowBlur = ringRadius * 0.08;

  const shockR = ringRadius * (0.05 + 0.24 * t);
  ctx.strokeStyle = rgba(color, fade * 0.9);
  ctx.lineWidth = Math.max(1, ringRadius * 0.02 * fade);
  drawZapRing(ctx, x, y, shockR, state.time, effect.id * 4.1, 7);
  ctx.stroke();

  const boltCount = 6;
  const boltLen = ringRadius * (0.07 + 0.18 * t);
  for (let i = 0; i < boltCount; i++) {
    const a = (i / boltCount) * Math.PI * 2 + t * 1.6;
    ctx.strokeStyle = rgba(color, fade * 0.85);
    ctx.lineWidth = Math.max(1, ringRadius * 0.015 * fade);
    drawZapBolt(ctx, x, y, a, boltLen, effect.id * 9.3 + i * 5.7);
    ctx.stroke();
  }

  drawEffectLabel(ctx, effect, color, fade, t, center, ringRadius);
  ctx.restore();
}

// A close call gets a playful poof, not a hit-spark — you were fine, so it
// reads as a giggle rather than a scare: a wobbly, noodle-warped burst ring
// (the same liquid-ripple language as the planet and the ambient rings)
// with a handful of bubbles spiralling outward and popping as they fade.
const CLOSE_CALL_BUBBLES = 7;

function drawCloseCallEffect(
  ctx: CanvasRenderingContext2D,
  effect: Effect,
  state: GameState,
  center: number,
  ringRadius: number,
) {
  const t = clamp((state.time - effect.triggeredAt) / EFFECT_DURATION, 0, 1);
  const color = COLORS.closeCall;
  const fade = 1 - t;
  const [x, y] = pointOn(center, ringRadius, effect.angle);

  ctx.save();
  ctx.shadowColor = rgba(color, fade * 0.8);
  ctx.shadowBlur = ringRadius * 0.07;

  const burstR = ringRadius * (0.04 + 0.2 * t);
  ctx.strokeStyle = rgba(color, fade * 0.7);
  ctx.lineWidth = Math.max(1, ringRadius * 0.022 * fade);
  traceWarpedCircleAt(ctx, x, y, burstR, state.time, effect.id * 2.3, 2.6, 2, 2.4);
  ctx.stroke();

  for (let i = 0; i < CLOSE_CALL_BUBBLES; i++) {
    const seed = effect.id * 13.7 + i * 3.1;
    const baseAngle = hash(seed) * Math.PI * 2;
    const spiral = baseAngle + t * (1.8 + hash(seed + 1) * 1.6);
    const dist = ringRadius * (0.02 + (0.13 + hash(seed + 2) * 0.09) * t);
    const bx = x + Math.cos(spiral) * dist;
    const by = y + Math.sin(spiral) * dist;
    const pop = Math.sin(clamp(t * 1.4, 0, 1) * Math.PI);
    const bubbleR = ringRadius * (0.008 + 0.02 * hash(seed + 3)) * pop;
    ctx.fillStyle = rgba(color, fade * (0.55 + 0.3 * hash(seed + 4)));
    ctx.beginPath();
    ctx.arc(bx, by, Math.max(0, bubbleR), 0, Math.PI * 2);
    ctx.fill();
  }

  drawEffectLabel(ctx, effect, color, fade, t, center, ringRadius, 0.15 * Math.sin(t * Math.PI));
  ctx.restore();
}

function drawEffect(ctx: CanvasRenderingContext2D, effect: Effect, state: GameState, center: number, ringRadius: number) {
  if (effect.kind === "close-call") drawCloseCallEffect(ctx, effect, state, center, ringRadius);
  else drawLastSecondEffect(ctx, effect, state, center, ringRadius);
}

function drawScore(ctx: CanvasRenderingContext2D, state: GameState, size: number) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (!state.gameOver) {
    const text = String(Math.floor(state.score));
    const fontSize = size * 0.032;
    ctx.font = `700 ${Math.round(fontSize)}px system-ui, sans-serif`;

    const pulse = 0.5 + 0.5 * Math.sin(state.time * 1.6);
    const chipW = Math.max(size * 0.11, ctx.measureText(text).width + size * 0.045);
    const chipH = size * 0.05;
    const chipX = size / 2 - chipW / 2;
    const chipY = size * 0.025;

    ctx.fillStyle = rgba(COLORS.bg, 0.55);
    roundedRect(ctx, chipX, chipY, chipW, chipH, chipH / 2);
    ctx.fill();

    const borderHue = state.time * 22;
    ctx.strokeStyle = rgba(hslToRgb(borderHue, 0.65, 0.72), 0.3 + 0.25 * pulse);
    ctx.lineWidth = Math.max(1, size * 0.0022);
    roundedRect(ctx, chipX, chipY, chipW, chipH, chipH / 2);
    ctx.stroke();

    ctx.shadowColor = rgba(COLORS.score, 0.6);
    ctx.shadowBlur = size * 0.015;
    ctx.fillStyle = rgba(COLORS.score, 0.9);
    ctx.fillText(text, size / 2, chipY + chipH / 2);
    ctx.shadowBlur = 0;
    return;
  }

  const elapsed = state.time - (state.gameOverAt ?? state.time);
  const growth = clamp((elapsed - 0.2) / 0.6, 0, 1);
  if (growth <= 0) return;
  const fontSize = size * (0.028 + 0.09 * growth);
  ctx.shadowColor = rgba(COLORS.score, 0.5 * growth);
  ctx.shadowBlur = size * 0.03 * growth;
  ctx.fillStyle = rgba(COLORS.score, 0.4 + 0.6 * growth);
  ctx.font = `700 ${Math.round(fontSize)}px system-ui, sans-serif`;
  ctx.fillText(String(Math.floor(state.score)), size / 2, size * 0.4);
  ctx.shadowBlur = 0;

  const promptAlpha = clamp((elapsed - 0.9) / 0.4, 0, 1);
  if (promptAlpha <= 0) return;
  const promptPulse = 0.6 + 0.4 * Math.sin(state.time * 3);
  ctx.font = `600 ${Math.round(size * 0.026)}px system-ui, sans-serif`;
  ctx.fillStyle = rgba(COLORS.score, promptAlpha * (0.45 + 0.4 * promptPulse));
  ctx.fillText("tap to try again", size / 2, size * 0.4 + fontSize * 0.9);
}

// Right after a (re)start, the planet and orbit ring grow in from nothing
// instead of snapping straight to full size — softens the jump cut from the
// game-over scene into a fresh run. The player itself isn't scaled by this:
// it's already at its real orbit position from frame one, so the world
// reads as materializing around it rather than the player popping in too.
const GROW_IN_DURATION = 0.4;

function growInFor(state: GameState): number {
  const linear = clamp(state.time / GROW_IN_DURATION, 0, 1);
  return 1 - Math.pow(1 - linear, 3);
}

export function render(ctx: CanvasRenderingContext2D, state: GameState, size: number) {
  const center = size / 2;
  const ringRadius = size * 0.36;
  const ringAlpha = ringAlphaFor(state);
  const growIn = growInFor(state);

  ctx.fillStyle = rgba(COLORS.bg, 1);
  ctx.fillRect(0, 0, size, size);

  drawStars(ctx, state, size);
  drawPlanet(ctx, state, center, ringRadius * 0.44 * growIn, ringAlpha * growIn);
  drawNoodleRings(ctx, state, center, ringRadius, ringAlpha * growIn);

  // A quick, small flare right after a direction change — the ring briefly
  // widens/brightens a touch, decaying back to its resting look.
  const REVERSAL_PULSE_DURATION = 0.25;
  const sinceReversal =
    state.lastReversedAt === null ? Infinity : state.time - state.lastReversedAt;
  const pulse = Math.max(0, 1 - sinceReversal / REVERSAL_PULSE_DURATION);

  // The widest (soft-band) ring's rest thickness is pinned to the player's
  // own size — 1.5x its diameter — so the two read as scaled together.
  const playerDiameter = ringRadius * PLAYER_RADIUS_FRACTION * 2;
  const widestRingWidth = playerDiameter * 1.5;

  const ringDrawRadius = ringRadius * growIn;
  const ringGlowReveal = ringGlowRevealFor(state);

  ctx.save();
  // A wide, faint band gives the path a soft glow-halo — warped the same way
  // as the planet's surface, so it reads as part of the same living scene —
  // then a thin line on top marks the player's exact, perfectly circular
  // orbit radius. Both kept low-contrast against the bg. Only the thin line
  // carries the reversal flash — the wide band stays calm so the reversal
  // reads as a crisp blink rather than the whole ring pulsing.
  if (ringGlowReveal > 0) {
    ctx.strokeStyle = rgba(COLORS.ring, ringAlpha * 0.08 * growIn * ringGlowReveal);
    ctx.lineWidth = widestRingWidth;
    traceWarpedCircle(ctx, center, ringDrawRadius, state.time, Math.PI);
    ctx.stroke();
  }

  ctx.shadowColor = rgba(COLORS.ring, ringAlpha * (0.25 + 0.2 * pulse) * growIn);
  ctx.shadowBlur = size * (0.008 + 0.01 * pulse);
  ctx.strokeStyle = rgba(COLORS.ring, ringAlpha * (0.3 + 0.2 * pulse) * growIn);
  ctx.lineWidth = Math.max(1, size * (0.0022 + 0.0016 * pulse));
  ctx.beginPath();
  ctx.arc(center, center, ringDrawRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  for (const pending of state.pendingSpawns) {
    drawPendingSpawn(ctx, pending, state, center, ringRadius);
  }

  for (const hazard of state.hazards) {
    drawHazard(ctx, hazard, state, center, ringRadius);
  }

  if (ringAlpha > 0.02) {
    drawPlayer(ctx, state, center, ringRadius, ringAlpha);
  }

  for (const effect of state.effects) {
    drawEffect(ctx, effect, state, center, ringRadius);
  }

  drawScore(ctx, state, size);
}
