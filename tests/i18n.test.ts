import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ptBR from '../src/i18n/locales/pt-BR.json';
import { FOCUSES } from '../src/core/report/focuses';
import { NODE_TYPES } from '../src/core/model/types';

function flatten(value: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === 'string') out[path] = entry;
    else Object.assign(out, flatten(entry, path));
  }
  return out;
}

const base = flatten(en);
const placeholders = (text: string): string[] => (text.match(/\{\{\w+\}\}/g) ?? []).sort();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('translations', () => {
  for (const [name, locale] of [
    ['pt-BR', ptBR],
    ['es', es],
  ] as const) {
    it(`${name} has exactly the keys and placeholders of English`, () => {
      const other = flatten(locale);
      expect(Object.keys(other).sort()).toEqual(Object.keys(base).sort());
      for (const [key, text] of Object.entries(base)) {
        expect(placeholders(other[key]), key).toEqual(placeholders(text));
        expect(other[key].trim(), key).not.toBe('');
      }
    });
  }

  it('covers every report focus, node type and plural form', () => {
    for (const focus of FOCUSES) {
      expect(base[`focus.${focus.id}.name`], focus.id).toBeTruthy();
      expect(base[`focus.${focus.id}.description`], focus.id).toBeTruthy();
    }
    for (const type of NODE_TYPES) expect(base[`nodeType.${type}`], type).toBeTruthy();
    for (const key of Object.keys(base)) {
      if (key.endsWith('_one')) expect(base[key.replace(/_one$/, '_other')], key).toBeTruthy();
    }
  });

  it('defines every key the interface uses', () => {
    const used = new Set<string>();
    for (const file of sourceFiles('src')) {
      const code = readFileSync(file, 'utf8');
      for (const match of code.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(match[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((key) => !(key in base) && !(`${key}_one` in base));
    expect(missing).toEqual([]);
  });
});
