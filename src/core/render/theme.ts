/**
 * Diagram colour schemes. Each style has a light palette (always used for
 * exported files, which end up on white paper and in white Visio pages) and a
 * dark palette (used for the in-app preview when the app is in dark mode).
 */
import type { NodeRole } from './graphics';

export const DIAGRAM_STYLES = ['color', 'classic', 'blueprint'] as const;
export type DiagramStyle = (typeof DIAGRAM_STYLES)[number];

export interface Palette {
  fill: string;
  stroke: string;
}

export interface DiagramTheme {
  dark: boolean;
  background: string;
  /** Fill of icon bodies drawn on top of a shape. */
  paper: string;
  text: string;
  flow: string;
  message: string;
  band: { fill: string; alt: string; header: string; stroke: string; text: string };
  external: Palette;
  roles: Record<NodeRole, Palette>;
}

const uniform = (palette: Palette): Record<NodeRole, Palette> => ({
  task: palette,
  start: palette,
  end: palette,
  intermediate: palette,
  gateway: palette,
});

const LIGHT: Record<DiagramStyle, DiagramTheme> = {
  color: {
    dark: false,
    background: '#ffffff',
    paper: '#ffffff',
    text: '#1b2333',
    flow: '#3b4558',
    message: '#5b6478',
    band: { fill: '#ffffff', alt: '#fafbfe', header: '#eef2f9', stroke: '#8f9bb0', text: '#1b2333' },
    external: { fill: '#f4f6fb', stroke: '#8f9bb0' },
    roles: {
      task: { fill: '#eaf1fe', stroke: '#2d62c9' },
      start: { fill: '#e2f6e9', stroke: '#1f8a3d' },
      end: { fill: '#fde6e6', stroke: '#c4342f' },
      intermediate: { fill: '#fff3d9', stroke: '#b3741a' },
      gateway: { fill: '#fff6d2', stroke: '#a37407' },
    },
  },
  classic: {
    dark: false,
    background: '#ffffff',
    paper: '#ffffff',
    text: '#111111',
    flow: '#222222',
    message: '#444444',
    band: { fill: '#ffffff', alt: '#ffffff', header: '#f3f3f3', stroke: '#333333', text: '#111111' },
    external: { fill: '#f7f7f7', stroke: '#333333' },
    roles: uniform({ fill: '#ffffff', stroke: '#222222' }),
  },
  blueprint: {
    dark: false,
    background: '#ffffff',
    paper: '#ffffff',
    text: '#12305f',
    flow: '#1e4fa8',
    message: '#4b6fb5',
    band: { fill: '#ffffff', alt: '#f8fbff', header: '#e6effd', stroke: '#6f93d2', text: '#12305f' },
    external: { fill: '#f0f5fe', stroke: '#6f93d2' },
    roles: uniform({ fill: '#f0f5fe', stroke: '#1e4fa8' }),
  },
};

const DARK: Record<DiagramStyle, DiagramTheme> = {
  color: {
    dark: true,
    background: '#10151f',
    paper: '#10151f',
    text: '#e6ebf5',
    flow: '#aeb9cc',
    message: '#8e9ab0',
    band: { fill: '#131a26', alt: '#161e2c', header: '#1c2637', stroke: '#4a576f', text: '#dfe6f2' },
    external: { fill: '#19212f', stroke: '#4a576f' },
    roles: {
      task: { fill: '#1b2a47', stroke: '#74a2ff' },
      start: { fill: '#143023', stroke: '#4ade80' },
      end: { fill: '#3a1a1c', stroke: '#f87171' },
      intermediate: { fill: '#3a2e12', stroke: '#fbbf24' },
      gateway: { fill: '#37300f', stroke: '#facc15' },
    },
  },
  classic: {
    dark: true,
    background: '#10151f',
    paper: '#10151f',
    text: '#e6ebf5',
    flow: '#cfd6e4',
    message: '#9aa5b8',
    band: { fill: '#131a26', alt: '#131a26', header: '#1c2637', stroke: '#8792a8', text: '#e6ebf5' },
    external: { fill: '#19212f', stroke: '#8792a8' },
    roles: uniform({ fill: '#161d2a', stroke: '#d6dce8' }),
  },
  blueprint: {
    dark: true,
    background: '#0b1526',
    paper: '#0b1526',
    text: '#d7e6ff',
    flow: '#8cb4ff',
    message: '#6f93d2',
    band: { fill: '#0e1b31', alt: '#101f38', header: '#152848', stroke: '#3f65a8', text: '#d7e6ff' },
    external: { fill: '#122240', stroke: '#3f65a8' },
    roles: uniform({ fill: '#132748', stroke: '#8cb4ff' }),
  },
};

export function getTheme(style: DiagramStyle, dark = false): DiagramTheme {
  return (dark ? DARK : LIGHT)[style] ?? LIGHT.color;
}
