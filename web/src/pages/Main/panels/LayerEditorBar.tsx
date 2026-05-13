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
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { laneKeyOf, type Lane, type LayerEditorState } from '../layout/laneMapping';
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
  /** Live cytoscape core — drives the hover-pulse class. May be null. */
  cy?: Core | null;
}

export function LayerEditorBar({
  state,
  countsByLaneKey,
  nodeIdsByLaneKey,
  onAddGroup,
  onRemoveGroup,
  onMoveLane,
  onReset,
  cy = null,
}: LayerEditorBarProps): JSX.Element {
  const [adding, setAdding] = useState<boolean>(false);
  const [nameDraft, setNameDraft] = useState<string>('');
  const [prefixDraft, setPrefixDraft] = useState<string>('');
  const [dragLaneKey, setDragLaneKey] = useState<string | null>(null);
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);

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
    onReset();
  }, [onReset]);

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
    </div>
  );
}
