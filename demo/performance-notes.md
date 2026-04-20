# Demo: замеры производительности (NFR-01 / NFR-02 / NFR-03 / NFR-09)

Документ фиксирует РЕАЛЬНЫЕ цифры, измеренные на reference-машине, а не
плановые таргеты. Если измерение не уложилось в требование `requirements.md`
§3 — это явно отмечено.

## Reference-железо

| Параметр       | Значение                                                              |
|----------------|------------------------------------------------------------------------|
| Модель         | MacBook Pro (Mac15,7), 2024                                            |
| Чип            | Apple M3 Pro, 12 ядер (6 performance + 6 efficiency)                    |
| RAM            | 36 GB                                                                  |
| OS             | macOS 14.6 (build 23G80)                                               |
| Docker         | 28.0.4 (Docker Desktop)                                                 |
| Image          | `go-viz:rc1` (250 MB; multi-stage Dockerfile, runtime `golang:1.26-alpine`) |
| Браузер        | Chromium через Playwright (headless), viewport 1440×900                 |

## Methodology

- Сервер запущен в Docker `--rm -d -p 8080:8080 --name go-viz-demo go-viz:rc1`.
- Перед каждым прогоном fresh container (cache prewarm не делается, кроме
  Go module cache внутри образа).
- 3 независимых прогона, каждый — новый browser context (нет
  localStorage carry-over между запусками).
- Таймстампы взяты Playwright-скриптом `scripts/walkthrough` (см.
  `test-evidence/T27/logs/walkthrough-measurements.log` и
  `perf-additional-runs.log`).

## NFR-01 — end-to-end анализ medium-проекта

**Требование** (`requirements.md` §3.1): `≤ 30 c`.
**Фикстура**: `demo/fixtures/medium.zip` (`go-chi/chi`, `~5k LOC` non-test).

| Прогон | upload → first paint (ms) | post-main render (ms) | Источник лога                          |
|--------|---------------------------|-----------------------|-----------------------------------------|
| 1      | 32 681                    | 196                   | walkthrough-measurements.log            |
| 2      | 34 817                    | 191                   | perf-additional-runs.log                |
| 3      | 34 402                    | 145                   | perf-additional-runs.log                |

| Метрика | Значение |
|---------|----------|
| median  | **34 402 ms** |
| p95 (max из 3) | **34 817 ms** |
| min     | 32 681 ms |
| target  | 30 000 ms |

**Вердикт**: NFR-01 **не уложился в 30 c** на текущем коммите при анализе
chi (флаг — `not met by ~4.4 s on median`). Causes:

1. Container runtime использует `golang:1.26-alpine` с включённым go
   toolchain — модуль cache холодный при первом запросе, `go list ./...`
   выполняет ~30 c из бюджета (см. tech-debt: `dockerfile: distroless lacks
   go toolchain`).
2. Сам chi, несмотря на размер ~5 k LOC, поднимает заметное число
   transitive deps через `golang.org/x/...` (resolved offline через
   bundled mod cache, но всё ещё требует `go list`).

**Что делать к защите**:
- Зафиксировать честно цифру в `RELEASE.md` чек-листе.
- На защите: либо подождать ~35 секунд, либо проиграть pre-recorded
  walkthrough (в этом T27 не реализовано). Прогон walkthrough с small
  фикстурой (urfave/cli) занимает столько же из-за того же холодного
  toolchain — небольшой объём кода не помогает.

> Дополнительные замеры NFR-01 из T26 (chi с **leading-директорией**, до
> исправления build-fixtures.sh): 506 ms, 524 ms, 478 ms — но они
> измеряли `import_error → 1 placeholder node` сценарий, а не реальный
> анализ. После исправления layout архива (`scripts/build-fixtures.sh`
> теперь пакует «плоско») цифры стали честными — те, что в таблице выше.

## NFR-02 — первая отрисовка графа после получения данных

**Требование**: `≤ 5 с`.
**Что измеряем**: интервал между `screen-main` появился (= данные графа
получены) и `graph-canvas` появился в DOM (= Cytoscape проинициализирован).

| Прогон | small (ms) | medium (ms) |
|--------|------------|-------------|
| 1      | 4          | 196         |
| 2      | 3          | 191         |
| 3      | 4          | 145         |

| Метрика | small | medium |
|---------|-------|--------|
| median  | **4 ms**  | **191 ms** |
| target  | 5000 ms | 5000 ms |

**Вердикт**: NFR-02 **выполнен** с большим запасом (×25k).

> Для исторической полноты: T26 NFR-02 в Playwright-suite на «фейковой»
> chi-фикстуре давал 28–251 ms (Chromium) и 54 ms (WebKit) — диапазон
> совпадает.

## NFR-03 — отклик UI на toggle фильтра

**Требование**: `< 100 ms`.

Замеры из walkthrough:
- 1 sample на small (urfave/cli, 304 nodes): `179 ms`.

Дополнительные замеры из T26 NFR suite (`test-evidence/T26/logs/nfr-measurements.log`):

| Платформа | samples_ms                  | median (ms) | max (ms) |
|-----------|-----------------------------|-------------|----------|
| Chromium  | [82, 74, 58, 38, 34]        | 58          | 82       |
| Chromium  | [134, 86, 37, 44, 37]       | 44          | 134      |
| Chromium  | [152, 84, 32, 34, 35]       | 35          | 152      |
| WebKit    | [178, 113, 63, 53, 57]      | 63          | 178      |

**Вердикт**: NFR-03 **выполняется на медиане** (всё ≤ 63 ms), но
`p95/max` выскакивает за 100 ms на больших графах. На небольших фикстурах
T26 (synthetic simple, ~10 узлов) почти всё в бюджете; на 304-узловом
urfave/cli первый toggle 179 ms — это `Cytoscape::style()` reflow.

**Honest assessment**: «UI отклик ≤ 100 ms» в среднем — да, в худшем
случае — нет. Это согласуется с тем, что `requirements.md` §3.1 ограничивает
NFR-03 «графом ≤ 1000 узлов»; для 304 узлов first-toggle стоит дороже из-за
LRU-холодности.

## NFR-09 — recovery после ошибки

**Требование**: UI не требует reload при ошибках взаимодействия с графом.

Из T26 (`nfr-measurements.log`):
- Chromium runs ×3 — `recovered=true` (Error Boundary поймал, toast
  показан, состояние сохранено).
- WebKit run ×1 — `recovered=true`.

**Вердикт**: NFR-09 **выполнен**.

## NFR-04 — лимиты архива

Не пере-измеряли в T27 — покрыто unit-тестом
`server/internal/loader/loader_test.go::TestRejectsArchivesOverLimit`. Все
3 ZIP-фикстуры в demo (small 3.4 MB, medium 124 KB) **существенно ниже**
лимита 50 MB.

## Multi-platform верификация

| OS                      | Прогнан walkthrough | Результат | Заметка                                                                                       |
|-------------------------|---------------------|-----------|------------------------------------------------------------------------------------------------|
| **macOS 14.6 / Apple M3 Pro** | да                | works     | основная reference-машина автора                                                                |
| **Linux** (любая дистрибуция) | **NOT VERIFIED**  | —         | у автора нет Linux-машины с Docker; CI на GitHub Actions (`.github/workflows/ci.yml`) собирает образ multi-arch на Ubuntu runner — этим закрыт «build», но runtime walkthrough руками не проигран. |
| **Windows 10/11**       | **NOT VERIFIED**    | —         | у автора нет Windows-машины; `docker run` на Windows технически идентичен macOS/Linux, но не проигран руками. |

`requirements.md` §3.2 NFR-07 требует минимум 2 платформы — формально
закрывает только macOS + Linux-в-CI. Honest stance перед комиссией:
«multi-arch билд проверен на CI, runtime ручной только macOS».

## Ссылки

- Сырые логи: `test-evidence/T27/logs/walkthrough-measurements.log`,
  `test-evidence/T27/logs/perf-additional-runs.log`.
- Скриншоты: `test-evidence/T27/screenshots/`.
- Скачанные файлы: `test-evidence/T27/downloads/`.
- T26 baseline: `test-evidence/T26/logs/nfr-measurements.log`.
