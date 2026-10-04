// Seeded PRNG (mulberry32). Every generated campaign is a pure function of its seed,
// so a reported seed is a complete reproduction recipe.
export interface Rng {
  readonly seed: number;
  next(): number;
  int(maxExclusive: number): number;
  range(min: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    seed,
    next,
    int,
    range: (min, max) => min + int(max - min + 1),
    pick: (items) => {
      if (items.length === 0) throw new Error('pick from an empty list');
      return items[int(items.length)];
    },
    chance: (p) => next() < p,
  };
}
