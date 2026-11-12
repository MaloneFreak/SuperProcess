/**
 * Text measurement and wrapping without a DOM.
 *
 * Every exporter needs the same line breaks, and several of them run where no
 * canvas exists (unit tests, the Visio and draw.io writers). So widths are
 * estimated from the Arial/Helvetica advance-width table, which is also the
 * font the diagrams are drawn in.
 */

// Advance widths in 1/1000 em for printable ASCII (Helvetica/Arial metrics).
const ASCII_WIDTHS: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z { | } ~
];

const BOLD_FACTOR = 1.07;

function charWidth(code: number): number {
  if (code >= 32 && code < 127) return ASCII_WIDTHS[code - 32];
  if (code < 32) return 0;
  // Latin-1 and Latin Extended letters are close to their base letters.
  if (code < 0x250) return code >= 0xc0 && code <= 0xde ? 690 : 556;
  // Greek and Cyrillic.
  if (code < 0x530) return 600;
  // CJK, kana, hangul and full-width forms are square.
  if (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  ) {
    return 1000;
  }
  return 600;
}

/** Estimated width of `text` in pixels at `fontSize`. */
export function measureText(text: string, fontSize: number, bold = false): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch.codePointAt(0)!);
  return (units / 1000) * fontSize * (bold ? BOLD_FACTOR : 1);
}

export interface WrapOptions {
  fontSize: number;
  maxWidth: number;
  maxLines?: number;
  bold?: boolean;
}

function breakLongWord(word: string, opts: WrapOptions): string[] {
  const parts: string[] = [];
  let current = '';
  for (const ch of word) {
    if (current && measureText(current + ch, opts.fontSize, opts.bold) > opts.maxWidth) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Greedy word wrap. Words wider than a line are split; when `maxLines` is
 * exceeded the last line ends with an ellipsis.
 */
export function wrapText(text: string, opts: WrapOptions): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean
    .split(' ')
    .flatMap((word) =>
      measureText(word, opts.fontSize, opts.bold) > opts.maxWidth ? breakLongWord(word, opts) : [word],
    );

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measureText(candidate, opts.fontSize, opts.bold) > opts.maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  const maxLines = opts.maxLines ?? Infinity;
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && measureText(`${last}…`, opts.fontSize, opts.bold) > opts.maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

/** Width of the widest line. */
export function blockWidth(lines: string[], fontSize: number, bold = false): number {
  return lines.reduce((max, line) => Math.max(max, measureText(line, fontSize, bold)), 0);
}
