import type { TFunction } from 'i18next';
import { UnsupportedFileError } from '../core/import';
import type { Failure } from '../state/session';

/** A message the user can act on for a failed AI request. */
export function failureText(t: TFunction, failure: Failure, model: string, local: boolean): string {
  if (failure.kind === 'network' && local) return t('error.networkLocal');
  const known = [
    'auth',
    'rateLimit',
    'network',
    'modelNotFound',
    'refusal',
    'truncated',
    'invalidOutput',
    'tooLong',
    'badRequest',
    'server',
    'notConfigured',
    'aborted',
  ];
  const key = known.includes(failure.kind) ? failure.kind : 'unknown';
  return t(`error.${key}`, { model, message: failure.message });
}

/** A message for a file that could not be added. */
export function fileErrorText(t: TFunction, name: string, error: unknown): string {
  if (error instanceof UnsupportedFileError) {
    const key = { legacyVisio: 'fileLegacyVisio', audio: 'fileAudio', image: 'fileImage', binary: 'fileBinary', empty: 'fileEmpty' }[error.reason];
    return t(`home.${key}`, { name });
  }
  return t('home.fileError', { name, message: error instanceof Error ? error.message : String(error) });
}
