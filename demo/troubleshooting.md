# Demo: troubleshooting на защите

План B при основных классах сбоев. Каждый блок — симптом → быстрая
диагностика → fix → fallback.

## 1. Docker не стартует

**Симптом.** `docker info` падает с `Cannot connect to the Docker
daemon`, или `docker run` зависает.

**Диагностика.**
```bash
docker info >/dev/null && echo OK || echo FAIL
ps aux | grep -i docker | head
```

**Fix.** Запустить Docker Desktop GUI вручную, подождать 10–15 секунд,
повторить `docker info`.

**Fallback (без Docker).** Запустить локальный бинарь:
```bash
cd server && CGO_ENABLED=0 go build -o bin/server ./cmd/server
./bin/server &      # http://localhost:8080
# В другом окне:
cd web && npm run preview -- --port 4173
# Открыть http://localhost:4173 (Vite preview), а API проксировать
# напрямую к :8080.
```

Если фронт-Vite preview не нужен (статика уже встроена в Go-бинарь
через embed.FS) — достаточно `./bin/server` и заходить на
http://localhost:8080.

## 2. Порт 8080 занят

**Симптом.** `docker run -p 8080:8080 ...` → `Bind for 0.0.0.0:8080
failed: port is already allocated`.

**Диагностика.**
```bash
lsof -i :8080 | grep LISTEN
```

**Fix-1.** Убить владельца:
```bash
docker stop go-viz-demo 2>/dev/null
kill $(lsof -t -i :8080)
```

**Fix-2.** Переадресация на свободный порт:
```bash
docker run --rm -d -p 9090:8080 --name go-viz-demo go-viz:rc1
# Открыть http://localhost:9090
```

В URL-баре slides обязательно поправить, чтобы аудитория не путалась.

## 3. SSE от `/analyze` не приходит

**Симптом.** Analyzing screen «висит» бесконечно, phase-badges не
обновляются. Network DevTools показывает `EventStream` без событий,
либо CORS / proxy blocked.

**Диагностика.**
```bash
# Замените PROJECT_ID на актуальный из network tab.
curl -N -X POST http://localhost:8080/api/projects/<ID>/analyze
```

Если события идут в `curl -N`, но не в браузере — виновник прокси
(corporate VPN, proxy.pac режет text/event-stream).

**Fix.** Отключить VPN/прокси, либо использовать инкогнито-окно. На
самой защите — переключиться на mobile-tether / hotspot.

**Fallback (визуальный).** На проекторе показать `curl -N`-ленту
живьём — это тоже валидное демо архитектурного решения C.

## 4. Браузер блокирует download

**Симптом.** Клик `Export SVG` или `TXT` ничего не даёт; в DevTools
console предупреждение `Cross-Origin-Opener-Policy` или Safari «pop-up
blocked».

**Fix-1.** В Safari: Settings → Websites → Pop-up Windows → Allow для
`localhost`.

**Fix-2.** Использовать прямую ссылку с query `?download=1`:
```text
http://localhost:8080/api/projects/<ID>/dead-code.txt
http://localhost:8080/api/projects/<ID>/graph.json
```

**Fallback.** Открыть SVG в новой вкладке: правый клик → Save As. Для
TXT — `View Source` и копи-паст в редактор.

## 5. Анализ медленнее ожидаемого (NFR-01 не уложился)

**Симптом.** Analyzing > 60 секунд на medium-фикстуре.

**Диагностика.**
```bash
docker logs go-viz-demo | tail -40
# Ищем: parser.Load took=XXXX ms
```

**Fix-1.** Pre-warm перед защитой:
```bash
# За 5 минут до защиты — один dry-run, чтобы Go module cache
# в контейнере «прогрелся» (а ZIP перепарсился).
curl -s http://localhost:8080/api/projects -X POST -F archive=@demo/fixtures/medium.zip
# Не интересен ID; цель — чтобы первый анализ не платил bootstrap
# стоимость mod resolution.
```

**Fix-2.** Использовать только small.zip. Walkthrough §1–6 не требует
medium; §7 опционален.

**Fallback.** Заранее снять видео (вне scope T27, но рекомендуется как
страховку). Либо на защите показать кэш T26
(`test-evidence/T26/logs/nfr-measurements.log`) как доказательство, что
pipeline работает; устно объяснить разницу с live-демо.

## 6. Граф пустой / 1 placeholder-узел

**Симптом.** После анализа в заголовке `1 nodes · 1 dead`, в области
графа изолированный круглый узел без подписи. Ниже — warning
`import_error: directory prefix . does not contain main module`.

**Диагностика.**
```bash
unzip -l demo/fixtures/<X>.zip | head -5
# Если вы видите `<dir>/go.mod` (одна leading-папка) — это причина.
# Должно быть `go.mod` в корне ZIP без префикса.
```

**Fix.** Пересобрать фикстуры через
`scripts/build-fixtures.sh --force` (новый скрипт пакует «плоско»).
Если фикстура своя — переупаковать:
```bash
cd unzipped/<dir> && zip -qr ../fixed.zip .
```

**Объяснение.** Анализатор запускает `packages.Load("./...")` из корня
распакованного ZIP. Если `go.mod` лежит на одну папку ниже — Go-toolchain
не находит модуль и возвращает single-error результат.

## 7. Toast «Recent project expired»

**Симптом.** В Recent Projects на Landing нажимаешь «Restore» — появляется
warning toast и проект пропадает.

**Объяснение.** Disk cache в контейнере живёт 30 минут (см.
`server/internal/cache/sweeper.go`). После рестарта контейнера ID становятся
stale.

**Fix.** Обычная загрузка ZIP заново.

## 8. Вкладка Safari/Chromium крашится

**Симптом.** Tab дохнет на больших графах (≥ 1000 узлов).

**Объяснение.** Cytoscape webgl renderer не используется (см.
ADR-03 в architecture.md), фолбэк на canvas ограничен возможностями
браузера.

**Fix.** Открыть в Chrome (V8 + canvas2D обычно лучше переживают),
включить агрегацию через выключение `Funcs`/`Methods` в Filters.

## Контакты

Автор: Горячев И. С., БПИ236.
Репозиторий: `https://github.com/vanek-goriachev/incogodevi`.
