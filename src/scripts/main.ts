import { createInitialState, tick, handleInput } from "./game";
import { render } from "./render";

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
  state = handleInput(state);
}
window.addEventListener("pointerdown", reverse);
window.addEventListener("keydown", reverse);

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state = tick(state, dt);
  if (state.gameOver && !wasGameOver && state.score > highScore) {
    highScore = Math.floor(state.score);
    localStorage.setItem(HIGH_SCORE_KEY, String(highScore));
    paintHighScore();
  }
  wasGameOver = state.gameOver;
  render(ctx, state, size);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
