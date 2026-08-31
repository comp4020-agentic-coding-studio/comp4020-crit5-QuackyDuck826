import { describe, expect, it } from "vitest";
import {
  createInitialState,
  handleInput,
  hazardLifeFraction,
  isTelegraphing,
  tick,
  tierIndexForTime,
  TIERS,
  type GameState,
  type Hazard,
} from "../src/scripts/game";

// Rule tests for Orbit Reversal Dodge's pure game logic — one per rule in the
// design (see the crit-5 plan). These test src/scripts/game.ts directly, not
// the built dist/, so they exercise the rules regardless of rendering.

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withHazards(state: GameState, hazards: Hazard[]): GameState {
  return { ...state, introStage: "both", hazards };
}

describe("orbit reversal dodge: game rules", () => {
  it("reverses the player's orbit direction on input", () => {
    const state = createInitialState({ rng: seeded(1) });
    expect(state.playerDirection).toBe(1);
    const reversed = handleInput(state);
    expect(reversed.playerDirection).toBe(-1);
    expect(handleInput(reversed).playerDirection).toBe(1);
  });

  it("advances a moving hazard's angle over time but leaves a static hazard's angle fixed", () => {
    const base = createInitialState({ rng: seeded(2) });
    const moving: Hazard = { id: 1, kind: "moving", angle: 0, direction: 1, speed: 1, spawnedAt: 0, lifetime: 100 };
    const stationary: Hazard = {
      id: 2,
      kind: "static",
      angle: 1,
      direction: 1,
      speed: 0,
      spawnedAt: 0,
      lifetime: 100,
    };
    const state = withHazards(base, [moving, stationary]);
    const next = tick(state, 1);
    const nextMoving = next.hazards.find((h) => h.id === 1)!;
    const nextStatic = next.hazards.find((h) => h.id === 2)!;
    expect(nextMoving.angle).not.toBeCloseTo(moving.angle, 5);
    expect(nextStatic.angle).toBeCloseTo(stationary.angle, 5);
  });

  it("ends the game when the player collides with a hazard", () => {
    const base = createInitialState({ rng: seeded(3) });
    const hazard: Hazard = {
      id: 1,
      kind: "static",
      angle: base.playerAngle,
      direction: 1,
      speed: 0,
      spawnedAt: 0,
      lifetime: 100,
    };
    const state = withHazards(base, [hazard]);
    const next = tick(state, 0.016);
    expect(next.gameOver).toBe(true);
  });

  it("does not end the game while every hazard is out of range", () => {
    const base = createInitialState({ rng: seeded(4) });
    const hazard: Hazard = {
      id: 1,
      kind: "static",
      angle: base.playerAngle + Math.PI,
      direction: 1,
      speed: 0,
      spawnedAt: 0,
      lifetime: 100,
    };
    const state = withHazards(base, [hazard]);
    const next = tick(state, 0.016);
    expect(next.gameOver).toBe(false);
  });

  it("increases hazard speed and spawn rate at each difficulty tier", () => {
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i].movingSpeed).toBeGreaterThan(TIERS[i - 1].movingSpeed);
      expect(TIERS[i].spawnInterval).toBeLessThan(TIERS[i - 1].spawnInterval);
    }
  });

  it("selects the difficulty tier matching elapsed time", () => {
    expect(tierIndexForTime(0)).toBe(0);
    expect(tierIndexForTime(TIERS[1].atSeconds)).toBe(1);
    expect(tierIndexForTime(TIERS[TIERS.length - 1].atSeconds + 1)).toBe(TIERS.length - 1);
  });

  it("removes a hazard once its lifetime has fully elapsed", () => {
    const base = createInitialState({ rng: seeded(5) });
    const hazard: Hazard = {
      id: 1,
      kind: "static",
      angle: base.playerAngle + Math.PI,
      direction: 1,
      speed: 0,
      spawnedAt: 0,
      lifetime: 1,
    };
    const state = withHazards(base, [hazard]);
    const next = tick(state, 1.5);
    expect(next.hazards.find((h) => h.id === 1)).toBeUndefined();
  });

  it("telegraphs a hazard's despawn by shrinking/dimming over its final 20% of life", () => {
    const hazard: Hazard = { id: 1, kind: "static", angle: 0, direction: 1, speed: 0, spawnedAt: 0, lifetime: 10 };
    expect(isTelegraphing(hazard, 7.9)).toBe(false);
    expect(isTelegraphing(hazard, 8.1)).toBe(true);
    expect(hazardLifeFraction(hazard, 8.1)).toBeLessThan(hazardLifeFraction(hazard, 7.9));
  });

  it("restarts on the same input used to play, once the game-over freeze has passed", () => {
    const base = createInitialState({ rng: seeded(6) });
    const hazard: Hazard = {
      id: 1,
      kind: "static",
      angle: base.playerAngle,
      direction: 1,
      speed: 0,
      spawnedAt: 0,
      lifetime: 100,
    };
    let state = withHazards(base, [hazard]);
    state = tick(state, 0.016);
    expect(state.gameOver).toBe(true);

    const tooSoon = handleInput(state);
    expect(tooSoon.gameOver).toBe(true);

    state = tick(state, 1);
    const restarted = handleInput(state);
    expect(restarted.gameOver).toBe(false);
    expect(restarted.time).toBe(0);
  });

  it("teaches by sequencing: the first hazard is the moving kind, introduced after a grace period", () => {
    let state = createInitialState({ rng: seeded(7) });
    state = tick(state, 1.0);
    expect(state.hazards.length).toBe(0);

    state = tick(state, 1.0);
    expect(state.hazards.length).toBe(1);
    expect(state.hazards[0].kind).toBe("moving");
  });

  it("only spawns hazards together after each kind has been introduced once", () => {
    let state = createInitialState({ rng: seeded(9) });
    expect(state.introStage).toBe("moving-intro");

    state = tick(state, 2);
    expect(state.introStage).toBe("static-intro");
    expect(state.hazards.some((h) => h.kind === "moving")).toBe(true);
    expect(state.hazards.some((h) => h.kind === "static")).toBe(false);

    state = tick(state, 3);
    expect(state.introStage).toBe("both");
    expect(state.hazards.some((h) => h.kind === "static")).toBe(true);
  });
});
