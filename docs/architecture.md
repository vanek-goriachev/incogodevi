# Архитектура — Go Dependencies Visualizer

> Фаза 2, вариант **C** — SSE streaming + disk-cached artifacts. Выбор пользователя 2026-04-18, причина: «нет рисков по срокам — этот код будешь писать ты».
> Этот документ фиксирует архитектуру верхнего уровня, границы контейнеров, внутреннее устройство backend, контракт данных и архитектурные решения (ADR).
> Диаграммы лежат в `docs/diagrams/`, рендеры — в `docs/diagrams/rendered/`.
>
> **Версии зафиксированы на 2026-04-19.** Перед стартом фазы реализации (и перед каждым релизом) исполнитель **обязан** сверить версии с актуальной документацией: go.dev/doc/devel/release, react.dev/versions, vitejs.dev/blog, typescriptlang.org, js.cytoscape.org, hub.docker.com (node, golang, distroless). См. §11 «Политика актуальности версий».

---

## 1. Обзор и соответствие требованиям

Система состоит из одного Go-бинаря, который:
- принимает ZIP с Go-проектом от браузера,
- разбирает его через `golang.org/x/tools/go/packages` с полной типовой информацией,
- строит граф зависимостей от множества точек входа,
- стримит прогресс и частичный граф обратно через SSE,
- сохраняет артефакты (распакованные исходники, `parsed.gob`, `graph.json`, `dead-code.json`) на диск с TTL.

Встроенный фронтенд (React + Cytoscape.js) поставляется тем же бинарём через `embed.FS`, так что деплой = один Docker-образ. Диаграммы уровней C4 см. ниже:

| Diagram | File | What it shows |
|---|---|---|
| L1 — System Context | [`01-system-context.excalidraw`](diagrams/01-system-context.excalidraw) · [png](diagrams/rendered/01-system-context.png) | Пользователь ↔ Visualizer ↔ анализируемый Go-проект |
| L2 — Containers | [`02-containers.excalidraw`](diagrams/02-containers.excalidraw) · [png](diagrams/rendered/02-containers.png) | Browser SPA, Go Backend, tmp, disk cache |
| L3 — Backend Components | [`03-components-backend.excalidraw`](diagrams/03-components-backend.excalidraw) · [png](diagrams/rendered/03-components-backend.png) | 10 компонент сервера |
| Dynamic — Analysis Flow | [`04-flow-sse-sequence.excalidraw`](diagrams/04-flow-sse-sequence.excalidraw) · [png](diagrams/rendered/04-flow-sse-sequence.png) | SSE последовательность с фазами |
| Data Model | [`05-data-model.excalidraw`](diagrams/05-data-model.excalidraw) · [png](diagrams/rendered/05-data-model.png) | Project / Graph / Node / Edge / enums / SSE events |
| Deployment | [`06-deployment.excalidraw`](diagrams/06-deployment.excalidraw) · [png](diagrams/rendered/06-deployment.png) | Dockerfile stages + runtime topology |

Требования см. `docs/requirements.md`. В §7 ниже — матрица покрытия NFR.

---

## 2. C4 L2 — Контейнеры

Всего четыре «контейнера», из которых только два — процессы:

- **Browser SPA.** React 19 + TypeScript 6 + Vite 8 (Rolldown) + Cytoscape.js 3.33 + `cytoscape-svg`. Хранит `project_id` и UI-настройки в `localStorage` (FR-26). Общается с бэкендом по HTTP и SSE. Строится в собственном stage Dockerfile, артефакты (`web/dist/`) копируются в Go-stage для `embed.FS`. Версии указаны на 2026-04-19 — перед `npm install` проверять актуальные minor-версии.
- **Go Backend.** Один процесс, `net/http.ServeMux` без фреймворков. Отдаёт SPA с `embed.FS`, принимает ZIP, держит SSE-соединение, пишет и читает disk cache. Подробности — §3.
- **Tmp unpack area** (`$TMPDIR/go-viz/sources/<project_id>/`). Эфемерный каталог распакованных исходников пользовательского ZIP. Удаляется TTL-sweeper'ом или вручную через `DELETE /api/projects/{id}` (NFR-13).
- **Disk cache** (`$TMPDIR/go-viz-cache/<project_id>/`). Долгоживущие сериализованные артефакты одного проекта: `parsed.gob`, `graph.json`, `dead-code.json`, `meta.json`. Переживают рестарт сервера (вариант C). Опционально монтируется volume'ом.

Граница сети — только между браузером и сервером (TCP :8080 локально). Никаких внешних сетевых вызовов изнутри контейнера (NFR-11, NFR-13) — `packages.Load` читает только распакованный tmp-каталог.

---

## 3. C4 L3 — Компоненты backend

Ровно 10 компонент, сгруппированных в три горизонтальных «полосы»: HTTP-граница, аналитический pipeline, оркестрация; плюс disk-cache сбоку. Диаграмма — `03-components-backend.excalidraw`.

### 3.1 HTTP-граница
1. **HTTP Server** (`net/http.ServeMux` + middleware). Один ServeMux, один порт. Middleware: `MaxBytesReader` (50 МБ — NFR-04/14), request-id, recover, CORS (только same-origin).
2. **SSEStreamer**. Тонкий адаптер над `http.ResponseWriter`: выставляет заголовки `text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, пишет `event:` / `data:` строки, делает `Flusher.Flush()` после каждого события. Канал `chan Event` буферизуется (size 64) чтобы не блокировать оркестратор.
3. **Embedded Static FS**. `//go:embed web/dist` + `http.FileServer` под `GET /`. Никаких сетевых вызовов в рантайме — все JS/CSS в бинаре.

### 3.2 Аналитический pipeline
4. **ProjectLoader**. Принимает multipart ZIP, проверяет лимиты (`MaxBytesReader`, `FileCount`, `UnpackedSize`), распаковывает через `archive/zip` с защитой от zip-slip (`filepath.Clean` + проверка `..`). Требует `go.mod` в корне (FR-01). Пишет meta.json.
5. **Parser**. Оборачивает `packages.Load` с режимом `NeedTypes | NeedTypesInfo | NeedSyntax | NeedImports | NeedDeps | NeedModule` (FR-04). Имеет read-through кэш: при повторной загрузке того же проекта читает `parsed.gob` (encoding/gob сериализация `[]*packages.Package` через reduced snapshot — не весь AST, а только то, что нужно GraphBuilder'у).
6. **GraphBuilder**. Ходит по `*types.Info.Uses / .Defs / .Implicits`, собирает узлы восьми типов (см. NodeKind в §4) и рёбра шести типов (EdgeKind). Ребро `implements` добавляется через итерацию `types.Implements` по парам `*types.Interface` × `*types.Named` (с учётом embedding и aliases — FR-09).
7. **EntryPointsResolver**. Auto-режим собирает все `func main` из `package main` (FR-06). Manual-режим принимает массив fully-qualified names (`pkg/path#Type.Method`) и резолвит через `types.Scope.Lookup`. Поддерживает расширение «включить все реализации интерфейса» через `types.Implements` (FR-07 + FR-09).
8. **ReachabilityAnalyzer**. Итеративный DFS от entry points, маркирует `Node.Reachable = true`. Недостижимые → `DeadCodeEntry[]` (FR-19). Работает на уже построенном графе (не на types.Info), поэтому дешёв и легко пересчитывается при смене entry points.
9. **Exporter**. Сериализует `Graph` в JSON (для UI) и `DeadCode` в TXT и JSON (FR-20, FR-23, FR-24). PNG/SVG экспорт (FR-21, FR-22) — чисто клиентский, через `cytoscape-svg` + canvas.toBlob.

### 3.3 Оркестрация
10. **AnalysisOrchestrator**. Склейка всего pipeline. Запускает per-analysis goroutine, пробрасывает `context.Context` с deadline. Использует `sync.Map[project_id]*sync.Mutex` для single-flight (один анализ одного проекта одновременно). Ловит panic'и через `defer recover()` и эмитит `SSEEvent{Type:"warning"}` + `Type:"done", payload:{error}`.

### 3.4 Сбоку
- **DiskCacheManager**. Централизует путь `$TMPDIR/go-viz-cache/<id>/`, владеет sweeper-горутиной (TTL idle 30 мин, проверка каждые 60 с), атомарные записи (`os.CreateTemp` + `os.Rename`). Все остальные компоненты ходят в кэш только через этот интерфейс (изоляция файловых путей).
- **External Go packages.** stdlib (`net/http`, `archive/zip`, `encoding/json`, `encoding/gob`, `embed`, `go/ast`, `go/types`, `sync`, `context`, `os`, `io/fs`, `path/filepath`, `time`, `log/slog`) + единственная внешняя зависимость `golang.org/x/tools/go/packages`. Фреймворков нет.

---

## 4. Data model

Подробная диаграмма — `05-data-model.excalidraw`. Коротко:

- **Project** (`server/internal/project`) — агрегат: `ID`, `SourcesDir`, `CacheDir`, `latestGraph *Graph`, `latestStatus AnalysisStatus`, `parseOnce sync.Once`, `analyzeMu sync.Mutex`.
- **Graph** — `Nodes []Node`, `Edges []Edge`, `Warnings []Warning`, `Stats GraphStats`. Сериализуется в JSON для `/api/projects/{id}/graph`.
- **Node** — `ID` (SHA-1 от каноничного FQN), `Name`, `Kind` (`NodeKind`), `Package`, `File`, `Line`, `Exported`, `Reachable`, `IsEntry`, `Doc`. **ID стабилен между перерасчётами** — Cytoscape переиспользует позиции (FR-11, FR-26).
- **Edge** — `ID` (SHA-1 от `Source|Target|Kind`), `Source`, `Target`, `Kind` (`EdgeKind`), `Weight`.
- **NodeKind** (enum-строка): `"package" | "struct" | "interface" | "func" | "method" | "field" | "var" | "const"`.
- **EdgeKind** (enum-строка): `"imports" | "contains" | "calls" | "embeds" | "implements" | "references"`.
- **EntryPointSpec**, **Filters** — см. секцию §5 API.
- **AnalysisStatus** — `Phase` (`loading|parsing|building_graph|reachability|exporting|done|failed`), `Progress`, `Message`. Попадает в SSE-события.
- **DeadCodeEntry** — `Kind, FQN, File, Line, Reason`.
- **Warning** — `Code, Message, Package?, File?` (NFR-08).
- **SSEEvent\<T\>** — wrapper `{Type, Seq, Payload}`; Seq монотонный для возможного resume.

---

## 5. Dynamic view — analysis flow

Диаграмма `04-flow-sse-sequence.excalidraw`. Ключевое:

1. `POST /api/projects` — синхронный (распаковка + валидация ≤ 2 с для 50 МБ).
2. Клиент сразу открывает `EventSource("/api/projects/{id}/analyze")`.
3. Сервер hijack'ает соединение, шлёт SSE-заголовки, спавнит worker goroutine.
4. Goroutine эмитит события: `phase:loading` → `phase:parsing` → (каждые N узлов) `partial_graph` → `phase:building_graph` → `phase:reachability` → `warning[]` → `done`.
5. Клиент инкрементально добавляет узлы в Cytoscape по мере прихода `partial_graph` (NFR-01, NFR-02).
6. При disconnect клиента goroutine видит `ctx.Err() == context.Canceled` и корректно сворачивается (NFR-09).
7. После `done` соединение закрывается; клиент может повторно получить полный граф через `GET /api/projects/{id}/graph` (или на reload — восстанавливает `project_id` из `localStorage`).

**Реактивность смены entry points (FR-07):** повторный `POST /api/projects/{id}/analyze` с новым `EntryPointSpec` попадает на существующий `Project` в памяти → `parsed.gob` уже есть → проходят только фазы reachability + export → отдаётся за < 1 с.

---

## 6. Architectural Decision Records (ADR)

Формат: **ADR-XX.** *Decision.* — **Context:** … — **Alternatives:** … — **Consequences:** …

### ADR-01. Стек фронтенда: React 19 + TypeScript 6 + Vite 8 + Cytoscape.js 3.33
- **Context:** FR-11 требует граф, FR-12..18 — zoom/pan/drag/collapse/aggregation. Нужен типобезопасный UI-слой.
- **Alternatives:** vanilla + sigma.js (меньше кода, но нет готовых утилит для tooltip/panel); Vue + vis-network (слабее типизация в Vue 2, переход на Vue 3 не даёт выигрыша); D3 + React (пришлось бы писать force-layout и hit-testing руками).
- **Decision:** Cytoscape.js 3.33 для графа (зрелый, есть `cytoscape-svg` для FR-22, API стабилен), React 19 + TypeScript 6 для UI-панелей (экосистема, DX, типы на контракте с Go через codegen), сборка Vite 8 (Rolldown — быстрее сборка на 10-30×).
- **Consequences:** bundle ~350 КБ gzip — приемлемо; добавляет Node-stage в Dockerfile; решения в CSS-stylesheet Cytoscape, а не styled-components (см. ADR-07). **Версии сверены на 2026-04-19**: React 19.2.5, TypeScript 6.0.2, Vite 8.0.8, Cytoscape.js 3.33.2 — перед `npm install` исполнитель **обязан** проверить свежие релизы (react.dev/versions, vitejs.dev/blog, typescriptlang.org, js.cytoscape.org) и зафиксировать текущие версии в `package.json`.

### ADR-02. Парсер Go-кода: `golang.org/x/tools/go/packages` в режиме NeedTypes+NeedTypesInfo+NeedSyntax+NeedImports+NeedDeps+NeedModule
- **Context:** FR-05 — структуры/интерфейсы/методы/поля; FR-09 — `types.Implements` с embedding.
- **Alternatives:** только `go/ast` (быстрее, но нет типовой информации — нельзя резолвить интерфейсы); `go/build` + `go/importer` (устарел, плохо работает с модулями); `gopls` как библиотека (тяжёлый, LSP-overhead).
- **Decision:** `x/tools/go/packages` — единственный поддерживаемый Google способ получить полный `*types.Package` + AST для модуля с зависимостями.
- **Consequences:** требует установленного Go toolchain в runtime-контейнере? **Нет** — мы распаковываем vendor'енные или module-cached зависимости, `GOFLAGS=-mod=mod` + `GOPATH=/tmp/go-viz/gopath`. Если у проекта нет vendor и нет сети — частично падают импорты, выдаются `warning` (NFR-08).

### ADR-03. Стратегия жизненного цикла анализа: async job + SSE streaming + disk cache (вариант C)
- **Context:** FR-07 (итерации по entry points должны быть быстрыми), NFR-01 (30 с), NFR-10 (переживание перезагрузки).
- **Alternatives:** A (sync blocking 30 с — ломает UX при больших проектах, конфликт с прокси-таймаутами), B (async polling без SSE — UX нормальный, но polling тратит трафик и не даёт real-time прогресс).
- **Decision:** SSE (`text/event-stream`) для событий, disk cache для артефактов, single-flight per project_id.
- **Consequences:** больше кода (~4k Go vs ~1.5k для A); EventSource не поддерживает POST — наш POST-хендлер сам upgrade'ит соединение на SSE (делаем вручную через `ResponseWriter.(http.Flusher)`); disk cache требует TTL sweeper.

### ADR-04. Формат доставки: single Docker multi-stage multi-arch image, SPA в `embed.FS`
- **Context:** NFR-07 (Linux/Windows/macOS, x86-64/ARM64), «один артефакт» удобен для защиты.
- **Alternatives:** отдельно фронтенд (S3/nginx) + backend (Go) — два артефакта, сложнее для студента-одиночки; собирать на лету на клиенте — нарушает идею «скачал и запустил».
- **Decision:** три stage'а — `node:24-alpine` для фронта (Node 24 — активный LTS до 2028-04; Node 20 заканчивает поддержку 2026-04-30), `golang:1.26-alpine` для бинаря (CGO_ENABLED=0), `gcr.io/distroless/static-debian12:nonroot` для рантайма (дефолтная версия distroless; `static-debian13` уже доступна, но не default на 2026-04-19); buildx для amd64+arm64 в один манифест.
- **Consequences:** образ ~15 МБ; `docker run -p 8080:8080` — готово; релиз через git tag + GH Actions. **Перед каждым релизом** исполнитель обязан проверить: (1) активный Node LTS на nodejs.org/en/about/previous-releases, (2) stable Go на go.dev/doc/devel/release, (3) default-tag distroless на github.com/GoogleContainerTools/distroless. Обновлять pinned-версии в Dockerfile по результатам.

### ADR-05. Детекция реализаций интерфейсов: `types.Implements` + явный обход embedding через `types.Named.NumMethods`
- **Context:** FR-09 требует учёт embedding и type aliases. Наивный обход методов типа пропускает унаследованные.
- **Alternatives:** только `types.Implements(T, I)` — не ловит методы embed'ов; парсить AST и искать `struct { A }` — хрупко.
- **Decision:** для каждого `*types.Named` собираем **method set** через `types.NewMethodSet` (который уже учитывает embedding), потом для каждой пары (T, I) зовём `types.Implements(types.NewPointer(T), I)` (чтобы ловить методы с pointer receiver). Type aliases проходят автоматически — `types.Alias` → `types.Unalias`.
- **Consequences:** O(|Types|·|Interfaces|) — для 50k LOC это ~5к × 500 = 2.5M проверок, ≤ 2 с, вписывается в NFR-01.

### ADR-06. Обработка больших графов (> 1000 узлов): агрегация по пакетам на сервере
- **Context:** FR-18 — автоматическая агрегация при > 1000 узлов.
- **Alternatives:** агрегация на клиенте (Cytoscape compound nodes) — граф >10k лагает в DOM; серверная агрегация с ручным expand — пересылка гигабайтов JSON.
- **Decision:** сервер при `len(Nodes) > 1000` возвращает агрегированный граф (один узел = один пакет, `kind:"package"`, `child_count:N`); клиент по клику на package-узел шлёт `POST /api/projects/{id}/expand?package=pkg/path` и получает детальный подграф только для выбранного пакета.
- **Consequences:** добавляет endpoint `/expand`; требует, чтобы Node.ID был одинаковым в детальном и агрегированном виде; экономит ~95% трафика для крупных monorepo.

### ADR-07. Стабильность Node.ID: SHA-1 от каноничного FQN
- **Context:** FR-26 — позиции узлов сохраняются между сессиями; FR-11 — граф перерендеривается при смене entry points без «прыжков».
- **Alternatives:** увеличивающиеся integer'ы — ломают позиции при переупорядочивании; random UUID — каждый анализ заново.
- **Decision:** `ID = hex(sha1("<pkg>#<Type>.<Method>"))[:16]`. Для пакета — `ID = hex(sha1("<pkg>"))[:16]`. Для локальных переменных — не включаем в граф (вне scope MVP).
- **Consequences:** переименование символа = новый ID = позиция теряется. Приемлемо: переименования редки, лучше потерять позицию, чем иметь коллизию.

### ADR-08. Защита от zip-slip и ресурсных атак
- **Context:** NFR-13, NFR-14. Пользователь загружает произвольный ZIP.
- **Alternatives:** доверять пользовательскому архиву (нет).
- **Decision:** три линии защиты:
  1. `http.MaxBytesReader(r.Body, 50*1024*1024)` на входе (лимит до чтения).
  2. При итерации `zip.Reader`: для каждого `File.Name` делаем `cleaned := filepath.Clean(name)`; если `strings.HasPrefix(cleaned, "..")` или `filepath.IsAbs(cleaned)` — reject.
  3. Счётчик файлов (`≤ 10000`) и суммарного распакованного размера (`≤ 500 МБ`), проверка on-the-fly — чтобы zip-bomb не раздулся на диске.
- **Consequences:** несколько десятков строк кода в ProjectLoader; сохраняем NFR-14 (все лимиты применяются **до** начала анализа).

### ADR-09. Конфигурация entry points через UI, без конфиг-файлов
- **Context:** FR-07 + уточнение пользователя 2026-04-18 («JSON/YAML вне scope»).
- **Alternatives:** `.goviz.yaml` в корне проекта — удобно для повторяемости, но лишний слой парсинга и лишний код.
- **Decision:** entry points задаются только через UI (`EntryPointSpec` в body POST-запроса); сохраняются в `localStorage` под ключом `go-viz:<project_id>:entry-points`.
- **Consequences:** CI-воркфлоу «прогнать vis по каждому PR» — вне scope MVP. Если захотим позже — добавим endpoint `POST /api/projects/{id}/config`.

### ADR-10. Async лайфцикл: single-flight per project_id, но параллелизм между проектами
- **Context:** NFR-01 + локальный запуск. Один пользователь, но возможно держать несколько проектов параллельно.
- **Alternatives:** глобальный mutex (убивает параллелизм); без защиты (два `/analyze` на один проект → конкурентная запись в `parsed.gob`, data race).
- **Decision:** `sync.Map[project_id]*sync.Mutex`; `Orchestrator` берёт этот mutex перед фазой parse/export, другие проекты работают без блокировки. Disk cache Manager использует `os.CreateTemp` + `os.Rename` — атомарная подмена файла, читатели никогда не видят полузаписанный `graph.json`.
- **Consequences:** минимальный overhead; hot-reload UI (разные вкладки на один project_id) получает один общий результат.

### ADR-11. Отсутствие веб-фреймворка на backend
- **Context:** Один разработчик, короткий срок, stdlib содержит всё нужное.
- **Alternatives:** gin/echo/chi — дают middleware-стек и router, но лишняя зависимость ради `net/http.ServeMux`.
- **Decision:** только stdlib. Маршрутизация — `http.ServeMux` с method-based routing (`mux.HandleFunc("POST /api/projects/{id}/analyze", ...)` + `r.PathValue("id")`) — доступно с Go 1.22, мы собираемся на Go 1.26 (см. ADR-04, NFR-05). Middleware — функции `func(http.Handler) http.Handler`.
- **Consequences:** меньше deps, проще аудит безопасности, проще CI; минус — нет из коробки validation bindings (пишем руками по 5 строк на endpoint). Документация по routing-патернам — https://pkg.go.dev/net/http#ServeMux (свериться перед имплементацией).

### ADR-12. Disk cache формат: gob для parsed, JSON для пользовательских артефактов
- **Context:** `parsed.gob` — только для сервера, читаем мы сами; `graph.json` и `dead-code.json` может открыть пользователь.
- **Alternatives:** всё в JSON (медленнее сериализация `*types.Package` reduced snapshot); всё в gob (пользователь не может прочитать).
- **Decision:** `parsed.gob` — encoding/gob (быстрее на ~3×, компактнее на ~2× для нашей схемы), `graph.json` / `dead-code.json` / `meta.json` — JSON. Версионируем через поле `SchemaVersion` в каждом файле, при несовпадении — rebuild (miss).
- **Consequences:** две кодогенерации типов (gob регистрация + json теги); `SchemaVersion` нужно бампать при миграциях.

---

## 7. Соответствие требованиям (NFR-матрица)

| NFR | Что гарантирует архитектура |
|---|---|
| NFR-01 (30 с на 50k LOC) | Parser кэширует `parsed.gob`; GraphBuilder O(|Defs|+|Uses|); пайплайн single-threaded, но все операции in-memory после parse |
| NFR-02 (5 с первой отрисовки) | Клиент рендерит `partial_graph` чанками — первые узлы появляются до завершения reachability |
| NFR-03 (< 100 мс UI) | Фильтры FR-14 — чисто клиентский CSS-класс toggle, без запроса |
| NFR-04 (лимиты ZIP) | `MaxBytesReader` + счётчики в ProjectLoader до распаковки |
| NFR-05 (Go 1.24+) | `go.mod: go 1.26` (актуальный stable на 2026-04-19); CI матрица `{1.25, 1.26}` |
| NFR-06 (ES2020 + SVG) | Vite target `es2020`, `cytoscape-svg` официально поддерживается |
| NFR-07 (multi-OS/arch) | `docker buildx --platform linux/amd64,linux/arm64`; CGO_ENABLED=0 |
| NFR-08 (partial + warnings) | `Warning[]` в каждом SSE-`done` и в `Graph`; Parser не падает на `packages.Errors` |
| NFR-09 (UI без reload) | React Error Boundary + toast; fetch ошибки → статус в стейте |
| NFR-10 (localStorage recovery) | `project_id` в localStorage + disk cache на сервере |
| NFR-11 (≤ 3 действия) | drag-drop → auto-entry points (FR-06) → граф |
| NFR-12 (английский UI) | Никакого i18n-слоя, все строки хардкодные |
| NFR-13 (изоляция FS) | `os.MkdirTemp` + `filepath.Clean` + zip-slip проверки |
| NFR-14 (лимиты до анализа) | `MaxBytesReader` + file-count check читаем заголовки ZIP до полной распаковки |

---

## 8. Риски

| Риск | Вероятность | Митигация |
|---|---|---|
| `packages.Load` не может резолвить импорты без сети / без vendor | Средняя | Выдаём `warning`, работаем на частичном графе (NFR-08). Документируем в README: «для полного результата запускайте vendor или подкладывайте GOMODCACHE». |
| SSE проксируется некорректно через какой-то LAN-прокси | Низкая | Заголовок `X-Accel-Buffering: no`, плюс прописано в README: «localhost only for MVP». |
| Disk cache разрастается | Низкая | TTL sweeper 30 мин idle; `DELETE /api/projects/{id}` вручную; документированный лимит N=10 проектов. |
| Cytoscape.js тормозит при > 5k узлов | Средняя | FR-18 — агрегация по пакетам on server (ADR-06). |
| Лимит 30 с не укладывается для очень связных проектов | Низкая | В ответе всегда возвращаем `elapsed_ms`; если стабильно > 30 с — перерасчёт NFR после сбора данных (заложен как open question в requirements §8). |
| Embed.FS + изменения web/ без rebuild Go = штаны | Низкая | В Dockerfile COPY после npm build гарантирует актуальность; для dev — второй режим `-ldflags "-X main.useLiveAssets=true"` (nice-to-have, не MVP). |

---

## 9. Deployment в двух словах

См. `06-deployment.excalidraw`.

- **Build.** 3-stage Dockerfile: Node → Go → distroless. `docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/<user>/go-viz:<tag> --push .`
- **Release.** GH Actions on git-tag push → buildx → push → GH Release body.
- **Run.** `docker run --rm -p 8080:8080 ghcr.io/<user>/go-viz:latest` → открыть `http://localhost:8080`.
- **Persist cache (опционально).** `-v go-viz-cache:/tmp/go-viz-cache`.

---

## 10. Что явно не закрыто архитектурой

- **Auth / multi-user.** Инструмент — «локальный dev-тул», никакой аутентификации нет. Для LAN-развёртывания поставить reverse-proxy с basic auth — вне scope MVP.
- **Persistence проектов между рестартами без volume.** Если disk cache в эфемерном контейнере — проекты теряются. Документируется в README.
- **Go-tool chain в контейнере.** Мы НЕ компилируем пользовательский код (только анализируем), но `packages.Load` в режиме с типами требует резолва импортов — зависит от настройки `GOFLAGS`. Проверить на защите на крупном примере.
- **HTTPS.** Локально не нужен; для LAN — ставится Caddy перед контейнером.

---

## 11. Политика актуальности версий (binding для исполнителя)

Все версии в этом документе зафиксированы на **2026-04-19**. Релизы языков/рантаймов/библиотек выходят часто, и к моменту имплементации (phase 3) эти числа почти наверняка устареют. Исполнитель **обязан** проверить актуальность в следующих точках:

1. **На старте каждой фазы реализации.** Перед `go mod init` / `npm init` / `FROM` в Dockerfile — зайти на официальные release-страницы и зафиксировать актуальные stable-версии в соответствующих lock-файлах.
2. **Перед каждым релизом (git tag v*).** Проверить, что pinned-версии не получили critical-security-patch; если получили — обновить + rebuild + rerelease.
3. **Если в README / CI / Dockerfile используется `latest`-тег** — он запрещён. Только pinned major.minor(.patch) версии.

Источники, которые надо проверять (authoritative):

| Технология | Источник | Что смотреть |
|---|---|---|
| Go stable | https://go.dev/doc/devel/release | последний `Go 1.N.M (released YYYY-MM-DD)` |
| React | https://react.dev/versions | «Latest version» |
| Node.js LTS | https://nodejs.org/en/about/previous-releases | Active LTS + Maintenance |
| Vite | https://vite.dev/releases | последний major-release post |
| TypeScript | https://www.typescriptlang.org/ | «Download» в хедере |
| Cytoscape.js | https://js.cytoscape.org/ / https://github.com/cytoscape/cytoscape.js/releases | latest tag |
| distroless | https://github.com/GoogleContainerTools/distroless | дефолтный `-debianNN` тег |
| x/tools/go/packages | https://pkg.go.dev/golang.org/x/tools/go/packages | API stability notes |

Актуализация — это **обязательное требование** (не nice-to-have). Любой PR, который использует версии старше указанных в таблице выше без обоснования, не вливается.

---
