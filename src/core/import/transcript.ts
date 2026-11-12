/**
 * Transcript readers: WebVTT (Teams, Zoom, Meet), SubRip, the JSON written by
 * speech-to-text tools (Whisper, WhisperX, AssemblyAI, Deepgram, AWS
 * Transcribe) and Word documents. All of them reduce to plain text in which
 * each speaker turn is one paragraph, prefixed with a coarse timestamp so the
 * AI can point at where something was said.
 */
import { strFromU8, unzipSync } from 'fflate';
import { children, descendants, parseXml } from './xml';

interface Cue {
  /** Start time in seconds, when known. */
  start?: number;
  speaker?: string;
  text: string;
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function parseClock(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Merges consecutive cues of one speaker into turns and renders them as text. */
export function cuesToText(cues: Cue[]): string {
  const turns: Cue[] = [];
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    const sameSpeaker = last && (last.speaker ?? '') === (cue.speaker ?? '');
    // Without speakers, break into paragraphs so timestamps stay useful.
    if (sameSpeaker && (cue.speaker || last.text.length < 600)) last.text += ` ${text}`;
    else turns.push({ ...cue, text });
  }
  return turns
    .map((turn) => {
      const stamp = turn.start !== undefined ? `[${clock(turn.start)}] ` : '';
      return `${stamp}${turn.speaker ? `${turn.speaker}: ` : ''}${turn.text}`;
    })
    .join('\n');
}

function stripCueTags(text: string): { speaker?: string; text: string } {
  let speaker: string | undefined;
  const voice = text.match(/<v(?:\.[^\s>]*)?\s+([^>]+)>/);
  if (voice) speaker = voice[1].trim();
  return { speaker, text: text.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') };
}

/** Splits "Name: words" into speaker and text when the prefix looks like a name. */
function inlineSpeaker(text: string): { speaker?: string; text: string } {
  const match = text.match(/^([\p{L}\p{N}][\p{L}\p{N} .'’()_-]{0,40}):\s+(.*)$/su);
  if (match && match[1].split(' ').length <= 5) return { speaker: match[1].trim(), text: match[2] };
  return { text };
}

function parseTimedBlocks(source: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = source.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0) continue;
    const start = parseClock(lines[timing].split('-->')[0]);
    const payload = lines.slice(timing + 1).join(' ');
    const tagged = stripCueTags(payload);
    const inline = tagged.speaker ? tagged : inlineSpeaker(tagged.text);
    cues.push({ start, speaker: tagged.speaker ?? inline.speaker, text: inline.text });
  }
  return cues;
}

export function parseVtt(source: string): string {
  return cuesToText(parseTimedBlocks(source));
}

export function parseSrt(source: string): string {
  return cuesToText(parseTimedBlocks(source));
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

function cuesFromArray(items: unknown[], millis: boolean): Cue[] {
  const cues: Cue[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const text = str(item.text ?? item.transcript ?? item.content ?? item.sentence ?? item.words_text);
    if (!text) continue;
    const startRaw = item.start ?? item.start_time ?? item.startTime ?? item.offset;
    const start = typeof startRaw === 'number' ? (millis ? startRaw / 1000 : startRaw) : typeof startRaw === 'string' ? parseClock(startRaw) ?? Number(startRaw) : undefined;
    const speakerRaw = item.speaker ?? item.speaker_label ?? item.speakerName ?? item.name ?? item.user;
    const speaker = isObject(speakerRaw) ? str(speakerRaw.name ?? speakerRaw.label) : str(speakerRaw);
    cues.push({
      start: typeof start === 'number' && Number.isFinite(start) ? start : undefined,
      speaker: speaker ? (/^\d+$|^[A-Z]$/.test(speaker) ? `Speaker ${speaker}` : speaker) : undefined,
      text,
    });
  }
  return cues;
}

/** Recognises the common speech-to-text JSON layouts; returns null for anything else. */
export function parseTranscriptJson(source: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return null;
  }
  if (Array.isArray(data)) {
    const cues = cuesFromArray(data, false);
    return cues.length > 0 ? cuesToText(cues) : null;
  }
  if (!isObject(data)) return null;

  // AssemblyAI: utterances with millisecond offsets.
  if (Array.isArray(data.utterances)) {
    const cues = cuesFromArray(data.utterances, true);
    if (cues.length > 0) return cuesToText(cues);
  }
  // Whisper / WhisperX / faster-whisper.
  if (Array.isArray(data.segments)) {
    const cues = cuesFromArray(data.segments, false);
    if (cues.length > 0) return cuesToText(cues);
  }
  // Deepgram.
  const results = isObject(data.results) ? data.results : undefined;
  const channel = results && Array.isArray(results.channels) && isObject(results.channels[0]) ? results.channels[0] : undefined;
  const alternative = channel && Array.isArray(channel.alternatives) && isObject(channel.alternatives[0]) ? channel.alternatives[0] : undefined;
  if (alternative) {
    const paragraphs = isObject(alternative.paragraphs) ? alternative.paragraphs : undefined;
    if (paragraphs && Array.isArray(paragraphs.paragraphs)) {
      const cues: Cue[] = [];
      for (const paragraph of paragraphs.paragraphs) {
        if (!isObject(paragraph) || !Array.isArray(paragraph.sentences)) continue;
        const text = paragraph.sentences.map((s) => (isObject(s) ? str(s.text) : '')).join(' ');
        const speaker = paragraph.speaker !== undefined ? `Speaker ${str(paragraph.speaker)}` : undefined;
        cues.push({ start: typeof paragraph.start === 'number' ? paragraph.start : undefined, speaker, text });
      }
      if (cues.length > 0) return cuesToText(cues);
    }
    if (str(alternative.transcript)) return str(alternative.transcript);
  }
  // AWS Transcribe.
  if (results && Array.isArray(results.transcripts) && isObject(results.transcripts[0])) {
    const text = str(results.transcripts[0].transcript);
    if (text) return text;
  }
  for (const key of ['transcript', 'transcription', 'messages', 'entries', 'results', 'items']) {
    if (Array.isArray(data[key])) {
      const cues = cuesFromArray(data[key] as unknown[], false);
      if (cues.length > 0) return cuesToText(cues);
    }
  }
  for (const key of ['text', 'transcript', 'transcription']) if (str(data[key])) return str(data[key]);
  return null;
}

/** Plain text of a Word document: paragraphs, line breaks and tables. */
export function parseDocx(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => file.name === 'word/document.xml' });
  } catch {
    throw new Error('This file is not a valid .docx document.');
  }
  const part = files['word/document.xml'];
  if (!part) throw new Error('This file is not a valid .docx document.');
  const body = descendants(parseXml(strFromU8(part)), 'body')[0];
  if (!body) return '';

  const paragraph = (p: Element): string => {
    let text = '';
    const visit = (node: Element): void => {
      for (const element of children(node)) {
        if (element.localName === 't') text += element.textContent ?? '';
        else if (element.localName === 'tab') text += '\t';
        else if (element.localName === 'br' || element.localName === 'cr') text += '\n';
        else if (element.localName !== 'pPr' && element.localName !== 'rPr') visit(element);
      }
    };
    visit(p);
    return text.trim();
  };

  const lines: string[] = [];
  const block = (parent: Element): void => {
    for (const element of children(parent)) {
      if (element.localName === 'p') {
        const text = paragraph(element);
        if (text) lines.push(text);
      } else if (element.localName === 'tbl') {
        for (const row of children(element, 'tr')) {
          const cells = children(row, 'tc').map((cell) => descendants(cell, 'p').map(paragraph).filter(Boolean).join(' '));
          if (cells.some(Boolean)) lines.push(cells.join(' | '));
        }
      } else if (element.localName === 'sdt' || element.localName === 'sdtContent') {
        block(element);
      }
    }
  };
  block(body);
  return lines.join('\n');
}

/** Text of a PDF, page by page. The PDF engine is loaded only when needed. */
export async function parsePdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const document = await task.promise;
  const pages: string[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str;
      text += item.hasEOL ? '\n' : ' ';
    }
    const clean = text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    if (clean) pages.push(clean);
  }
  await task.destroy();
  if (pages.length === 0) throw new Error('This PDF has no text layer (it may be a scan).');
  return pages.join('\n\n');
}
