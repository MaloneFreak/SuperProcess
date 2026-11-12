/**
 * Turns any supported input file into a SourceDocument: a named block of text
 * the AI can read. Transcripts become speaker turns, existing diagrams become
 * a compact structural description.
 */
import { importBpmn } from './bpmn';
import { importDrawio } from './drawio';
import { parseDocx, parsePdf, parseSrt, parseTranscriptJson, parseVtt } from './transcript';
import { importVsdx } from './vsdx';
import { htmlToText } from './xml';

export type SourceKind = 'transcript' | 'diagram' | 'document';

export interface SourceDocument {
  name: string;
  kind: SourceKind;
  /** Short format label shown in the UI, e.g. "Visio", "WebVTT". */
  format: string;
  text: string;
}

/** Extensions offered in the file picker. Anything else is tried as plain text. */
export const ACCEPTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.vtt',
  '.srt',
  '.docx',
  '.pdf',
  '.json',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.vsdx',
  '.vsdm',
  '.bpmn',
  '.drawio',
  '.xml',
  '.mmd',
  '.puml',
];

export class UnsupportedFileError extends Error {
  constructor(
    message: string,
    /** Translation key suffix for a friendlier explanation. */
    readonly reason: 'legacyVisio' | 'audio' | 'image' | 'binary' | 'empty',
  ) {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4000);
  let suspicious = 0;
  for (const byte of sample) if (byte === 0 || (byte < 9 && byte !== 0)) suspicious++;
  return sample.length > 0 && suspicious / sample.length > 0.02;
}

const AUDIO = new Set(['mp3', 'wav', 'm4a', 'mp4', 'ogg', 'flac', 'webm', 'aac', 'wma', 'mov', 'mkv']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic']);

export async function ingest(name: string, bytes: Uint8Array): Promise<SourceDocument> {
  const ext = extensionOf(name);
  const diagram = (format: string, sketch: unknown): SourceDocument => ({
    name,
    kind: 'diagram',
    format,
    text: JSON.stringify(sketch),
  });
  const finish = (kind: SourceKind, format: string, text: string): SourceDocument => {
    const clean = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!clean) throw new UnsupportedFileError(`${name} is empty.`, 'empty');
    return { name, kind, format, text: clean };
  };

  if (ext === 'vsd' || ext === 'vss' || ext === 'vdx') {
    throw new UnsupportedFileError(`${name}: legacy Visio format.`, 'legacyVisio');
  }
  if (AUDIO.has(ext)) throw new UnsupportedFileError(`${name}: audio and video files are not transcribed.`, 'audio');
  if (IMAGE.has(ext)) throw new UnsupportedFileError(`${name}: images cannot be read.`, 'image');

  if (ext === 'vsdx' || ext === 'vsdm') return diagram('Visio', importVsdx(bytes));
  if (ext === 'docx') return finish('document', 'Word', parseDocx(bytes));
  if (ext === 'pdf') return finish('document', 'PDF', await parsePdf(bytes));

  const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (!utf16 && looksBinary(bytes)) throw new UnsupportedFileError(`${name}: unsupported binary file.`, 'binary');
  const text = decodeText(bytes);

  if (ext === 'bpmn') return diagram('BPMN 2.0', importBpmn(text));
  if (ext === 'drawio') return diagram('draw.io', importDrawio(text));
  if (ext === 'xml') {
    const head = text.slice(0, 2000);
    if (/<([\w-]+:)?definitions[\s>]/.test(head) && /BPMN/i.test(head)) return diagram('BPMN 2.0', importBpmn(text));
    if (/<mxfile[\s>]|<mxGraphModel[\s>]/.test(head)) return diagram('draw.io', importDrawio(text));
    return finish('document', 'XML', text);
  }
  if (ext === 'vtt') return finish('transcript', 'WebVTT', parseVtt(text));
  if (ext === 'srt') return finish('transcript', 'SubRip', parseSrt(text));
  if (ext === 'json') {
    const transcript = parseTranscriptJson(text);
    return transcript ? finish('transcript', 'JSON transcript', transcript) : finish('document', 'JSON', text);
  }
  if (ext === 'html' || ext === 'htm') return finish('document', 'HTML', htmlToText(text));
  if (ext === 'mmd' || ext === 'puml') return finish('diagram', ext === 'mmd' ? 'Mermaid' : 'PlantUML', text);
  // Subtitle-style text saved with another extension.
  if (/^WEBVTT/.test(text) || /^\d+\s*\n\d\d:\d\d:\d\d[,.]\d+ -->/.test(text)) return finish('transcript', 'WebVTT', parseVtt(text));
  return finish(ext === 'md' || ext === 'csv' || ext === 'tsv' ? 'document' : 'transcript', 'Text', text);
}
