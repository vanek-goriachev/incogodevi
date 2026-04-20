# Demo: выбор upstream Go-проектов

Документ фиксирует, какие реальные open-source Go-проекты используются на
защите курсового проекта Go Dependencies Visualizer и почему.

## Выбранные проекты

| Уровень  | Репозиторий                    | Pin (git ref) | Файлов `.go` | LOC (без тестов) | LOC (всего) | Размер ZIP |
|----------|--------------------------------|---------------|--------------|------------------|-------------|------------|
| `small`  | `github.com/urfave/cli`        | `v2.27.5`     | 69           | ~10 158          | ~24 846     | 3.4 MB     |
| `medium` | `github.com/go-chi/chi`        | `a54874f0`    | 74           | ~5 323           | ~10 369     | 124 KB     |

LOC посчитаны без сторонних утилит (нет `scc`/`cloc` на референс-машине)
командой `find . -name '*.go' [-not -name '*_test.go'] | xargs wc -l`. Цифры
приблизительные (включают пустые строки и комментарии), но порядок величин
честный.

> Замечание о размерах. В §6 `requirements.md` для «medium» был ориентир
> 30–50 k LOC. Из-за позднего выбора и ограниченного времени до защиты в
> manifest зафиксирован реально встретившийся `go-chi/chi`, который оказался
> компактнее (≈5 k без тестов). Соответственно фактический «medium» в demo —
> upper-end small. Это отражено в `performance-notes.md` (NFR-01 верифицирован
> на этом датасете). Замена на действительно 30–50 k LOC проект (например,
> `gohugoio/hugo`) возможна как post-MVP улучшение, см. tech-debt.

## Pin и воспроизводимость

ZIP-архивы собираются скриптом `scripts/build-fixtures.sh` из
`e2e/fixtures/manifest.json`. Manifest хранит точные SHA / теги, поэтому при
повторной сборке набор файлов идентичен.

```bash
./scripts/build-fixtures.sh           # инкрементально, скачивает только отсутствующие
./scripts/build-fixtures.sh --force   # пересобрать всё
```

Каталог `demo/fixtures/` содержит симлинки в `e2e/fixtures/.cache/` —
архивы лежат в одном месте и переиспользуются и demo-сценарием, и Playwright
suite (`e2e/`).

```text
demo/fixtures/small.zip   -> ../../e2e/fixtures/.cache/demo-small.zip
demo/fixtures/medium.zip  -> ../../e2e/fixtures/.cache/medium.zip
```

Архивы упакованы «плоско» (без leading-директории `chi/` или `cli/`) — это
обязательное условие для анализатора, который запускает
`packages.Load("./...")` из корня распакованного архива. Иначе появляется
warning `import_error: pattern ./...: directory prefix . does not contain
main module` и в графе один placeholder-узел. См. `troubleshooting.md`.

## Обоснование выбора

### `urfave/cli` v2.27.5 — small

- Узнаваемость: один из двух де-факто стандартов CLI-фреймворков в Go-комьюнити
  (~22k звёзд). На демо аудитория ВШЭ воспринимает как реальный проект,
  а не synthetic testdata.
- Размер: ~10k LOC без тестов / ~25k с тестами — укладывается в верхнюю
  границу «small» по `requirements.md` §6.
- Структура: один корневой `go.mod`, нет vendor/. Дополнительный
  под-модуль `cmd/urfave-cli-genflags/` со своим `go.mod` присутствует, но
  анализатор его игнорирует — `findGoMod` в `loader.go` выбирает первый
  `go.mod`.
- Богатая интерфейсная иерархия (`Flag`, `DocGenerationFlag`, `Generic`),
  что делает интересным демо реализаций интерфейсов (FR-09).
- Является библиотекой → нет `func main()` → срабатывает warning
  `no_auto_entry_points` → демо отлично иллюстрирует FR-07 (manual entry
  points) на втором экране.

### `go-chi/chi` SHA `a54874f0` — medium

- Реюз с T26: фикстура уже была pinned для `nfr-01-bench.spec.ts`, не
  размножаем источники.
- Single-module library, `go.mod` в корне — простой happy-path для
  анализатора.
- Содержит `middleware/` — десятки самостоятельных middleware с минимальными
  зависимостями, хорошо демонстрируют как dead-code-аудит (без entry points
  всё помечено dead), так и фильтры по типам сущностей (FR-14).

### Что не выбрано и почему

- `spf13/cobra` — функционально аналогичен `urfave/cli`, но меньше (~7k LOC
  без тестов). Не даёт прироста демо-ценности.
- `gohugoio/hugo` — действительно подходит под medium 30–50k LOC, но
  multi-module, vendor больше 50 МБ — нарушает NFR-04. Кандидат на
  post-MVP.
- `prometheus/prometheus` — слишком велик (>200k LOC), за пределами NFR-04.
- Synthetic `e2e/fixtures/simple/` — оставлен как unit-фикстура для T26;
  для defense он не «реальный Go-проект» в смысле §6 requirements.

## Как добавить новый проект

1. Дописать запись в `e2e/fixtures/manifest.json`:
   ```json
   { "name": "demo-X", "kind": "git",
     "upstream_url": "https://github.com/<org>/<repo>.git",
     "sha": "<sha-or-tag>", "zip_root": "<dir-name>" }
   ```
2. Запустить `scripts/build-fixtures.sh` — создастся
   `e2e/fixtures/.cache/demo-X.zip` (плоская упаковка, без leading dir).
3. Симлинк в `demo/fixtures/` при необходимости.
4. Обновить таблицу в этом файле.
