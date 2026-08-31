// Canvas rendering — reads GameState, never mutates it. Trails are drawn
// procedurally from angle + direction rather than stored history, so state
// stays plain data.
import {
  HAZARD_RADIUS_FRACTION,
  hazardLifeFraction,
  isTelegraphing,
  PLAYER_RADIUS_FRACTION,
  warningProgress,
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
  ctx.fillStyle = rgba(COLORS.player, alpha);
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
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

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
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
    drawDiamond(ctx, x, y, r, rgba(color, alpha));
  }
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

function drawScore(ctx: CanvasRenderingContext2D, state: GameState, size: number) {
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  if (!state.gameOver) {
    ctx.fillStyle = rgba(COLORS.score, 0.75);
    ctx.font = `${Math.round(size * 0.028)}px system-ui, sans-serif`;
    ctx.fillText(String(Math.floor(state.time)), size / 2, size * 0.04);
    return;
  }

  const elapsed = state.time - (state.gameOverAt ?? state.time);
  const growth = clamp((elapsed - 0.2) / 0.6, 0, 1);
  if (growth <= 0) return;
  const fontSize = size * (0.028 + 0.09 * growth);
  ctx.fillStyle = rgba(COLORS.score, 0.4 + 0.6 * growth);
  ctx.font = `${Math.round(fontSize)}px system-ui, sans-serif`;
  ctx.fillText(String(Math.floor(state.score)), size / 2, size * 0.4);
}

export function render(ctx: CanvasRenderingContext2D, state: GameState, size: number) {
  const center = size / 2;
  const ringRadius = size * 0.36;
  const ringAlpha = ringAlphaFor(state);

  ctx.fillStyle = rgba(COLORS.bg, 1);
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = rgba(COLORS.ring, ringAlpha * 0.6);
  ctx.lineWidth = Math.max(1, size * 0.002);
  ctx.beginPath();
  ctx.arc(center, center, ringRadius, 0, Math.PI * 2);
  ctx.stroke();

  for (const pending of state.pendingSpawns) {
    drawPendingSpawn(ctx, pending, state, center, ringRadius);
  }

  for (const hazard of state.hazards) {
    drawHazard(ctx, hazard, state, center, ringRadius);
  }

  if (ringAlpha > 0.02) {
    drawPlayer(ctx, state, center, ringRadius, ringAlpha);
  }

  drawScore(ctx, state, size);
}
