# Research Notes

Краткая сводка по ключевым технологическим решениям. Источники — web-поиск, дата обращения 2026-04-18.

## 1. go-callvis (аналог)

- Инструмент визуализации call-графа Go-программ через Graphviz. Источник данных — pointer/points-to анализ (`ssa`, `callgraph/pointer`). Алгоритмы: `static`, `cha`, `rta`, `vta`.
- Вывод — статическая картинка (dot → SVG/PNG). **Нет интерактива, zoom/drag/pan, настройки уровня детализации, работы через браузер без установки Graphviz.**
- Не строит граф от произвольных точек входа и не выделяет мёртвый код.
- Ссылка: https://github.com/ondrajz/go-callvis

Следствие для scope: наш инструмент закрывает интерактив + dead code + multi-entry, чего в go-callvis нет.

## 2. staticcheck / U1000 (аналог)

- Проверка `U1000` помечает unused-сущности, но работает **только в рамках пакета**: exported-идентификаторы на уровне пакета всегда считаются используемыми (в т.ч. в `main` и тестах), так как могут быть вызваны через `plugin`, reflection и т. п.
- Whole-program mode был удалён в 2020.2 — не совместим с кешем.
- Текстовый вывод, без визуализации, без «леса» точек входа.
- Источник: https://staticcheck.dev/changes/2020.2/, https://staticcheck.dev/docs/configuration/

Следствие: наш анализ мёртвого кода **от явных точек входа проекта** даёт больше, чем U1000, т. к. позволяет помечать неиспользуемые exported-функции как мёртвые в контексте конкретного набора entry points.

## 3. Граф-библиотеки (выбор)

- **Cytoscape.js** — держит тысячи узлов благодаря инкрементальному рендерингу, framework-agnostic, из коробки: zoom, pan, drag, layouts (dagre, fcose, cose-bilkent), стилизация через селекторы. Активная разработка, большое комьюнити.
- **vis-network** — проще API, но хуже масштабируется на >500–1000 узлов (canvas, без WebGL).
- **sigma.js** — WebGL, очень быстрый на больших графах, но беднее стилизацией и UI.
- **React Flow** — только для React, отличная кастомизация узлов, но слабее на >500 узлов.

Источник: https://npm-compare.com/cytoscape,d3-graphviz,vis-network, https://www.cylynx.io/blog/a-comparison-of-javascript-graph-network-visualisation-libraries/

Решение: **Cytoscape.js** — лучший баланс производительность/интерактив/независимость от фреймворка. React-обёртка (`react-cytoscapejs`) существует и тривиальна.

## 4. `golang.org/x/tools/go/packages` (API анализа)

- Актуальный API загрузки Go-пакетов с типовой информацией.
- Нужные `LoadMode`: `NeedName | NeedFiles | NeedCompiledGoFiles | NeedImports | NeedDeps | NeedTypes | NeedTypesInfo | NeedSyntax | NeedModule`.
- Требуется `NeedImports` при запросе `NeedTypes`/`NeedTypesInfo`/`NeedDeps`.
- Даёт `*types.Package`, `*types.Info` (`Defs`, `Uses`, `Implicits`) → достаточно для обхода use-def, `types.Implements`, метод-сетов.
- Источник: https://pkg.go.dev/golang.org/x/tools/go/packages, https://pkg.go.dev/go/types

Следствие: это и есть базовый инструмент для FR-анализа интерфейсов (`types.Implements`, `types.MissingMethod`). Сырого `go/ast` недостаточно для точного определения имплементаций.

## 5. Прочие технические заметки

- Docker-образ multi-stage: stage1 (Node) собирает `/web` в статику, stage2 (Go) встраивает её через `embed.FS` и компилирует бинарь, stage3 (distroless или `alpine`) — runtime.
- Cytoscape.js умеет экспортировать текущий вид в PNG (`cy.png()`) и JPG из коробки. SVG — через плагин `cytoscape-svg`.
- Лимит `50 МБ` / `10 000 файлов` / `50 000 LOC` — производные от NFR-таймингов ТЗ (30 с на 50k LOC); превышение — HTTP 413 с понятным сообщением.
