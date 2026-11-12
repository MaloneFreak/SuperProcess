/**
 * Saving files. Chromium browsers and the desktop app show a native
 * "Save as" dialog so the user picks the folder; other browsers fall back to
 * a regular download.
 */

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

interface FileHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

type Picker = (options: SaveFilePickerOptions) => Promise<FileHandle>;

/** Removes characters that are not allowed in file names on Windows, macOS or Linux. */
export function safeFileName(name: string, fallback = 'process'): string {
  const clean = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (clean || fallback).slice(0, 120);
}

/** Returns false when the user cancelled the dialog. */
export async function saveFile(blob: Blob, fileName: string, description = ''): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot) : '';
  if (picker && extension) {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: description || extension.slice(1).toUpperCase(), accept: { [blob.type || 'application/octet-stream']: [extension] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      // Permission or security errors: fall through to a plain download.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
