import { createInitialState, tick, handleInput } from "./game";
import { render } from "./render";
import { createAudioEngine } from "./audio";

const audio = createAudioEngine();

const canvasOrNull = document.querySelector<HTMLCanvasElement>("#game");
if (!canvasOrNull) throw new Error("missing #game canvas");
const canvas: HTMLCanvasElement = canvasOrNull;

const ctxOrNull = canvas.getContext("2d");
if (!ctxOrNull) throw new Error("2d context unavailable");
const ctx: CanvasRenderingContext2D = ctxOrNull;

const highScoreLabel = document.querySelector<HTMLElement>("#high-score");
const HIGH_SCORE_KEY = "orbit-reversal-dodge-high-score";
let highScore = Number(localStorage.getItem(HIGH_SCORE_KEY)) || 0;
function paintHighScore() {
  if (highScoreLabel) highScoreLabel.textContent = `High score: ${highScore}`;
}
paintHighScore();

let state = createInitialState();
let wasGameOver = false;
let size = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  size = Math.floor(Math.min(window.innerWidth, window.innerHeight));
  canvas.width = Math.floor(size * dpr);
  canvas.height = Math.floor(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

function reverse() {
  audio.unlock();
  const prevGameOver = state.gameOver;
  const prevDirection = state.playerDirection;
  state = handleInput(state);
  if (!prevGameOver && state.playerDirection !== prevDirection) {
    audio.directionChange(state.playerDirection);
  }
}
window.addEventListener("pointerdown", reverse);
window.addEventListener("keydown", reverse);

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const prevState = state;
  state = tick(state, dt);

  const prevHazardIds = new Set(prevState.hazards.map((hazard) => hazard.id));
  for (const hazard of state.hazards) {
    if (!prevHazardIds.has(hazard.id)) audio.obstacleBorn();
  }
  const currentHazardIds = new Set(state.hazards.map((hazard) => hazard.id));
  for (const id of prevHazardIds) {
    if (!currentHazardIds.has(id)) audio.obstacleDied();
  }

  const prevEffectIds = new Set(prevState.effects.map((effect) => effect.id));
  for (const effect of state.effects) {
    if (prevEffectIds.has(effect.id)) continue;
    if (effect.kind === "close-call") audio.closeCall();
    else audio.nearMiss();
  }

  if (state.gameOver && !wasGameOver) {
    audio.death();
    if (state.score > highScore) {
      highScore = Math.floor(state.score);
      localStorage.setItem(HIGH_SCORE_KEY, String(highScore));
      paintHighScore();
    }
  }
  wasGameOver = state.gameOver;

  audio.tickMusic(Math.min(state.time, state.gameOverAt ?? state.time));

  render(ctx, state, size);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
