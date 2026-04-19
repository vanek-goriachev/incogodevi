/**
 * `useUpload` — React hook owning the lifecycle of a single ZIP upload.
 *
 * Encapsulates client-side validation (extension, size), progress reporting
 * (XHR `upload.onprogress`), success-side bookkeeping (recent-projects list
 * + navigate to Analyzing) and error mapping (api-contract §1 codes →
 * human-readable English).
 *
 * Server is authoritative on every limit: the client check exists only to
 * give users immediate feedback when the file is obviously oversized.
 */

import { useCallback, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../../api/client';
import type { ProjectMeta } from '../../api/types';
import { uploadErrorMessage } from '../../i18n/en';

/** Hard client-side limits aligned with NFR-04 / api-contract §1. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_BYTES_HUMAN = '50 MB';

export type UploadStatus = 'idle' | 'uploading' | 'error' | 'success';

export interface UploadState {
  status: UploadStatus;
  /** Bytes uploaded so far (0 while idle/error). */
  loaded: number;
  /** Total bytes (`undefined` until the XHR knows `lengthComputable`). */
  total: number | undefined;
  /** Inline error message for the drop-zone (English). */
  errorMessage: string | null;
  /** Backend error code or synthetic client code, for analytics/tests. */
  errorCode: string | null;
  /** Filename of the file currently uploading (or last attempted). */
  fileName: string | null;
}

export interface UseUploadOptions {
  apiClient: ApiClient;
  /** Called once the backend returns 201; meta is forwarded. */
  onSuccess: (meta: ProjectMeta) => void;
  /** Called on validation/server error; receives the inline message and code. */
  onError?: (message: string, code: string) => void;
}

export interface UseUploadApi extends UploadState {
  /** Begin an upload. Resets prior error state. */
  upload: (file: File) => void;
  /** Manually clear an inline error (e.g. user picked a new file). */
  clearError: () => void;
}

const INITIAL_STATE: UploadState = {
  status: 'idle',
  loaded: 0,
  total: undefined,
  errorMessage: null,
  errorCode: null,
  fileName: null,
};

export function useUpload(opts: UseUploadOptions): UseUploadApi {
  const { apiClient, onSuccess, onError } = opts;
  const [state, setState] = useState<UploadState>(INITIAL_STATE);

  // The latest callbacks are kept in refs so the returned `upload` callback
  // does not need to be re-created on every render. Components can call it
  // from event handlers without dependency churn.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const fail = useCallback((code: string, message: string, fileName: string) => {
    setState({
      status: 'error',
      loaded: 0,
      total: undefined,
      errorCode: code,
      errorMessage: message,
      fileName,
    });
    onErrorRef.current?.(message, code);
  }, []);

  const upload = useCallback(
    (file: File) => {
      const validation = validateFile(file);
      if (validation !== null) {
        fail(validation.code, validation.message, file.name);
        return;
      }

      setState({
        status: 'uploading',
        loaded: 0,
        total: file.size,
        errorCode: null,
        errorMessage: null,
        fileName: file.name,
      });

      apiClient
        .uploadProject(file, undefined, (loaded, total) => {
          setState((prev) =>
            prev.status === 'uploading'
              ? { ...prev, loaded, total: total ?? prev.total }
              : prev,
          );
        })
        .then((meta) => {
          setState({
            status: 'success',
            loaded: file.size,
            total: file.size,
            errorCode: null,
            errorMessage: null,
            fileName: file.name,
          });
          onSuccessRef.current(meta);
        })
        .catch((err: unknown) => {
          const code = err instanceof ApiError ? err.code : 'network_error';
          fail(code, uploadErrorMessage(code), file.name);
        });
    },
    [apiClient, fail],
  );

  const clearError = useCallback(() => {
    setState((prev) =>
      prev.status === 'error'
        ? { ...prev, status: 'idle', errorCode: null, errorMessage: null }
        : prev,
    );
  }, []);

  return { ...state, upload, clearError };
}

interface ValidationFailure {
  code: string;
  message: string;
}

/**
 * Returns `null` if the file passes both checks, otherwise the first failure.
 * Validation order matches user expectations: wrong file type beats size.
 */
export function validateFile(file: File): ValidationFailure | null {
  if (!isZipFile(file)) {
    return { code: 'not_a_zip', message: uploadErrorMessage('not_a_zip') };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      code: 'file_too_large_client',
      message: uploadErrorMessage('file_too_large_client'),
    };
  }
  return null;
}

function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith('.zip')) {
    return true;
  }
  // Some browsers omit the extension when the user picks via "Files" UI but
  // still set the MIME type correctly.
  return file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}
