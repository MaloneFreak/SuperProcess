/**
 * Lenient JSON extraction from model output.
 *
 * With schema-constrained decoding the answer is already valid JSON. Without
 * it (servers that ignore the schema, small local models) the object may be
 * wrapped in a code fence, preceded by reasoning, or cut off. This recovers
 * what can be recovered and fails clearly otherwise.
 */
import { AiError } from './types';

function stripNoise(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^﻿/, '')
    .trim();
}

/** Returns the text from the first `{` to its matching `}` (or to the end if it never closes). */
function outermostObject(text: string): { body: string; closed: boolean } | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return { body: text.slice(start, i + 1), closed: true };
    }
  }
  return { body: text.slice(start), closed: false };
}

/** Closes whatever is still open in a truncated JSON text, dropping the unfinished tail. */
function closeTruncated(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = 0; // index after the last complete value at any depth
  let safeStack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      lastSafe = i + 1;
      safeStack = [...stack];
    } else if (ch === ',' && (stack[stack.length - 1] === ']' || stack.length === 1)) {
      // A comma after a complete array element or top-level property. Commas
      // inside nested objects are skipped so no half-filled object survives.
      lastSafe = i;
      safeStack = [...stack];
    }
  }
  const head = text.slice(0, lastSafe).replace(/,\s*$/, '');
  return head + safeStack.reverse().join('');
}

export interface ParsedJson {
  value: unknown;
  /** True when the text was cut off and only its complete part was kept. */
  truncated: boolean;
}

export function parseJsonLenient(raw: string): ParsedJson {
  const text = stripNoise(raw);
  const found = outermostObject(text);
  if (!found) throw new AiError('invalidOutput', 'The model did not return a JSON object.');

  const attempts = [found.body, found.body.replace(/,\s*([}\]])/g, '$1')];
  for (const attempt of attempts) {
    try {
      return { value: JSON.parse(attempt), truncated: false };
    } catch {
      // try the next repair
    }
  }
  if (!found.closed) {
    try {
      return { value: JSON.parse(closeTruncated(found.body)), truncated: true };
    } catch {
      // fall through
    }
  }
  throw new AiError('invalidOutput', 'The model returned malformed JSON.');
}

/** Rough token estimate that errs on the high side for Latin-script languages. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}
