// Canvas rendering — reads GameState, never mutates it. Trails are drawn
// procedurally from angle + direction rather than stored history, so state
// stays plain data.
import { hazardLifeFraction, hazardSpawnFraction, isTelegraphing, type GameState, type Hazard } from "./game";

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
  size: number,
  alpha: number,
) {
  const r = size * 0.018;
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

function drawHazard(
  ctx: CanvasRenderingContext2D,
  hazard: Hazard,
  state: GameState,
  center: number,
  ringRadius: number,
  size: number,
) {
  const lifeFraction = hazardLifeFraction(hazard, state.time);
  const telegraphing = isTelegraphing(hazard, state.time);
  const endScale = telegraphing ? Math.max(0.15, lifeFraction / 0.2) : 1;
  const endAlpha = telegraphing ? Math.max(0.12, lifeFraction / 0.2) : 1;
  const spawnFraction = hazardSpawnFraction(hazard, state.time);
  const scale = spawnFraction * endScale;
  const alpha = spawnFraction * endAlpha;
  const r = size * 0.016 * scale;
  const [x, y] = pointOn(center, ringRadius, hazard.angle);

  if (hazard.kind === "moving") {
    for (let i = 4; i >= 1; i--) {
      const trailAngle = hazard.angle - hazard.direction * i * 0.05;
      const [tx, ty] = pointOn(center, ringRadius, trailAngle);
      ctx.fillStyle = rgba(COLORS.danger, alpha * (0.28 - i * 0.045));
      ctx.beginPath();
      ctx.arc(tx, ty, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    const heading = hazard.angle + hazard.direction * (Math.PI / 2);
    drawTriangle(ctx, x, y, r, heading, rgba(COLORS.danger, alpha));
  } else {
    drawDiamond(ctx, x, y, r, rgba(COLORS.danger, alpha));
  }
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

  for (const hazard of state.hazards) {
    drawHazard(ctx, hazard, state, center, ringRadius, size);
  }

  if (ringAlpha > 0.02) {
    drawPlayer(ctx, state, center, ringRadius, size, ringAlpha);
  }

  drawScore(ctx, state, size);
}
