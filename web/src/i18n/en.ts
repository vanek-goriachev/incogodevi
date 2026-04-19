/**
 * English UI strings.
 *
 * NFR-12 mandates English-only UI. There is no i18n layer; the strings are
 * collected here as plain constants so future copy changes are localized to
 * one file and so component code stays focused on logic, not wording.
 */

export const LANDING_STRINGS = {
  pageTitle: 'Go Dependencies Visualizer',
  dropZoneHeading: 'Drop a .zip here',
  dropZoneOrBrowse: 'or click to browse',
  dropZoneActiveHeading: 'Release to upload',
  requirementsLabel: 'Requirements:',
  requirementGoMod: 'go.mod at archive root',
  requirementSize: 'up to 50 MB and 10 000 files',
  uploadingLabel: 'Uploading',
  uploadingFallback: 'Uploading\u2026',
  recentHeading: 'Recent projects',
  recentRestore: 'Restore',
  recentForget: 'Forget',
  recentExpiredToast: 'Project expired \u2014 please re-upload.',
  recentRestoreFailed: 'Could not restore project. Please try again.',
  uploadSuccessToast: (name: string): string => `Uploaded ${name}.`,
} as const;

/**
 * Maps API error codes (api-contract §1) to inline-message text shown next to
 * the drop-zone. Codes outside this map fall back to `unknown`.
 */
export const UPLOAD_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_zip: 'archive is not a valid zip file',
  go_mod_missing: 'archive is missing go.mod at root',
  zip_slip_detected:
    'archive contains unsafe paths (zip-slip detected); please repackage from the project root',
  archive_too_large: 'archive is larger than 50 MB',
  file_count_exceeded: 'archive contains more than 10 000 files',
  unpacked_size_exceeded:
    'archive expands to more than 500 MB once unpacked (suspected zip bomb)',
  not_a_zip: 'selected file is not a .zip',
  file_too_large_client: 'archive is larger than 50 MB',
  network_error: 'network error during upload; please try again',
  aborted: 'upload was cancelled',
};

/** Human-readable fallback for unknown error codes. */
export const UPLOAD_UNKNOWN_ERROR = 'upload failed; please try again';

/**
 * Translate an `ApiError`-like envelope into the inline message shown on the
 * landing page. Extracted as a helper so both `useUpload` and the test suite
 * use the same lookup table.
 */
export function uploadErrorMessage(code: string): string {
  return UPLOAD_ERROR_MESSAGES[code] ?? UPLOAD_UNKNOWN_ERROR;
}
