// Pure game logic for Orbit Reversal Dodge — no DOM, no canvas, no timers.
// tick/handleInput are the only ways state changes, so both rendering
// (src/scripts/render.ts) and the tests in spec/ exercise the same rules.

export type HazardKind = "moving" | "static";

export interface Hazard {
  id: number;
  kind: HazardKind;
  angle: number;
  direction: 1 | -1;
  speed: number; // rad/s, 0 for static hazards
  spawnedAt: number; // state.time at spawn
  lifetime: number; // seconds until despawn
}

export type IntroStage = "moving-intro" | "static-intro" | "both";

export interface GameState {
  time: number;
  score: number;
  playerAngle: number;
  playerDirection: 1 | -1;
  tier: number;
  hazards: Hazard[];
  nextHazardId: number;
  gameOver: boolean;
  gameOverAt: number | null;
  introStage: IntroStage;
  introStageStartedAt: number;
  lastSpawnAt: number;
  rng: () => number;
}

export const PLAYER_SPEED = 1.1; // rad/s, constant regardless of tier

// Step tiers, not adaptive difficulty: every atSeconds threshold bumps moving
// hazard speed and spawn rate, and tightens hazard lifetime.
export const TIERS = [
  { atSeconds: 0, spawnInterval: 2.4, movingSpeed: 1.0, lifetime: 6.5 },
  { atSeconds: 15, spawnInterval: 1.9, movingSpeed: 1.3, lifetime: 6.0 },
  { atSeconds: 30, spawnInterval: 1.5, movingSpeed: 1.7, lifetime: 5.5 },
  { atSeconds: 50, spawnInterval: 1.1, movingSpeed: 2.1, lifetime: 5.0 },
] as const;

const INTRO_MOVING_AT = 1.5; // grace period before the first (moving) hazard
const INTRO_STATIC_GAP = 2.5; // gap after the moving intro before the static one
const HIT_ANGLE = 0.16; // combined player+hazard angular hit radius (~9 degrees)
const TELEGRAPH_FRACTION = 0.2; // last 20% of life: hazard shrinks/dims
const RESTART_DELAY = 0.5; // seconds after game-over before restart input counts

export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

export function angularDistance(a: number, b: number): number {
  const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(diff, Math.PI * 2 - diff);
}

export function tierIndexForTime(time: number): number {
  let index = 0;
  for (let i = 0; i < TIERS.length; i++) {
    if (time >= TIERS[i].atSeconds) index = i;
  }
  return index;
}

export function hazardLifeFraction(hazard: Hazard, time: number): number {
  const remaining = 1 - (time - hazard.spawnedAt) / hazard.lifetime;
  return Math.min(1, Math.max(0, remaining));
}

export function isTelegraphing(hazard: Hazard, time: number): boolean {
  return hazardLifeFraction(hazard, time) <= TELEGRAPH_FRACTION;
}

export function createInitialState(options: { rng?: () => number } = {}): GameState {
  return {
    time: 0,
    score: 0,
    playerAngle: 0,
    playerDirection: 1,
    tier: 0,
    hazards: [],
    nextHazardId: 0,
    gameOver: false,
    gameOverAt: null,
    introStage: "moving-intro",
    introStageStartedAt: 0,
    lastSpawnAt: 0,
    rng: options.rng ?? Math.random,
  };
}

export function checkCollision(state: GameState): boolean {
  return state.hazards.some((hazard) => angularDistance(hazard.angle, state.playerAngle) < HIT_ANGLE);
}

function spawnHazard(state: GameState, kind: HazardKind, angle: number): GameState {
  const tier = TIERS[state.tier];
  const hazard: Hazard = {
    id: state.nextHazardId,
    kind,
    angle: normalizeAngle(angle),
    direction: state.rng() < 0.5 ? 1 : -1,
    speed: kind === "moving" ? tier.movingSpeed : 0,
    spawnedAt: state.time,
    lifetime: tier.lifetime,
  };
  return { ...state, hazards: [...state.hazards, hazard], nextHazardId: state.nextHazardId + 1 };
}

// The no-tutorial teaching sequence: the first hazard is always the easy
// moving kind, placed opposite the player for a safe first read; the first
// static hazard follows, placed to the side so it's noticed at rest before
// it's ever a threat. Only after both have appeared once does normal spawning
// begin — the level teaches the mechanic, nothing explains it.
function maybeSpawn(state: GameState): GameState {
  if (state.introStage === "moving-intro") {
    if (state.time < INTRO_MOVING_AT) return state;
    const spawned = spawnHazard(state, "moving", state.playerAngle + Math.PI);
    return { ...spawned, introStage: "static-intro", introStageStartedAt: state.time };
  }

  if (state.introStage === "static-intro") {
    if (state.time < state.introStageStartedAt + INTRO_STATIC_GAP) return state;
    const spawned = spawnHazard(state, "static", state.playerAngle + Math.PI / 2);
    return { ...spawned, introStage: "both", lastSpawnAt: state.time };
  }

  const tier = TIERS[state.tier];
  if (state.time < state.lastSpawnAt + tier.spawnInterval) return state;
  const kind: HazardKind = state.rng() < 0.5 ? "moving" : "static";
  const spawned = spawnHazard(state, kind, state.rng() * Math.PI * 2);
  return { ...spawned, lastSpawnAt: state.time };
}

export function tick(state: GameState, dt: number): GameState {
  const time = state.time + dt;

  if (state.gameOver) {
    // Frozen pose (hit-stop): the clock keeps running so rendering can fade
    // the ring and grow the score, but nothing about the game itself moves.
    return { ...state, time };
  }

  let next: GameState = {
    ...state,
    time,
    tier: tierIndexForTime(time),
    playerAngle: normalizeAngle(state.playerAngle + state.playerDirection * PLAYER_SPEED * dt),
    hazards: state.hazards
      .map((hazard) =>
        hazard.kind === "moving"
          ? { ...hazard, angle: normalizeAngle(hazard.angle + hazard.direction * hazard.speed * dt) }
          : hazard,
      )
      .filter((hazard) => time - hazard.spawnedAt < hazard.lifetime),
  };

  next = maybeSpawn(next);

  if (checkCollision(next)) {
    next = { ...next, gameOver: true, gameOverAt: next.time, score: next.time };
  }

  return next;
}

export function handleInput(state: GameState): GameState {
  if (state.gameOver) {
    const sinceGameOver = state.time - (state.gameOverAt ?? state.time);
    if (sinceGameOver < RESTART_DELAY) return state;
    return createInitialState({ rng: state.rng });
  }
  return { ...state, playerDirection: state.playerDirection === 1 ? -1 : 1 };
}
