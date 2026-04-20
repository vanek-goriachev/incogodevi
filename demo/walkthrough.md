# Demo: пошаговый сценарий защиты

5–7 минут. Подразумевается, что слушатель видит экран, а спикер ведёт
действия и комментирует. Все скриншоты — `test-evidence/T27/screenshots/`.

## Pre-flight (за 5 минут до защиты)

```bash
# 1. Открыть терминал в корне репозитория.
cd /path/to/project

# 2. Убедиться, что Docker запущен.
docker info >/dev/null    # должен вернуть 0

# 3. Сборка образа (если ещё не собран).
make docker-build-local IMAGE=go-viz VERSION=rc1
docker images go-viz:rc1   # должен показать строку

# 4. Освободить порт 8080.
lsof -i :8080 | grep LISTEN   # пусто = ок

# 5. Запустить контейнер в фоне.
docker run --rm -d -p 8080:8080 --name go-viz-demo go-viz:rc1
sleep 5
curl -s http://localhost:8080/api/healthz   # {"status":"ok",...}

# 6. Открыть http://localhost:8080 в Chrome или Safari.

# 7. Проверить наличие demo-фикстур.
ls demo/fixtures/   # small.zip medium.zip
```

При сбое — см. `troubleshooting.md`.

## Шаги демонстрации

### Шаг 1 (≈45 с) — Landing и загрузка small

> **Действие.** Перенести `demo/fixtures/small.zip` (urfave/cli v2.27.5)
> drag-and-drop в зону посередине экрана; либо кликнуть и выбрать через
> диалог.

> **Что показать.**
> - Drop-zone подсвечивается при заходе курсором с файлом (FR-01).
> - В правом верхнем углу появляется toast `Uploaded github.com/urfave/cli/v2`.
> - Происходит навигация на экран Analyzing.

> **Скриншоты.** `01-landing.png`, `02-analyzing.png`.

### Шаг 2 (≈30 с) — Analyzing view

> **Что показать.**
> - Phase-badges (`loading`, `parsing`, `building_graph`, `reachability`,
>   `done`) подсвечиваются по мере приходящих SSE-событий.
> - Прогресс-бар обновляется в реальном времени (FR не помечает время
>   парсинга, но демонстрирует архитектурное решение C — SSE streaming).
> - Анализ urfave/cli занимает ≈35 с end-to-end на reference-машине
>   (см. `performance-notes.md`).

> **Скриншот.** `02-analyzing.png`.

### Шаг 3 (≈60 с) — Главный экран, граф и dead code

> **Действие.** Дождаться навигации в Main view (≤ 1 минуты).

> **Что показать.**
> - В заголовке: `github.com/urfave/cli/v2 · 304 nodes · 8 dead`.
> - Cytoscape.js рендерит fcose layout (FR-11).
> - Wheel zoom, drag пустой области = pan (FR-12), drag узла (FR-13).
> - Hover по узлу — tooltip с `kind / name / package / file:line` (FR-17).
> - Узлы с пунктирной серой обводкой = dead (FR-15).
> - В правой панели Dead-code (FR-19, FR-20) перечислены 8 unreachable
>   сущностей со ссылкой `pkg.Name — file:line`.

> **Скриншоты.** `03-graph-with-dead.png`, `04-deadcode-panel.png`.

### Шаг 4 (≈30 с) — Dead-only режим

> **Действие.** Нажать клавишу `d` (или клик на сегмент `Dead only` в
> top-bar).

> **Что показать.**
> - Видны только мёртвые узлы — режим аудита (FR-15 + design.md §5.3).
> - В правом верхнем углу остаётся живая Dead-code panel.
> - Повторное нажатие `d` (или `Live + dead`) возвращает все узлы.

> **Скриншот.** `05-dead-only-mode.png`.

### Шаг 5 (≈45 с) — Manual entry point

> **Действие.** Кликнуть `+ Add entry point` в левой панели Entry Points.

> **Что показать.**
> - Открывается диалог с двумя вкладками (`Pick from list` и `Type FQN`).
> - Pick: можно выбрать любую функцию/метод/тип из всех индексированных
>   сущностей (FR-07).
> - Type FQN: ввод вида `github.com/urfave/cli/v2.NewApp` запускает
>   валидацию формата и проверку дубликатов (`entry-dialog-syntax-error`,
>   `entry-dialog-duplicate-error`).
> - После Submit → бэкенд переанализирует с обновлённым набором entry
>   points → SSE снова стримит phase-events → граф пересчитан, изменилась
>   подсветка dead-кода.

> **Скриншот.** `06-manual-entry.png`.

### Шаг 6 (≈30 с) — Export SVG + dead-code TXT

> **Действие.** В правой нижней панели нажать `SVG` (Export panel) и потом
> `TXT` в Dead-code panel.

> **Что показать.**
> - Браузер скачивает `<project>-graph-<timestamp>.svg` (FR-22) — открыть
>   в новой вкладке, видна векторная копия графа.
> - Скачивается `<project>-dead-code-<timestamp>.txt` (FR-23) — текстовый
>   список одна сущность в строку, как в FR-20 формате
>   `<kind> <pkg>.<name> — <file>:<line>`.

> **Скриншот.** `07-export-svg.png`. Сохранённые файлы:
> `test-evidence/T27/downloads/small-graph.svg`,
> `test-evidence/T27/downloads/small-deadcode.txt`.

### Шаг 7 (≈60 с, опционально) — Medium-проект (chi)

> **Действие.** Открыть Landing (кнопка в top-nav), drag-drop
> `demo/fixtures/medium.zip`.

> **Что показать.**
> - Аналогичный поток: analyzing → main view (≈34 с end-to-end).
> - 197 узлов, 197 dead — chi-это библиотека, нет `func main()` →
>   warning `no_auto_entry_points` → всё помечено как dead. На демо это
>   отличный повод повторить разговор о FR-07: «чтобы получить осмысленный
>   reachability-анализ библиотеки, нужно вручную добавить entry points».

> **Скриншот.** `08-medium-aggregated.png`.

### Шаг 8 (≈30 с, опционально) — Filters

> **Действие.** В левой панели Filters снять чекбокс `Vars` (или любой
> другой кинд).

> **Что показать.**
> - Узлы соответствующего типа мгновенно исчезают (FR-14, NFR-03).
> - Счётчики `1`, `0`, `…` рядом с каждым киндом отражают реальное
>   распределение в загруженном графе.

> **Скриншот.** `09-filter-by-kind.png`.

### Шаг 9 — Завершение

```bash
docker stop go-viz-demo
```

## Резервные комментарии

Если задают вопрос «а что внутри?» — открыть на проекторе:

- `docs/architecture.md` §3 диаграмма компонентов
- `docs/api-contract.md` — REST + SSE endpoints
- `Dockerfile` — multi-stage (frontend-builder → backend-builder → runtime)

Если что-то идёт не по плану — `troubleshooting.md`.
