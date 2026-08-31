import { createInitialState, tick, handleInput } from "./game";
import { render } from "./render";

const canvasOrNull = document.querySelector<HTMLCanvasElement>("#game");
if (!canvasOrNull) throw new Error("missing #game canvas");
const canvas: HTMLCanvasElement = canvasOrNull;

const ctxOrNull = canvas.getContext("2d");
if (!ctxOrNull) throw new Error("2d context unavailable");
const ctx: CanvasRenderingContext2D = ctxOrNull;

let state = createInitialState();
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
  render(ctx, state, size);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
