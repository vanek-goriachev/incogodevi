/**
 * Top-bar drag-and-drop Layer Editor strip (R12 / feat/layer-editor).
 *
 * The bar sits directly above the canvas and exposes:
 *
 *   - one column ("slot") per x-position in the layout,
 *   - inside each slot, a vertical stack of "lane chips" (each chip is
 *     either a BFS-depth lane or a user-defined folder-group),
 *   - an "+ Группа" inline form for creating new folder groups by prefix,
 *   - a "Сбросить" button to drop back to the default state,
 *   - an "unassigned" tray for lanes the user temporarily parked.
 *
 * **feat/overlap-presets-package-filter** adds:
 *
 *   - a "Пресет" dropdown that loads a saved arrangement into the editor,
 *   - "Сохранить как…" / "Удалить" buttons for managing the named-preset
 *     list. Presets persist under `go-viz:<id>:layer-presets`.
 *   - "Экспорт" / "Импорт" buttons that drop a portable `goviz1:<base64>`
 *     string into a small modal (copy via the native clipboard API).
 *   - an imperative `openAddGroupWithPrefix(prefix)` handle exposed via
 *     `forwardRef`, used by the FiltersPanel's "Создать группу из фильтра"
 *     button to pre-populate the inline form with a path prefix derived
 *     from the bulk filter's matches.
 *
 * Drag and drop uses the native HTML5 API (no library dependency) — the chip
 * sets `dataTransfer.setData('text/plain', laneKey)` on dragstart, and slots
 * read it back on drop. The same gesture works for both inter-slot moves
 * and intra-slot re-ordering (drop-target is the slot index plus a
 * synthesized stack index based on the y of the drop event).
 *
 * On chip hover the bar pulses every matching cytoscape node by adding a
 * `lane-pulse` class for the duration of the hover; the stylesheet rule is
 * registered through the existing graph stylesheet so we do not have to
 * mutate `cy.style()` here.
 */

import type { Core } from 'cytoscape';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import { laneKeyOf, type Lane, type LayerEditorState } from '../layout/laneMapping';
import {
  PRESET_PREFIX,
  decodePreset,
  encodePreset,
} from '../layout/layerPresets';
import type { NamedPreset } from '../useLayerEditorState';
import './LayerEditorBar.css';

export interface LayerEditorBarProps {
  state: LayerEditorState;
  /** Counts per lane key — feeds the chip label. */
  countsByLaneKey: ReadonlyMap<string, number>;
  /** Mapping of nodeId → laneKey, used to highlight nodes on chip hover. */
  nodeIdsByLaneKey: ReadonlyMap<string, readonly string[]>;
  /** Imperative state mutators wired from `useLayerEditorState`. */
  onAddGroup: (name: string, prefix: string) => void;
  onRemoveGroup: (id: string) => void;
  onMoveLane: (laneKey: string, toSlotIndex: number, toStackIndex: number) => void;
  onReset: () => void;
  /** Replace the entire state — used by Import + preset load. */
  onReplaceState: (next: LayerEditorState) => void;
  /** Named presets list and CRUD callbacks. */
  presets: readonly NamedPreset[];
  onSavePreset: (name: string) => string;
  onLoadPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  /** Live cytoscape core — drives the hover-pulse class. May be null. */
  cy?: Core | null;
}

/** Imperative handle exposed to parents — currently just one open-form helper. */
export interface LayerEditorBarHandle {
  /** Open the "+ Группа" inline form with `prefix` pre-filled. */
  openAddGroupWithPrefix: (prefix: string) => void;
}

/** Modal kinds for the inline preset / import-export dialogs. */
type ModalKind = null | 'saveAs' | 'export' | 'import';

function LayerEditorBarInner(
  {
    state,
    countsByLaneKey,
    nodeIdsByLaneKey,
    onAddGroup,
    onRemoveGroup,
    onMoveLane,
    onReset,
    onReplaceState,
    presets,
    onSavePreset,
    onLoadPreset,
    onDeletePreset,
    cy = null,
  }: LayerEditorBarProps,
  ref: React.ForwardedRef<LayerEditorBarHandle>,
): JSX.Element {
  const [adding, setAdding] = useState<boolean>(false);
  const [nameDraft, setNameDraft] = useState<string>('');
  const [prefixDraft, setPrefixDraft] = useState<string>('');
  const [dragLaneKey, setDragLaneKey] = useState<string | null>(null);
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [modal, setModal] = useState<ModalKind>(null);
  const [saveAsDraft, setSaveAsDraft] = useState<string>('');
  const [importDraft, setImportDraft] = useState<string>('');
  const [importError, setImportError] = useState<string | null>(null);

  // Imperative handle — opened by FiltersPanel's "Создать группу из фильтра".
  useImperativeHandle(
    ref,
    () => ({
      openAddGroupWithPrefix: (prefix: string) => {
        setAdding(true);
        setPrefixDraft(prefix);
        setNameDraft('');
      },
    }),
    [],
  );

  // Hover-pulse: on chip hover we add a class to all matching cytoscape
  // nodes; on mouse-leave we strip it. Stored in a ref so we can clean up
  // even when the chip unmounts mid-hover.
  const pulseTargetsRef = useRef<string[]>([]);
  const clearPulse = useCallback(() => {
    if (cy === null) return;
    cy.batch(() => {
      for (const id of pulseTargetsRef.current) {
        cy.$id(id).removeClass('lane-pulse');
      }
    });
    pulseTargetsRef.current = [];
  }, [cy]);
  const applyPulse = useCallback(
    (laneKey: string) => {
      if (cy === null) return;
      const ids = nodeIdsByLaneKey.get(laneKey);
      if (ids === undefined) return;
      cy.batch(() => {
        for (const id of ids) {
          cy.$id(id).addClass('lane-pulse');
        }
      });
      pulseTargetsRef.current = [...ids];
    },
    [cy, nodeIdsByLaneKey],
  );
  useEffect(() => () => {
    clearPulse();
  }, [clearPulse]);

  const handleSubmitGroup = useCallback(() => {
    if (prefixDraft.trim() === '') return;
    onAddGroup(nameDraft, prefixDraft);
    setNameDraft('');
    setPrefixDraft('');
    setAdding(false);
  }, [nameDraft, prefixDraft, onAddGroup]);

  // Drag-and-drop handlers. We do everything with the native HTML5 API.
  const handleDragStart = useCallback(
    (evt: React.DragEvent<HTMLDivElement>, laneKey: string) => {
      evt.dataTransfer.effectAllowed = 'move';
      evt.dataTransfer.setData('text/plain', laneKey);
      setDragLaneKey(laneKey);
    },
    [],
  );
  const handleDragEnd = useCallback(() => {
    setDragLaneKey(null);
    setHoverSlot(null);
  }, []);
  const handleDragOver = useCallback(
    (evt: React.DragEvent<HTMLDivElement>, slotIndex: number) => {
      evt.preventDefault();
      evt.dataTransfer.dropEffect = 'move';
      if (hoverSlot !== slotIndex) setHoverSlot(slotIndex);
    },
    [hoverSlot],
  );
  const handleDrop = useCallback(
    (evt: React.DragEvent<HTMLDivElement>, slotIndex: number) => {
      evt.preventDefault();
      const laneKey = evt.dataTransfer.getData('text/plain');
      setHoverSlot(null);
      setDragLaneKey(null);
      if (laneKey === '') return;
      // Stack index = index of the closest chip above the drop point. We
      // approximate by reading the chips' bounding boxes inside the slot.
      const slotEl = evt.currentTarget;
      const chips = slotEl.querySelectorAll('.layer-editor-bar__chip');
      let stackIndex = chips.length;
      const dropY = evt.clientY;
      for (let i = 0; i < chips.length; i += 1) {
        const rect = (chips[i] as HTMLElement).getBoundingClientRect();
        if (dropY < rect.top + rect.height / 2) {
          stackIndex = i;
          break;
        }
      }
      onMoveLane(laneKey, slotIndex, stackIndex);
    },
    [onMoveLane],
  );

  // Reset clears hover state and tells the parent to restore defaults.
  const handleReset = useCallback(() => {
    setAdding(false);
    setHoverSlot(null);
    setDragLaneKey(null);
    setSelectedPresetId('');
    onReset();
  }, [onReset]);

  // ---- preset handlers --------------------------------------------------
  const handlePresetChange = useCallback(
    (evt: React.ChangeEvent<HTMLSelectElement>) => {
      const id = evt.target.value;
      setSelectedPresetId(id);
      if (id !== '') {
        onLoadPreset(id);
      }
    },
    [onLoadPreset],
  );
  const handleSaveAsOpen = useCallback(() => {
    setSaveAsDraft('');
    setModal('saveAs');
  }, []);
  const handleSaveAsConfirm = useCallback(() => {
    const name = saveAsDraft.trim();
    if (name === '') return;
    const id = onSavePreset(name);
    setSelectedPresetId(id);
    setSaveAsDraft('');
    setModal(null);
  }, [saveAsDraft, onSavePreset]);
  const handleDeletePreset = useCallback(() => {
    if (selectedPresetId === '') return;
    onDeletePreset(selectedPresetId);
    setSelectedPresetId('');
  }, [selectedPresetId, onDeletePreset]);
  const handleExportOpen = useCallback(() => {
    setModal('export');
  }, []);
  const handleImportOpen = useCallback(() => {
    setImportDraft('');
    setImportError(null);
    setModal('import');
  }, []);
  const handleImportSubmit = useCallback(() => {
    const result = decodePreset(importDraft);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    onReplaceState(result.state);
    setImportError(null);
    setImportDraft('');
    setModal(null);
  }, [importDraft, onReplaceState]);
  const closeModal = useCallback(() => {
    setModal(null);
    setImportError(null);
  }, []);

  // Encoded payload for the export modal — recomputed only when the state
  // identity changes or the modal opens.
  const exportPayload = useMemo<string>(() => {
    if (modal !== 'export') return '';
    return encodePreset(state);
  }, [modal, state]);

  const handleCopyExport = useCallback(() => {
    if (exportPayload === '') return;
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard !== undefined &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      void navigator.clipboard.writeText(exportPayload);
    }
  }, [exportPayload]);

  // Pre-compute chip labels so the render stays cheap.
  const chipLabelFor = useCallback(
    (lane: Lane): string => {
      if (lane.kind === 'bfs') {
        return `BFS ${String(lane.depth)}`;
      }
      return lane.name;
    },
    [],
  );

  // Slot indices in render order; we always show one trailing empty slot so
  // the user has a visible drop-target on the right edge.
  const visibleSlots = useMemo(() => {
    return [...state.slots, { lanes: [] }];
  }, [state.slots]);

  return (
    <div
      className="layer-editor-bar"
      data-testid="layer-editor-bar"
      role="region"
      aria-label="Редактор слоёв"
    >
      <div className="layer-editor-bar__head">
        <h3 className="layer-editor-bar__title">Редактор слоёв</h3>
        <p className="layer-editor-bar__hint">
          Перетащите фишку слоя в нужный слот. Пакеты внутри группы выпадают
          из BFS-слоя.
        </p>
        <div className="layer-editor-bar__actions">
          <label className="layer-editor-bar__preset-label">
            <span className="layer-editor-bar__preset-caption">Пресет</span>
            <select
              className="layer-editor-bar__select"
              value={selectedPresetId}
              onChange={handlePresetChange}
              data-testid="layer-editor-preset-select"
              aria-label="Выбрать пресет"
            >
              <option value="">(нет)</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="layer-editor-bar__btn"
            onClick={handleSaveAsOpen}
            data-testid="layer-editor-save-as"
          >
            Сохранить как…
          </button>
          <button
            type="button"
            className="layer-editor-bar__btn"
            onClick={handleDeletePreset}
            disabled={selectedPresetId === ''}
            data-testid="layer-editor-delete-preset"
          >
            Удалить
          </button>
          <button
            type="button"
            className="layer-editor-bar__btn"
            onClick={handleExportOpen}
            data-testid="layer-editor-export"
          >
            Экспорт
          </button>
          <button
            type="button"
            className="layer-editor-bar__btn"
            onClick={handleImportOpen}
            data-testid="layer-editor-import"
          >
            Импорт
          </button>
          {adding ? (
            <div className="layer-editor-bar__addform" data-testid="layer-editor-addform">
              <input
                type="text"
                placeholder="имя"
                value={nameDraft}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                }}
                aria-label="Имя группы"
                data-testid="layer-editor-name"
              />
              <input
                type="text"
                placeholder="префикс пути"
                value={prefixDraft}
                onChange={(e) => {
                  setPrefixDraft(e.target.value);
                }}
                aria-label="Префикс группы"
                data-testid="layer-editor-prefix"
              />
              <button
                type="button"
                className="layer-editor-bar__btn"
                onClick={handleSubmitGroup}
                data-testid="layer-editor-add-confirm"
              >
                ОК
              </button>
              <button
                type="button"
                className="layer-editor-bar__btn"
                onClick={() => {
                  setAdding(false);
                  setNameDraft('');
                  setPrefixDraft('');
                }}
              >
                Отмена
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="layer-editor-bar__btn"
              onClick={() => {
                setAdding(true);
              }}
              data-testid="layer-editor-add"
            >
              + Группа
            </button>
          )}
          <button
            type="button"
            className="layer-editor-bar__btn"
            onClick={handleReset}
            data-testid="layer-editor-reset"
          >
            Сбросить
          </button>
        </div>
      </div>

      <div className="layer-editor-bar__strip" data-testid="layer-editor-strip">
        {visibleSlots.map((slot, slotIndex) => {
          const isLast = slotIndex === visibleSlots.length - 1;
          const isHover = hoverSlot === slotIndex;
          return (
            <div
              key={`slot-${String(slotIndex)}`}
              className={`layer-editor-bar__slot${
                isHover ? ' layer-editor-bar__slot--drop-target' : ''
              }`}
              data-testid={`layer-editor-slot-${String(slotIndex)}`}
              onDragOver={(e) => {
                handleDragOver(e, slotIndex);
              }}
              onDragLeave={() => {
                if (hoverSlot === slotIndex) setHoverSlot(null);
              }}
              onDrop={(e) => {
                handleDrop(e, slotIndex);
              }}
            >
              <div className="layer-editor-bar__slot-label">
                {isLast ? 'Новый слот' : `Слот ${String(slotIndex + 1)}`}
              </div>
              {slot.lanes.map((lane) => {
                const key = laneKeyOf(lane);
                const count = countsByLaneKey.get(key) ?? 0;
                const isDragging = dragLaneKey === key;
                return (
                  <div
                    key={key}
                    className={`layer-editor-bar__chip${
                      lane.kind === 'folder' ? ' layer-editor-bar__chip--folder' : ''
                    }${isDragging ? ' layer-editor-bar__chip--dragging' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      handleDragStart(e, key);
                    }}
                    onDragEnd={handleDragEnd}
                    onMouseEnter={() => {
                      applyPulse(key);
                    }}
                    onMouseLeave={clearPulse}
                    data-testid={`layer-editor-chip-${key}`}
                  >
                    <span className="layer-editor-bar__chip-label">
                      {chipLabelFor(lane)}
                    </span>
                    <span
                      className="layer-editor-bar__chip-count"
                      data-testid={`layer-editor-chip-count-${key}`}
                    >
                      ({String(count)})
                    </span>
                    {lane.kind === 'folder' ? (
                      <button
                        type="button"
                        className="layer-editor-bar__chip-remove"
                        onClick={() => {
                          onRemoveGroup(lane.id);
                        }}
                        aria-label={`Удалить группу ${lane.name}`}
                        data-testid={`layer-editor-chip-remove-${lane.id}`}
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {state.unassigned.length > 0 ? (
        <div
          className="layer-editor-bar__unassigned"
          data-testid="layer-editor-unassigned"
          onDragOver={(e) => {
            handleDragOver(e, -1);
          }}
          onDrop={(e) => {
            handleDrop(e, -1);
          }}
        >
          <span className="layer-editor-bar__unassigned-label">Без слота</span>
          {state.unassigned.map((lane) => {
            const key = laneKeyOf(lane);
            const count = countsByLaneKey.get(key) ?? 0;
            const isDragging = dragLaneKey === key;
            return (
              <div
                key={key}
                className={`layer-editor-bar__chip${
                  lane.kind === 'folder' ? ' layer-editor-bar__chip--folder' : ''
                }${isDragging ? ' layer-editor-bar__chip--dragging' : ''}`}
                draggable
                onDragStart={(e) => {
                  handleDragStart(e, key);
                }}
                onDragEnd={handleDragEnd}
                onMouseEnter={() => {
                  applyPulse(key);
                }}
                onMouseLeave={clearPulse}
                data-testid={`layer-editor-chip-${key}`}
              >
                <span className="layer-editor-bar__chip-label">
                  {lane.kind === 'bfs' ? `BFS ${String(lane.depth)}` : lane.name}
                </span>
                <span className="layer-editor-bar__chip-count">({String(count)})</span>
                {lane.kind === 'folder' ? (
                  <button
                    type="button"
                    className="layer-editor-bar__chip-remove"
                    onClick={() => {
                      onRemoveGroup(lane.id);
                    }}
                    aria-label={`Удалить группу ${lane.name}`}
                    data-testid={`layer-editor-chip-remove-${lane.id}`}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {modal !== null ? (
        <PresetModal
          kind={modal}
          presetCount={presets.length}
          payload={exportPayload}
          importDraft={importDraft}
          saveAsDraft={saveAsDraft}
          importError={importError}
          onSaveAsDraftChange={setSaveAsDraft}
          onImportDraftChange={(next) => {
            setImportDraft(next);
            if (importError !== null) setImportError(null);
          }}
          onSaveAsConfirm={handleSaveAsConfirm}
          onImportSubmit={handleImportSubmit}
          onCopyExport={handleCopyExport}
          onClose={closeModal}
        />
      ) : null}
    </div>
  );
}

export const LayerEditorBar = forwardRef<LayerEditorBarHandle, LayerEditorBarProps>(
  LayerEditorBarInner,
);

interface PresetModalProps {
  kind: Exclude<ModalKind, null>;
  presetCount: number;
  payload: string;
  importDraft: string;
  saveAsDraft: string;
  importError: string | null;
  onSaveAsDraftChange: (next: string) => void;
  onImportDraftChange: (next: string) => void;
  onSaveAsConfirm: () => void;
  onImportSubmit: () => void;
  onCopyExport: () => void;
  onClose: () => void;
}

/**
 * Small modal reusing the entry-dialog visual pattern. One component
 * dispatches on `kind` so the three preset actions stay tonally consistent.
 */
function PresetModal({
  kind,
  payload,
  importDraft,
  saveAsDraft,
  importError,
  onSaveAsDraftChange,
  onImportDraftChange,
  onSaveAsConfirm,
  onImportSubmit,
  onCopyExport,
  onClose,
}: PresetModalProps): JSX.Element {
  const title =
    kind === 'saveAs'
      ? 'Сохранить пресет'
      : kind === 'export'
        ? 'Экспорт пресета'
        : 'Импорт пресета';
  return (
    <div
      className="layer-editor-bar__modal-backdrop"
      role="presentation"
      onClick={(evt) => {
        if (evt.target === evt.currentTarget) onClose();
      }}
      data-testid="layer-editor-modal-backdrop"
    >
      <div
        className="layer-editor-bar__modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={`layer-editor-modal-${kind}`}
      >
        <header className="layer-editor-bar__modal-head">
          <h4 className="layer-editor-bar__modal-title">{title}</h4>
          <button
            type="button"
            className="layer-editor-bar__btn"
            onClick={onClose}
            aria-label="Закрыть"
            data-testid="layer-editor-modal-close"
          >
            ×
          </button>
        </header>
        {kind === 'saveAs' ? (
          <div className="layer-editor-bar__modal-body">
            <label className="layer-editor-bar__modal-label" htmlFor="le-save-name">
              Имя пресета
            </label>
            <input
              id="le-save-name"
              type="text"
              value={saveAsDraft}
              onChange={(e) => {
                onSaveAsDraftChange(e.target.value);
              }}
              data-testid="layer-editor-save-as-input"
              placeholder="Например, «Архитектура»"
              autoFocus
            />
            <div className="layer-editor-bar__modal-actions">
              <button
                type="button"
                className="layer-editor-bar__btn"
                onClick={onSaveAsConfirm}
                disabled={saveAsDraft.trim() === ''}
                data-testid="layer-editor-save-as-confirm"
              >
                Сохранить
              </button>
              <button
                type="button"
                className="layer-editor-bar__btn"
                onClick={onClose}
              >
                Отмена
              </button>
            </div>
          </div>
        ) : null}
        {kind === 'export' ? (
          <div className="layer-editor-bar__modal-body">
            <p className="layer-editor-bar__hint">
              Скопируйте строку и поделитесь ею с коллегой.
            </p>
            <textarea
              className="layer-editor-bar__modal-textarea"
              readOnly
              value={payload}
              rows={4}
              data-testid="layer-editor-export-text"
            />
            <div className="layer-editor-bar__modal-actions">
              <button
                type="button"
                className="layer-editor-bar__btn"
                onClick={onCopyExport}
                data-testid="layer-editor-export-copy"
              >
                Скопировать
              </button>
              <button
                type="button"
                className="layer-editor-bar__btn"
                onClick={onClose}
              >
                Закрыть
              </button>
            </div>
          </div>
        ) : null}
        {kind === 'import' ? (
          <div className="layer-editor-bar__modal-body">
            <label className="layer-editor-bar__modal-label" htmlFor="le-import-text">
              Вставьте строку, начинающуюся с «{PRESET_PREFIX}»
            </label>
            <textarea
              id="le-import-text"
              className="layer-editor-bar__modal-textarea"
              value={importDraft}
              onChange={(e) => {
                onImportDraftChange(e.target.value);
              }}
              rows={4}
              data-testid="layer-editor-import-text"
              autoFocus
              spellCheck={false}
            />
            {importError !== null ? (
              <p
                className="layer-editor-bar__hint layer-editor-bar__hint--error"
                data-testid="layer-editor-import-error"
              >
                {importError}
              </p>
            ) : null}
            <div className="layer-editor-bar__modal-actions">
              <button
                type="button"
                className="layer-editor-bar__btn"
                onClick={onImportSubmit}
                disabled={importDraft.trim() === ''}
                data-testid="layer-editor-import-submit"
              >
                Загрузить
              </button>
              <button
                type="button"
                className="layer-editor-bar__btn"
                onClick={onClose}
              >
                Отмена
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
