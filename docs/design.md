# UI / UX Design — Go Dependencies Visualizer

> Фронтенд — React 18 + TypeScript + Vite + Cytoscape.js. Язык интерфейса — английский (NFR-12). Single-page, всё состояние в памяти и `localStorage`. Дизайн рассчитан на одного разработчика-пользователя, который знает Go и хочет быстро ответить «что у меня живое, что мёртвое».

---

## 1. Principles

1. **Сразу к графу.** ≤ 3 действия от открытия страницы до видимого графа (NFR-11). Нет мастеров, нет многостраничных форм.
2. **Итерация дешёвая.** Смена entry points и фильтров не перезагружает страницу и (в случае фильтров) не дёргает сервер.
3. **Ничего не потерять.** Ручные позиции узлов, entry points и фильтры сохраняются в `localStorage` per project_id (FR-26).
4. **Graceful partial results.** Warnings из SSE показываются в той же сессии без блокирующих модалок (NFR-08, NFR-09).
5. **Keyboard-first где можно.** Zoom, pan, clear selection — с клавиатуры (см. §7).
6. **Честность про цвет.** Живой vs мёртвый код различается **не только** цветом (форма/штриховка), чтобы работало при colorblindness (§6).

---

## 2. User journeys

### J1. Первый запуск (happy path)

```
Open http://localhost:8080
  → Landing: big drop-zone + "Drop a .zip with go.mod, or click to browse"
Drag-drop my-project.zip
  → Upload progress bar (0→100 %)
  → Auto-transition to Analyzing view
    Phase badges tick: loading → parsing → building_graph → reachability → done
    Partial graph starts rendering at phase "building_graph"
  → Done: full graph visible, right panel shows stats
```

3 действия для пользователя: (1) drag-drop, (2) ждать, (3) увидеть граф. ✓ NFR-11.

### J2. Смена entry points

```
Graph visible, see a suspicious method in side-panel
  → Click node → "Info" panel shows kind/file/line/doc
  → Click "Add as entry point" button in info panel
  → Entry points panel (top-left) shows "+ pkg.Type.Method"
  → Automatic re-analyze fires:
    SSE stream starts immediately (parsed.gob cached, only reachability runs)
    < 1 s → graph recoloured; previously dead nodes may now become reachable
```

Пользователь не покидает страницу, не ждёт парсинга заново (FR-07, ADR-03).

### J3. Восстановление после reload

```
Tab reload
  → App reads localStorage: last_project_id, entry_points, filters, node_positions
  → GET /api/projects/{id}/graph → receives cached graph
    (if 404: show toast "project expired — please re-upload", offer landing)
  → Graph rendered with restored positions and filters
```

Критерий: позиция узлов та же, что до reload (NFR-10, FR-26).

### J4. Export отчёта мёртвого кода

```
In side-panel, bottom tab: "Dead code (89)"
  → List of 89 entries, each `kind pkg.Name — file:line`
  → Two buttons: [Export TXT] [Export JSON]
  → Click → browser download with name `<project>-dead-code-<timestamp>.<ext>`
```

Если 0 мёртвых — сообщение «No dead code detected 🎉» (FR-20).

---

## 3. Screen-by-screen wireframes

### 3.1 Landing (no project)

```
┌──────────────────────────────────────────────────────────────┐
│  Go Dependencies Visualizer                        [?] help  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                                                              │
│                ┌────────────────────────────┐                │
│                │                            │                │
│                │   ┌ ▼ ┐                    │                │
│                │   └───┘  Drop a .zip here  │                │
│                │                            │                │
│                │   or click to browse       │                │
│                │                            │                │
│                │   Requirements:            │                │
│                │   • go.mod at archive root │                │
│                │   • ≤ 50 MB, ≤ 10 000 files│                │
│                └────────────────────────────┘                │
│                                                              │
│                                                              │
│  Recent projects (from localStorage):                        │
│    github.com/acme/example — 2 h ago  [Restore] [Forget]     │
│    playground — yesterday           [Restore] [Forget]       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Analyzing (SSE in progress)

```
┌──────────────────────────────────────────────────────────────┐
│  github.com/acme/example  · uploaded 12:34 · 142 files       │
├──────────────────────────────────────────────────────────────┤
│  [✓ loading] [✓ parsing] [● building_graph 62%] [ reachability] [ done] │
│                                                              │
│  Graph area — partial nodes already appearing as SSE events  │
│  arrive.  A faint progress bar under the top bar shows       │
│  overall progress (0..1 from `phase.progress`).              │
│                                                              │
│  Warnings appear inline as muted amber toast (top-right),    │
│  non-blocking, dismissable:                                  │
│     [⚠ import_error in pkg foo — cannot find module]         │
│                                                              │
│  [Cancel]  ← appears only after 3 s in same phase            │
└──────────────────────────────────────────────────────────────┘
```

**Cancel появляется по таймеру.** Чтобы не мельтешить на быстрых анализах (< 3 с, типичный кейс), кнопка `Cancel` **скрыта по умолчанию** и появляется только если текущая фаза длится > 3 000 ms. Таймер сбрасывается на каждую SSE `phase:*` событие. Обоснование: для крупных monorepo (30 с по NFR-01) кнопка полезна, для мелких — лишний мигающий UI-элемент.

Реализация: `useEffect` со `setTimeout(3000)` на каждый новый phase; `clearTimeout` на unmount и на следующую phase. При истечении таймера — `setState({showCancel: true})`.

### 3.3 Main (graph ready)

```
┌──────────────────────────────────────────────────────────────┐
│ ≡  github.com/acme/example  ·  1234 nodes · 89 dead  · ⟳     │
├────────┬──────────────────────────────────────────┬──────────┤
│ Entry  │                                          │ Info     │
│ points │                                          │ ──────── │
│ ──────│                                          │ Handler  │
│ ✓ all  │                                          │ struct   │
│   main │                                          │ api/hand │
│ +      │          CYTOSCAPE GRAPH AREA            │ ler.go:12│
│ custom │                                          │ [+ entry]│
│ ──────│          (zoom w/scroll, pan w/drag,     │ [Go to…] │
│ Filter │           drag nodes individually,       │          │
│ ──────│           click node → info panel →,     │ Dead code│
│ ☑ pkg  │           right-click → collapse/expand) │ (89)     │
│ ☑ func │                                          │ ──────── │
│ ☑ meth │                                          │ method   │
│ ☐ var  │                                          │ Mongo.Cl │
│ ☐ const│                                          │ ose — … │
│ ☑ strct│                                          │ (virtu.) │
│ ☑ ifac │                                          │ [TXT]    │
│ ☑ field│                                          │ [JSON]   │
│ ──────│                                          │ ──────── │
│ Layout │                                          │ Export   │
│ • fcose│                                          │ [PNG]    │
│ • dag  │                                          │ [SVG]    │
│ • circ │                                          │          │
└────────┴──────────────────────────────────────────┴──────────┘
```

Layout: 3 columns — left rail (240 px), graph (flex), right rail (300 px). Rails collapsible via icon in top bar (≡). На узких экранах (< 1000 px) правая панель становится оверлеем.

### 3.4 Error state (network / server down)

```
┌──────────────────────────────────────────────────────────────┐
│  github.com/acme/example                                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   ⚠  Connection lost                                         │
│      Could not reach the server (last error: 404).           │
│      Your local data is safe: entry points, filters and      │
│      positions are kept in this browser.                     │
│                                                              │
│   [Retry]   [Re-upload project]   [Back to landing]          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Error Boundary покрывает всё ниже top-bar (NFR-09).

---

## 4. Interaction patterns

| Gesture | Effect | Где реализовано |
|---|---|---|
| Drag-drop zip | Upload + auto-analyze | Landing + anywhere on document if `dragenter` |
| Click node | Show info panel (right), не меняет selection на графе | Cytoscape `tap` handler |
| Shift-click node | Add/remove from multi-selection | Cytoscape `tap` + shiftKey |
| Drag node | Move (free layout) | Cytoscape built-in |
| Right-click node | Context menu: `Info`, `Add as entry`, `Hide subtree`, `Go to file:line` (copy path) | cytoscape-cxtmenu plugin или custom |
| Mouse wheel | Zoom to cursor | Cytoscape built-in |
| Drag empty | Pan | Cytoscape built-in |
| Click empty | Clear selection, close info panel | — |
| Toggle filter (FR-14) | Show/hide nodes by kind — pure CSS-class toggle on Cytoscape, < 100 ms (NFR-03) | — |
| Toggle dead-mode | Cycle Live only → Live+dead → Dead only (см. §5.3) — CSS-class toggle | Top-bar segmented control |
| Esc | Close modal / clear selection / close info panel | global keydown listener |
| `/` | Focus filter search (find node by name) | — |
| `f` | Fit graph to viewport | — |
| `d` | Cycle dead-code display mode (3 режима из §5.3) | — |
| `?` | Show help overlay with all shortcuts | — |

Кастомных клавиатурных шорткатов мало — только те, что нужны для демо и на защите.

---

## 5. Visual language

### 5.1 Node styling

Каждый `NodeKind` = отдельная форма + цвет, чтобы распознавалось даже в чёрно-белой печати и при colorblindness (§6).

| Kind | Shape | Fill (light) | Border | Size |
|---|---|---|---|---|
| package | `round-rectangle` | `#dbeafe` (blue-100) | `#1e40af` 2px | 180×46 |
| struct  | `rectangle` | `#e0f2fe` (cyan-100) | `#0369a1` 2px | 140×36 |
| interface | `diamond` | `#ede9fe` (violet-100) | `#6d28d9` 2px | 140×36 (diamond) |
| func | `ellipse` | `#fef3c7` (amber-100) | `#b45309` 1.5px | 120×34 |
| method | `ellipse` | `#fffbeb` (amber-50) | `#92400e` 1.5px | 120×34 |
| field | `round-rectangle` (small) | `#f1f5f9` (slate-100) | `#475569` 1px | 100×24 |
| var / const | `hexagon` | `#dcfce7` (green-100) | `#15803d` 1px | 100×28 |

Текст узла — имя, 12 pt, моноширный (`ui-monospace, SFMono-Regular, "JetBrains Mono"`).

### 5.2 Edge styling

| EdgeKind | Line | Color | Arrow |
|---|---|---|---|
| imports | solid 1.5 | `#1e40af` (navy) | triangle |
| contains | solid 1 | `#94a3b8` (slate-400) | none |
| calls | solid 1.5 | `#b45309` (amber-700) | triangle |
| embeds | solid 2 | `#0369a1` (cyan-700) | open triangle |
| implements | **dashed** 2 | `#6d28d9` (violet-700) | open triangle |
| references | dotted 1 | `#64748b` (slate-500) | triangle-tee |

### 5.3 Dead code (FR-15)

Стиль dead-узла (когда он отрисовывается):
- `opacity: 0.45`
- `border-style: dashed` (вне зависимости от типа — оверрайд шейпа)
- CSS-класс `.dead` добавляет крестик в правый верхний угол (Cytoscape pseudo-attribute)

Т.е. живое от мёртвого отличается **opacity, border-style и бейдж** — работает при дальтонизме (§6).

**Dead-code display mode (3 режима).** В top-bar живёт сегментированный тумблер:

| Режим | Показывается на графе | Используется когда |
|---|---|---|
| `Live only` | только `Reachable==true` узлы и инцидентные им рёбра | демо «вот что реально исполняется», презентация архитектуры |
| `Live + dead 0.45` (default) | всё, dead — приглушённые по §5.3 | основной рабочий режим, ищем мёртвый код |
| `Dead only` | только `Reachable==false` узлы и рёбра между ними; live скрыты | аудит «что можно удалить», экспорт для PR |

Переключение режима — чисто клиентский CSS-class toggle на Cytoscape (< 100 ms, NFR-03), без запроса на сервер. Выбранный режим сохраняется в `localStorage` как `go-viz:<id>:dead-mode`.

### 5.4 Entry points

**Стиль узла** (`IsEntry==true`):
- двойная обводка (`border-width: 3.5`, `border-color: <kind-border>`, `border-style: solid double`)
- звёздочка ★ в левом верхнем углу (как badge)

Отличимо от обычного узла и от dead-кода одновременно (дальтоник: три визуальных канала — opacity, border-width, badge).

**Layout: pin entry points в верхний ряд.** Дополнительно к стилю, все entry-point узлы визуально «прибиты» к верхнему краю графа — пользователю сразу видно, откуда стартует reachability.

Реализация:
1. После получения финального графа клиент вычисляет равномерное распределение entry-point узлов по X в диапазоне `[viewport.x1 + 80, viewport.x2 - 80]`, Y фиксирован в `viewport.y1 + 60`.
2. Этим узлам задаётся `locked: true` + `position: {x, y}` через Cytoscape API **до** запуска layout-алгоритма (fcose по умолчанию).
3. fcose работает с `locked` как с фиксированными гвоздями — остальные узлы раскладываются вокруг них.
4. При drag обычного узла — fcose не двигает entry-points; при смене entry points — старые получают `locked: false`, новые `locked: true` и разметка пересчитывается.
5. В ручных позициях (`layout: manual`, §8) этот pin не применяется — пользователь уже контролирует позиции вручную.

Исключение: если entry-points > 12 штук — не пытаемся всех впихнуть в одну строку, fallback на обычный стиль без pin (слишком тесно визуально).

### 5.5 Palettes и темы

- **Light** (default). Белый фон `#ffffff`, узлы по §5.1.
- **Dark**. Фон `#0f172a` (slate-900), все fill цвета инвертируются к `*-900` / `*-800`, текст `#e2e8f0`.
- Тема определяется `prefers-color-scheme` при первом запуске; далее — пользовательский селектор в настройках, persisted.

### 5.6 Typography

Единый стек — UI sans-serif для панелей, mono для кода:
```
--font-ui:  ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
--font-mono: ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace;
```

Размеры: `14 px` body, `12 px` node labels, `11 px` дополнительный (file:line), `18 px` заголовки панелей.

---

## 6. Accessibility

- **Colorblind safety.** Живое vs мёртвое: opacity + border-style + badge (§5.3) — не зависит от hue. Entry-points: double border + star badge (§5.4). Edge kinds различаются line-style (solid/dashed/dotted) в дополнение к цвету.
- **Keyboard navigation.** Все панельные контролы — обычные `<button>` / `<input>`, tab order сверху-вниз, visible focus ring (`outline: 2px solid #3b82f6`). Cytoscape keyboard: arrows для pan, `+`/`-` zoom (только при focus на canvas).
- **`prefers-reduced-motion`.** Отключаем анимации layout-перехода в Cytoscape (`animate: false`), отключаем fade-in для `partial_graph` чанков (мгновенное добавление).
- **`prefers-color-scheme`.** Светлая/тёмная тема автоматически; пользователь может override (сохраняем в localStorage).
- **Contrast.** Все text/background пары проходят WCAG AA (ratio ≥ 4.5 для body, ≥ 3 для большого текста). Проверено через `@axe-core/react` в dev-сборке.
- **Screen reader.** Граф — `<canvas>` внутри `<div role="application" aria-label="Dependency graph, 1234 nodes">`. Side panels семантичны (`<aside>` + `<h3>`). Клавиатурные shortcuts перечислены на странице help (`?`).
- **Language.** `<html lang="en">`.

---

## 7. States (матрица)

| Экран \ Состояние | Empty | Loading | Error | Partial | Full |
|---|---|---|---|---|---|
| Landing | drop-zone + recent list | — | upload error toast | — | — |
| Upload | — | progress bar | "invalid_zip"/"go_mod_missing"/"too_large" inline | — | — |
| Analyzing | — | phase badges + progress | "analysis_in_progress" = disable button + hint | partial_graph уже рендерится | → переход в Main |
| Main graph | "no nodes" message if filter hides everything | "refreshing…" small spinner (никогда не блокирует) | "connection lost" overlay | частичный граф из SSE | полный граф |
| Info panel | "Select a node to see details" | — | — | — | детали узла |
| Dead-code tab | "No dead code detected 🎉" | — | "no_graph_yet" hint | — | список + export |

---

## 8. LocalStorage schema

Ключи под префиксом `go-viz:`:

| Ключ | Значение | Когда пишется |
|---|---|---|
| `go-viz:recent-projects` | `[{project_id, name, uploaded_at}]` max 10 | после успешного upload |
| `go-viz:<id>:entry-points` | JSON `EntryPointSpec` | при любой смене entry points |
| `go-viz:<id>:filters` | JSON `Filters` | при toggle фильтра |
| `go-viz:<id>:positions` | `{[nodeId]: {x,y}}` | throttled на 500 ms после drag |
| `go-viz:<id>:layout` | `"fcose"\|"dagre"\|"circle"\|"manual"` | при смене layout |
| `go-viz:<id>:dead-mode` | `"live-only"\|"live-dead"\|"dead-only"` | при смене режима (§5.3) |
| `go-viz:theme` | `"light"\|"dark"\|"auto"` | при смене темы |

Очистка — кнопка `Forget` в landing recent list (удаляет все ключи `go-viz:<id>:*` + убирает из `recent-projects`).

---

## 9. Что намеренно упрощено

- **Нет регистрации/логина.** Локальный инструмент.
- **Нет server-side поиска по коду.** Для find-by-name используется клиентский фильтр по уже загруженным Nodes.
- **Нет анимаций layout-transition.** При смене entry points узлы меняют цвет/opacity без перемещения (удобнее ментально).
- **Нет «History» / undo.** Сессия атомарна — смена entry points всегда свежий result. Просто пересчитать дёшево.
- **Нет multi-tab coordination.** Две вкладки на один project_id — каждая работает независимо, server serialize'ит `/analyze` через single-flight (ADR-10).

---

## 10. Решённые UX-вопросы

Вопросы, которые были открыты в ревью 2026-04-19, и принятые решения:

- **Entry-points visibility.** Решено: звёздочка ★ + двойная обводка **плюс** hard-pin в верхний ряд графа через `locked: true` позиции перед fcose-раскладкой (см. §5.4). Fallback на обычный стиль при > 12 entry points.
- **Cancel во время анализа.** Решено: кнопка скрыта по умолчанию, появляется после 3 с в текущей фазе (таймер сбрасывается на каждый SSE `phase`). Детали — §3.2.
- **Обработка dead-кода.** Решено: три режима вместо одного — `Live only` / `Live+dead 0.45` (default) / `Dead only`. Сегментированный тумблер в top-bar + hotkey `d`, состояние в `localStorage:<id>:dead-mode`. См. §5.3.

Новых открытых вопросов нет — всё, что требовало решения для фазы реализации, зафиксировано.

---
