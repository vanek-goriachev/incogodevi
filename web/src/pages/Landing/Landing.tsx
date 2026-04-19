/**
 * Landing screen — drop-zone for ZIP upload + recent-projects list.
 *
 * Implements design.md §3.1 wireframe and §4 interaction table:
 *   - Drag-anywhere: any drag entering the document highlights the drop-zone.
 *   - Drop or browse: triggers `useUpload`; success navigates to Analyzing.
 *   - Recent projects: persisted in `go-viz:recent-projects`, restorable to
 *     the Main view when the backend still has the cached graph (J3).
 *
 * The component owns minimal state — the upload lifecycle lives in
 * `useUpload`, the recent list lives in localStorage. Toast surfaces are
 * delegated to `useToast` so the Landing screen never renders ad-hoc UI for
 * notifications.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type JSX } from 'react';

import { ApiError, type ApiClient } from '../../api/client';
import { useRouter } from '../../app/Router';
import { useToast } from '../../app/Toasts';
import { LANDING_STRINGS } from '../../i18n/en';
import {
  RECENT_PROJECTS_LIMIT,
  purgeProjectStorage,
  readRecentProjects,
  removeRecentProject,
  upsertRecentProject,
  type RecentProject,
} from '../../storage/recentProjects';
import { RECENT_PROJECTS_KEY } from '../../storage/keys';
import { formatRelativeTime } from '../../util/relativeTime';
import { useUpload } from './useUpload';

export interface LandingProps {
  apiClient: ApiClient;
}

export function Landing({ apiClient }: LandingProps): JSX.Element {
  const { navigate } = useRouter();
  const { showToast } = useToast();
  const [recent, setRecent] = useState<RecentProject[]>(() => readRecentProjects());
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const upload = useUpload({
    apiClient,
    onSuccess: (meta) => {
      const next: RecentProject = {
        project_id: meta.project_id,
        name: meta.name,
        uploaded_at: meta.uploaded_at,
      };
      // Persist eagerly so a navigation that unmounts this component does not
      // race the recent-projects write.
      const updated = upsertRecentProject(readRecentProjects(), next);
      try {
        window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(updated));
      } catch {
        // Quota / disabled storage — keep in memory and continue navigation.
      }
      setRecent(updated);
      showToast(LANDING_STRINGS.uploadSuccessToast(meta.name), 'success');
      navigate('analyzing', { projectId: meta.project_id, projectName: meta.name });
    },
    onError: (message) => {
      showToast(message, 'error');
    },
  });

  // Keep the displayed list in sync with localStorage updates from other tabs
  // (e.g. user uploaded the same project in a second window).
  useEffect(() => {
    function onStorage(evt: StorageEvent): void {
      if (evt.key !== null && evt.key !== RECENT_PROJECTS_KEY) {
        return;
      }
      setRecent(readRecentProjects());
    }
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Document-level drag listeners so the user can drop the file anywhere on
  // the landing screen — not only on the labelled rectangle (design.md §4).
  useEffect(() => {
    function onDocDragEnter(evt: DragEvent | Event): void {
      if (!isFileDrag(evt)) {
        return;
      }
      evt.preventDefault();
      dragDepthRef.current += 1;
      setDragging(true);
    }
    function onDocDragOver(evt: DragEvent | Event): void {
      if (!isFileDrag(evt)) {
        return;
      }
      // Required for `drop` to fire (HTML drag-drop spec).
      evt.preventDefault();
    }
    function onDocDragLeave(evt: DragEvent | Event): void {
      if (!isFileDrag(evt)) {
        return;
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setDragging(false);
      }
    }
    function onDocDrop(evt: DragEvent | Event): void {
      if (!isFileDrag(evt)) {
        return;
      }
      evt.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
    }
    document.addEventListener('dragenter', onDocDragEnter);
    document.addEventListener('dragover', onDocDragOver);
    document.addEventListener('dragleave', onDocDragLeave);
    document.addEventListener('drop', onDocDrop);
    return () => {
      document.removeEventListener('dragenter', onDocDragEnter);
      document.removeEventListener('dragover', onDocDragOver);
      document.removeEventListener('dragleave', onDocDragLeave);
      document.removeEventListener('drop', onDocDrop);
    };
  }, []);

  const onZoneDrop = useCallback(
    (evt: DragEvent<HTMLLabelElement>) => {
      evt.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      const file = pickFirstFile(evt.dataTransfer);
      if (file !== null) {
        upload.upload(file);
      }
    },
    [upload],
  );

  const onZoneDragOver = useCallback((evt: DragEvent<HTMLLabelElement>) => {
    evt.preventDefault();
  }, []);

  const onZoneClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onZoneKeyDown = useCallback((evt: React.KeyboardEvent<HTMLLabelElement>) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      fileInputRef.current?.click();
    }
  }, []);

  const onFilePicked = useCallback(
    (evt: React.ChangeEvent<HTMLInputElement>) => {
      const file = evt.target.files?.[0];
      // Reset so picking the same file again still fires `change` (browsers
      // skip the event when the value is unchanged).
      evt.target.value = '';
      if (file !== undefined) {
        upload.upload(file);
      }
    },
    [upload],
  );

  const onForget = useCallback((projectId: string) => {
    setRecent((prev) => {
      const updated = removeRecentProject(prev, projectId);
      try {
        window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(updated));
      } catch {
        // ignore — see useLocalStorage
      }
      purgeProjectStorage(projectId);
      return updated;
    });
  }, []);

  const onRestore = useCallback(
    (project: RecentProject) => {
      setRestoringId(project.project_id);
      apiClient
        .getGraph(project.project_id)
        .then(() => {
          navigate('main', {
            projectId: project.project_id,
            projectName: project.name,
          });
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) {
            showToast(LANDING_STRINGS.recentExpiredToast, 'warning');
            // Drop the stale entry — re-upload is the only recovery.
            setRecent((prev) => {
              const updated = removeRecentProject(prev, project.project_id);
              try {
                window.localStorage.setItem(
                  RECENT_PROJECTS_KEY,
                  JSON.stringify(updated),
                );
              } catch {
                // ignore
              }
              return updated;
            });
            return;
          }
          showToast(LANDING_STRINGS.recentRestoreFailed, 'error');
        })
        .finally(() => {
          setRestoringId((current) =>
            current === project.project_id ? null : current,
          );
        });
    },
    [apiClient, navigate, showToast],
  );

  const zoneClassName = [
    'landing__zone',
    dragging ? 'landing__zone--dragging' : '',
    upload.status === 'uploading' ? 'landing__zone--uploading' : '',
    upload.status === 'error' ? 'landing__zone--error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const progressPercent = computeProgressPercent(upload.loaded, upload.total);

  return (
    <section className="screen screen--landing landing" data-testid="screen-landing">
      <div className="landing__hero">
        <label
          className={zoneClassName}
          data-testid="landing-zone"
          data-state={upload.status}
          onDrop={onZoneDrop}
          onDragOver={onZoneDragOver}
          onClick={onZoneClick}
          onKeyDown={onZoneKeyDown}
          tabIndex={0}
          role="button"
          aria-label={
            upload.status === 'uploading'
              ? LANDING_STRINGS.uploadingFallback
              : `${LANDING_STRINGS.dropZoneHeading}, ${LANDING_STRINGS.dropZoneOrBrowse}`
          }
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="landing__file-input visually-hidden"
            onChange={onFilePicked}
            data-testid="landing-file-input"
          />
          <div className="landing__zone-body">
            {upload.status === 'uploading' ? (
              <UploadingState
                fileName={upload.fileName ?? ''}
                percent={progressPercent}
                computable={upload.total !== undefined}
              />
            ) : (
              <IdleState dragging={dragging} />
            )}
          </div>
          <ul className="landing__requirements" aria-label={LANDING_STRINGS.requirementsLabel}>
            <li>{LANDING_STRINGS.requirementGoMod}</li>
            <li>{LANDING_STRINGS.requirementSize}</li>
          </ul>
        </label>
        {upload.status === 'error' && upload.errorMessage !== null ? (
          <p
            className="landing__error"
            role="alert"
            data-testid="landing-error"
            data-error-code={upload.errorCode ?? ''}
          >
            {upload.errorMessage}
          </p>
        ) : null}
      </div>
      {recent.length > 0 ? (
        <RecentProjectsList
          items={recent}
          restoringId={restoringId}
          onRestore={onRestore}
          onForget={onForget}
        />
      ) : null}
    </section>
  );
}

interface IdleStateProps {
  dragging: boolean;
}

function IdleState({ dragging }: IdleStateProps): JSX.Element {
  return (
    <>
      <div className="landing__icon" aria-hidden="true">
        <ArrowDownIcon />
      </div>
      <p className="landing__heading">
        {dragging ? LANDING_STRINGS.dropZoneActiveHeading : LANDING_STRINGS.dropZoneHeading}
      </p>
      {!dragging ? (
        <p className="landing__sub">{LANDING_STRINGS.dropZoneOrBrowse}</p>
      ) : null}
    </>
  );
}

interface UploadingStateProps {
  fileName: string;
  percent: number | null;
  computable: boolean;
}

function UploadingState({ fileName, percent, computable }: UploadingStateProps): JSX.Element {
  const label =
    computable && percent !== null
      ? `${LANDING_STRINGS.uploadingLabel} ${fileName} (${String(percent)}%)`
      : `${LANDING_STRINGS.uploadingFallback} ${fileName}`;
  return (
    <>
      <p className="landing__heading">{label}</p>
      <div
        className="landing__progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label={LANDING_STRINGS.uploadingLabel}
        data-testid="landing-progress"
      >
        <div
          className="landing__progress-bar"
          style={{ width: percent !== null ? `${String(percent)}%` : '100%' }}
          data-indeterminate={percent === null ? 'true' : 'false'}
        />
      </div>
    </>
  );
}

interface RecentListProps {
  items: RecentProject[];
  restoringId: string | null;
  onRestore: (p: RecentProject) => void;
  onForget: (id: string) => void;
}

function RecentProjectsList({
  items,
  restoringId,
  onRestore,
  onForget,
}: RecentListProps): JSX.Element {
  return (
    <section className="landing__recent" aria-labelledby="landing-recent-heading">
      <h3 id="landing-recent-heading" className="landing__recent-heading">
        {LANDING_STRINGS.recentHeading}
      </h3>
      <ul className="landing__recent-list" data-testid="landing-recent-list">
        {items.slice(0, RECENT_PROJECTS_LIMIT).map((project) => (
          <li key={project.project_id} className="landing__recent-item">
            <span className="landing__recent-name">{project.name}</span>
            <span className="landing__recent-time">
              {formatRelativeTime(project.uploaded_at)}
            </span>
            <button
              type="button"
              className="landing__recent-action"
              onClick={() => {
                onRestore(project);
              }}
              disabled={restoringId === project.project_id}
              data-testid={`landing-restore-${project.project_id}`}
            >
              {LANDING_STRINGS.recentRestore}
            </button>
            <button
              type="button"
              className="landing__recent-action landing__recent-action--secondary"
              onClick={() => {
                onForget(project.project_id);
              }}
              data-testid={`landing-forget-${project.project_id}`}
            >
              {LANDING_STRINGS.recentForget}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArrowDownIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor">
      <path
        d="M12 4v14m0 0l-6-6m6 6l6-6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function isFileDrag(evt: Event | DragEvent): boolean {
  const dt = (evt as DragEvent).dataTransfer;
  if (dt === null || dt === undefined) {
    return false;
  }
  if (dt.types === undefined) {
    return false;
  }
  // `DataTransfer.types` contains 'Files' for file drags from the OS.
  for (let i = 0; i < dt.types.length; i += 1) {
    if (dt.types[i] === 'Files') {
      return true;
    }
  }
  return false;
}

function pickFirstFile(dt: DataTransfer | null): File | null {
  if (dt === null) {
    return null;
  }
  if (dt.files.length > 0) {
    return dt.files[0] ?? null;
  }
  for (let i = 0; i < dt.items.length; i += 1) {
    const item = dt.items[i];
    if (item !== undefined && item.kind === 'file') {
      const file = item.getAsFile();
      if (file !== null) {
        return file;
      }
    }
  }
  return null;
}

function computeProgressPercent(loaded: number, total: number | undefined): number | null {
  if (total === undefined || total <= 0) {
    return null;
  }
  const ratio = Math.min(1, Math.max(0, loaded / total));
  return Math.round(ratio * 100);
}
