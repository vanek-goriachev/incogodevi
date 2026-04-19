# Трассировка требований → задачи

Каждое in-scope требование из `docs/requirements.md` покрыто как минимум одной задачей. Тесты FR/NFR проходят внутри соответствующих задач (см. раздел «План тестирования» каждой task-карточки).

## Функциональные требования

| Requirement | Формулировка (кратко) | Covered by tasks |
|---|---|---|
| FR-01 | ZIP upload / drag-n-drop | T06, T14, T18 |
| FR-02 | zip-slip guard | T06 |
| FR-03 | Рекурсивный обход .go | T07 |
| FR-04 | `packages.Load` с NeedTypes+ | T07 |
| FR-05 | Извлечение сущностей (8 kind) | T08 |
| FR-06 | Auto entry points = все `func main` | T10 |
| FR-07 | Пользовательские entry points | T10, T15, T22 |
| FR-08 | Направленный граф от entry points | T08, T11 |
| FR-09 | Интерфейсы через `types.Implements` + embedding | T09 |
| FR-10 | «Лес» от нескольких entry points | T10, T11 |
| FR-11 | Отрисовка в Cytoscape.js | T20 |
| FR-12 | Zoom + pan | T20 |
| FR-13 | Drag узлов | T20 |
| FR-14 | Фильтры по 8 типам сущностей | T21 |
| FR-15 | Визуальное выделение мёртвых узлов | T20, T23 |
| FR-16 | Collapse/hide subtree | T22 |
| FR-17 | Метаинформация на hover / click | T22 |
| FR-18 | Агрегация > 1000 узлов | T11, T16, T24 |
| FR-19 | Пометка недостижимых как dead | T11 |
| FR-20 | Список мёртвого кода | T16, T23 |
| FR-21 | Export PNG | T24 |
| FR-22 | Export SVG | T24 |
| FR-23 | Export TXT отчёта | T16, T23 |
| FR-24 | Export JSON отчёта | T16, T23 |
| FR-25 | UI-панели управления | T21, T22, T23 |
| FR-26 | `localStorage` persistence | T17, T21, T22, T23 |

## Нефункциональные требования

| NFR | Кратко | Covered by tasks |
|---|---|---|
| NFR-01 | ≤ 30 с на 50k LOC | T07, T08, T11, T15 (бенчмарк), T26 |
| NFR-02 | ≤ 5 с первой отрисовки | T15 (SSE partial_graph), T19, T20, T26 |
| NFR-03 | < 100 мс UI отклик | T21, T23 |
| NFR-04 | Лимиты архива | T06, T14 |
| NFR-05 | Go 1.21+ | T01, T03 |
| NFR-06 | ES2020 + SVG, last-2 браузеров | T02, T03, T26 |
| NFR-07 | Multi-OS/arch Docker | T25 |
| NFR-08 | Partial graph + warnings | T07, T13, T15 |
| NFR-09 | UI без reload на ошибках | T17 (Error Boundary), T26 |
| NFR-10 | localStorage recovery | T17, T18 |
| NFR-11 | ≤ 3 действия до графа | T18, T19 |
| NFR-12 | Английский UI | T17 (конвенция строк) |
| NFR-13 | Изоляция FS | T06 |
| NFR-14 | Лимиты до анализа | T06 |

## Критерии приёмки проекта (из requirements §7)

| AC | Covered by |
|---|---|
| FR-01..FR-26 покрыты хотя бы одним тестом | все задачи с тестами |
| NFR-01 benchmark на ≥ 50k LOC | T15 (go test -bench), T26 |
| NFR-02, NFR-03 проверены Playwright | T26 |
| Coverage backend (analyzer, graph, deadcode, api) ≥ 70 % | T07, T08, T09, T11, T15, T16 |
| Frontend unit (vitest + RTL) | T17, T21, T22, T23 |
| Integration тест HTTP API | T14, T15, T16 |
| E2E Playwright journey | T26 |
| GitHub Actions lint+test на PR/main | T03 |
| Docker multi-arch запускается | T25 |
| Документация в docs/ | уже есть (фазы 1–2) |
| Демо §6 воспроизводится | T27 |

Все в-scope FR/NFR покрыты. Nice-to-have из §5.2 (import JSON config, доп. layouts, инкрементальный кэш, темы) не распределены в основные задачи — темы (light/dark) закрыты по design.md §5.5 в T17+T20; остальные пункты остаются nice-to-have без отдельных задач.
