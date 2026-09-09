export interface Theme {
  id: string;
  label: string;
  /** Page + scene background. */
  bg: number;
  /** Distance fog, keeps the horizon soft. */
  fog: number;
  /** Reflective plaza under the city. */
  ground: number;
  /** Faint street grid. */
  grid: number;
  /** Five colours, one per contribution level (0 = empty lot). */
  ramp: [number, number, number, number, number];
  /** Bloom strength. Bright themes need less. */
  bloom: number;
  /** Emissive multiplier applied to every building. */
  glow: number;
  /** Accent used by the UI chrome. */
  accent: string;
  starColor: number;
}

export const THEMES: Theme[] = [
  {
    id: 'neon',
    label: 'Neon',
    bg: 0x05060d,
    fog: 0x05060d,
    ground: 0x080a14,
    grid: 0x1b2138,
    ramp: [0x1b2238, 0x00506b, 0x0091a7, 0x1fd8c8, 0x9dfff0],
    bloom: 0.95,
    glow: 1.25,
    accent: '#2ee6d6',
    starColor: 0x8fd8ff,
  },
  {
    id: 'aurora',
    label: 'Aurora',
    bg: 0x040a08,
    fog: 0x040a08,
    ground: 0x06110d,
    grid: 0x14301f,
    ramp: [0x111f18, 0x0d5c33, 0x14a34a, 0x3ce77a, 0xb9ffcf],
    bloom: 0.9,
    glow: 1.2,
    accent: '#39e77c',
    starColor: 0x9effc4,
  },
  {
    id: 'sunset',
    label: 'Sunset',
    bg: 0x120611,
    fog: 0x120611,
    ground: 0x1a0a16,
    grid: 0x3a1730,
    ramp: [0x24101f, 0x7a1f52, 0xc93a6a, 0xff7a4d, 0xffd9a0],
    bloom: 1.05,
    glow: 1.3,
    accent: '#ff8a5c',
    starColor: 0xffc7a1,
  },
  {
    id: 'matrix',
    label: 'Matrix',
    bg: 0x000600,
    fog: 0x000600,
    ground: 0x020a02,
    grid: 0x0d2a0d,
    ramp: [0x0a1a0a, 0x0f5c14, 0x18a821, 0x35e83c, 0xc4ffc6],
    bloom: 1.15,
    glow: 1.45,
    accent: '#35e83c',
    starColor: 0x7dff86,
  },
  {
    id: 'ice',
    label: 'Ice',
    bg: 0x060a14,
    fog: 0x060a14,
    ground: 0x0a1020,
    grid: 0x1d2b47,
    ramp: [0x151d2e, 0x2f5f9e, 0x4f8fd4, 0x8fc4f5, 0xeaf6ff],
    bloom: 0.85,
    glow: 1.15,
    accent: '#7fb8f0',
    starColor: 0xcfe6ff,
  },
];

/**
 * Resolve a theme id to a concrete theme.
 * Falls back to the first theme when the id is missing or unknown.
 */
export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
