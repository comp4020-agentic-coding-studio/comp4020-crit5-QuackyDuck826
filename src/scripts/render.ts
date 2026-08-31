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
  planetCore: [90, 170, 230] as Rgb,
  planetEdge: [8, 12, 26] as Rgb,
  star: [200, 225, 255] as Rgb,
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

function drawStars(ctx: CanvasRenderingContext2D, state: GameState, size: number) {
  for (let i = 0; i < STAR_COUNT; i++) {
    const fx = hash(i * 1.618);
    const fy = hash(i * 2.718 + 4.2);
    const twinkle = 0.5 + 0.5 * Math.sin(state.time * (0.5 + fx) + i * 3.1);
    ctx.fillStyle = rgba(COLORS.star, 0.12 + twinkle * 0.35);
    ctx.beginPath();
    ctx.arc(fx * size, fy * size, size * (0.0012 + fy * 0.0022), 0, Math.PI * 2);
    ctx.fill();
  }
}

// What everything else orbits: a shaded core plus rings of light that ripple
// outward on a loop, so the center of the board reads as alive rather than
// empty space inside the ring.
const PLANET_RIPPLE_COUNT = 3;
const PLANET_RIPPLE_PERIOD = 3.4; // seconds per ripple cycle

function drawPlanet(ctx: CanvasRenderingContext2D, state: GameState, center: number, radius: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const gradient = ctx.createRadialGradient(
    center - radius * 0.35,
    center - radius * 0.35,
    radius * 0.05,
    center,
    center,
    radius,
  );
  gradient.addColorStop(0, rgba(COLORS.planetCore, 1));
  gradient.addColorStop(1, rgba(COLORS.planetEdge, 1));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < PLANET_RIPPLE_COUNT; i++) {
    const phase = ((state.time / PLANET_RIPPLE_PERIOD + i / PLANET_RIPPLE_COUNT) % 1 + 1) % 1;
    const r = radius * (1 + phase * 1.6);
    ctx.strokeStyle = rgba(COLORS.ring, (1 - phase) * 0.35);
    ctx.lineWidth = Math.max(1, radius * 0.02 * (1 - phase));
    ctx.beginPath();
    ctx.arc(center, center, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  center: number,
  ringRadius: number,
  alpha: number,
) {
  const r = ringRadius * PLAYER_RADIUS_FRACTION;
  for (let i = 6; i >= 1; i--) {
    const trailAngle = state.playerAngle - state.playerDirection * i * 0.045;
    const [x, y] = pointOn(center, ringRadius, trailAngle);
    ctx.fillStyle = rgba(COLORS.player, alpha * (0.35 - i * 0.045));
    ctx.beginPath();
    ctx.arc(x, y, r * (1 - i * 0.08), 0, Math.PI * 2);
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
      const [tx, ty] = pointOn(center, ringRadius, trailAngle);
      ctx.fillStyle = rgba(color, alpha * (0.28 - i * 0.045));
      ctx.beginPath();
      ctx.arc(tx, ty, r * 0.6, 0, Math.PI * 2);
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

// A close call gets a cool burst (you were fine, that fading hazard couldn't
// hurt you anyway); a last-second reversal gets a hotter, sharper one (that
// was a real dodge). Both play out as an expanding shockwave, a few
// radiating spark lines, and a "+N" popup drifting outward as they fade.
function drawEffect(ctx: CanvasRenderingContext2D, effect: Effect, state: GameState, center: number, ringRadius: number) {
  const t = clamp((state.time - effect.triggeredAt) / EFFECT_DURATION, 0, 1);
  const color = effect.kind === "last-second" ? COLORS.lastSecond : COLORS.closeCall;
  const fade = 1 - t;
  const [x, y] = pointOn(center, ringRadius, effect.angle);

  ctx.save();
  ctx.shadowColor = rgba(color, fade * 0.8);
  ctx.shadowBlur = ringRadius * 0.08;

  const shockR = ringRadius * (0.05 + 0.24 * t);
  ctx.strokeStyle = rgba(color, fade * 0.9);
  ctx.lineWidth = Math.max(1, ringRadius * 0.025 * fade);
  ctx.beginPath();
  ctx.arc(x, y, shockR, 0, Math.PI * 2);
  ctx.stroke();

  const rayCount = effect.kind === "last-second" ? 8 : 6;
  const innerR = ringRadius * 0.02;
  const rayLen = ringRadius * (0.05 + 0.16 * t);
  for (let i = 0; i < rayCount; i++) {
    const a = (i / rayCount) * Math.PI * 2 + t * 1.6;
    const ix = x + Math.cos(a) * innerR;
    const iy = y + Math.sin(a) * innerR;
    const ox = x + Math.cos(a) * (innerR + rayLen);
    const oy = y + Math.sin(a) * (innerR + rayLen);
    ctx.strokeStyle = rgba(color, fade * 0.85);
    ctx.lineWidth = Math.max(1, ringRadius * 0.014 * fade);
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    ctx.lineTo(ox, oy);
    ctx.stroke();
  }

  const [lx, ly] = pointOn(center, ringRadius * (1 + 0.14 * t), effect.angle);
  ctx.shadowBlur = 0;
  ctx.fillStyle = rgba(color, fade);
  ctx.font = `700 ${Math.round(ringRadius * 0.09)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`+${effect.amount}`, lx, ly);

  ctx.restore();
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

    ctx.strokeStyle = rgba(COLORS.score, 0.22 + 0.18 * pulse);
    ctx.lineWidth = Math.max(1, size * 0.0018);
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
}

export function render(ctx: CanvasRenderingContext2D, state: GameState, size: number) {
  const center = size / 2;
  const ringRadius = size * 0.36;
  const ringAlpha = ringAlphaFor(state);

  ctx.fillStyle = rgba(COLORS.bg, 1);
  ctx.fillRect(0, 0, size, size);

  drawStars(ctx, state, size);
  drawPlanet(ctx, state, center, ringRadius * 0.32, ringAlpha);

  ctx.save();
  ctx.shadowColor = rgba(COLORS.ring, ringAlpha * 0.5);
  ctx.shadowBlur = size * 0.01;
  ctx.strokeStyle = rgba(COLORS.ring, ringAlpha * 0.6);
  ctx.lineWidth = Math.max(1, size * 0.002);
  ctx.beginPath();
  ctx.arc(center, center, ringRadius, 0, Math.PI * 2);
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
