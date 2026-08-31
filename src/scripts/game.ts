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

// A hazard on approach: nothing here can collide with the player. It's the
// warning — a large circle at the hazard's future position and kind, which
// shrinks down to that hazard's actual size by `spawnAt`, when it turns into
// a real, collidable Hazard.
export interface PendingSpawn {
  id: number;
  kind: HazardKind;
  angle: number;
  direction: 1 | -1;
  speed: number;
  lifetime: number;
  scheduledAt: number;
  spawnAt: number;
  introAdvanceTo?: IntroStage;
}

export interface GameState {
  time: number;
  score: number;
  playerAngle: number;
  playerDirection: 1 | -1;
  tier: number;
  hazards: Hazard[];
  pendingSpawns: PendingSpawn[];
  nextId: number;
  gameOver: boolean;
  gameOverAt: number | null;
  introStage: IntroStage;
  introStageStartedAt: number;
  movingIntroScheduled: boolean;
  staticIntroScheduled: boolean;
  lastSpawnAt: number;
  rng: () => number;
}

export const PLAYER_SPEED = 1.1; // rad/s, constant regardless of tier

// Step tiers, not adaptive difficulty: every atSeconds threshold bumps moving
// hazard speed and spawn rate, and tightens hazard lifetime.
// movingSpeed stays well under PLAYER_SPEED (1.1) at every tier — the player
// orbits much faster than any hazard travels, so reversing is always enough
// to out-run one.
export const TIERS = [
  { atSeconds: 0, spawnInterval: 2.4, movingSpeed: 0.35, lifetime: 6.5 },
  { atSeconds: 15, spawnInterval: 1.9, movingSpeed: 0.45, lifetime: 6.0 },
  { atSeconds: 30, spawnInterval: 1.5, movingSpeed: 0.55, lifetime: 5.5 },
  { atSeconds: 50, spawnInterval: 1.1, movingSpeed: 0.7, lifetime: 5.0 },
] as const;

const INTRO_MOVING_AT = 1.5; // grace period before the first (moving) warning
const INTRO_STATIC_GAP = 2.5; // gap after the moving intro before the static one
const RESTART_DELAY = 0.5; // seconds after game-over before restart input counts

// A hazard's visible radius, as a fraction of the ring radius — the single
// source of truth both rendering (pixel size) and collision (angular hit
// radius) read from, so a hazard's hitbox can never drift from how it looks.
export const PLAYER_RADIUS_FRACTION = 0.05;
export const HAZARD_RADIUS_FRACTION = 0.0444;
const HITBOX_FRACTION = 0.8; // hitbox ~80% of visible sprite radius: near-misses feel earned
const HIT_ANGLE = (PLAYER_RADIUS_FRACTION + HAZARD_RADIUS_FRACTION) * HITBOX_FRACTION;

const TELEGRAPH_FRACTION = 0.2; // last 20% of life: hazard shrinks/dims

// How long a warning circle is visible before the hazard it announces
// actually appears and becomes dangerous.
export const WARNING_DURATION = 1.1;

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

// 0 at the moment a warning appears, 1 the instant its hazard spawns.
export function warningProgress(pending: PendingSpawn, time: number): number {
  const total = pending.spawnAt - pending.scheduledAt;
  const elapsed = time - pending.scheduledAt;
  return Math.min(1, Math.max(0, elapsed / total));
}

export function createInitialState(options: { rng?: () => number } = {}): GameState {
  return {
    time: 0,
    score: 0,
    playerAngle: 0,
    playerDirection: 1,
    tier: 0,
    hazards: [],
    pendingSpawns: [],
    nextId: 0,
    gameOver: false,
    gameOverAt: null,
    introStage: "moving-intro",
    introStageStartedAt: 0,
    movingIntroScheduled: false,
    staticIntroScheduled: false,
    lastSpawnAt: 0,
    rng: options.rng ?? Math.random,
  };
}

// Only real hazards collide — a pending spawn is a warning, not a threat yet,
// and a hazard already telegraphing its despawn (shrinking/dimming in its
// final TELEGRAPH_FRACTION of life) reads as leaving, not lethal.
export function checkCollision(state: GameState): boolean {
  return state.hazards.some(
    (hazard) =>
      !isTelegraphing(hazard, state.time) && angularDistance(hazard.angle, state.playerAngle) < HIT_ANGLE,
  );
}

function schedulePendingSpawn(
  state: GameState,
  kind: HazardKind,
  angle: number,
  introAdvanceTo?: IntroStage,
): GameState {
  const tier = TIERS[state.tier];
  const pending: PendingSpawn = {
    id: state.nextId,
    kind,
    angle: normalizeAngle(angle),
    direction: state.rng() < 0.5 ? 1 : -1,
    speed: kind === "moving" ? tier.movingSpeed : 0,
    lifetime: tier.lifetime,
    scheduledAt: state.time,
    spawnAt: state.time + WARNING_DURATION,
    introAdvanceTo,
  };
  return { ...state, pendingSpawns: [...state.pendingSpawns, pending], nextId: state.nextId + 1 };
}

// The no-tutorial teaching sequence: the first hazard is always the easy
// moving kind, placed opposite the player for a safe first read; the first
// static hazard follows, placed to the side so it's noticed at rest before
// it's ever a threat. Only after both have actually appeared does normal
// spawning begin — the level teaches the mechanic, nothing explains it.
function maybeSpawn(state: GameState): GameState {
  if (state.introStage === "moving-intro") {
    if (state.movingIntroScheduled || state.time < INTRO_MOVING_AT) return state;
    const scheduled = schedulePendingSpawn(state, "moving", state.playerAngle + Math.PI, "static-intro");
    return { ...scheduled, movingIntroScheduled: true };
  }

  if (state.introStage === "static-intro") {
    if (state.staticIntroScheduled || state.time < state.introStageStartedAt + INTRO_STATIC_GAP) return state;
    const scheduled = schedulePendingSpawn(state, "static", state.playerAngle + Math.PI / 2, "both");
    return { ...scheduled, staticIntroScheduled: true };
  }

  const tier = TIERS[state.tier];
  if (state.time < state.lastSpawnAt + tier.spawnInterval) return state;
  const kind: HazardKind = state.rng() < 0.5 ? "moving" : "static";
  const scheduled = schedulePendingSpawn(state, kind, state.rng() * Math.PI * 2);
  return { ...scheduled, lastSpawnAt: state.time };
}

// Turn any pending spawn whose warning has finished into a real hazard.
function hatchPendingSpawns(state: GameState): GameState {
  const due = state.pendingSpawns.filter((pending) => state.time >= pending.spawnAt);
  if (due.length === 0) return state;

  const stillPending = state.pendingSpawns.filter((pending) => state.time < pending.spawnAt);
  const hatched: Hazard[] = due.map((pending) => ({
    id: pending.id,
    kind: pending.kind,
    angle: pending.angle,
    direction: pending.direction,
    speed: pending.speed,
    spawnedAt: state.time,
    lifetime: pending.lifetime,
  }));

  const introAdvanceTo = due.find((pending) => pending.introAdvanceTo)?.introAdvanceTo;

  return {
    ...state,
    pendingSpawns: stillPending,
    hazards: [...state.hazards, ...hatched],
    ...(introAdvanceTo ? { introStage: introAdvanceTo, introStageStartedAt: state.time } : {}),
  };
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
  next = hatchPendingSpawns(next);

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
