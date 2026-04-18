# API Contract — Go Dependencies Visualizer

> Вариант C: синхронный upload + SSE-анализ + REST-доступ к артефактам. Все эндпоинты под префиксом `/api/`. SPA обслуживается с `GET /` (не документируется здесь — это статика из `embed.FS`).

---

## 0. Общие соглашения

- **Base URL.** `http://<host>:8080` (по умолчанию). Никаких версионных префиксов — MVP.
- **Форматы.** `Content-Type: application/json; charset=utf-8` для входов/выходов, `multipart/form-data` для ZIP, `text/event-stream` для анализа.
- **Идентификаторы.** `project_id` — URL-safe 22-символьная base64 от 16 случайных байт (`crypto/rand`).
- **Коды ошибок.** Общий envelope:
  ```json
  {
    "error": {
      "code": "project_not_found",
      "message": "project <id> not found or expired",
      "details": { "project_id": "…" }
    }
  }
  ```
- **Коды HTTP.**  `200` обычный успех · `201` create · `202` — не используется · `400` валидация тела · `404` project/file not found · `409` single-flight (already analyzing) · `413` request too large · `422` нарушение бизнес-лимитов · `500` внутренняя ошибка · `503` сервер перегружен (TTL GC не успевает).
- **Timestamps.** RFC 3339 UTC (`2026-04-18T12:34:56Z`).
- **Атомарность.** SSE-события имеют монотонный `seq` начиная с 1 per одно соединение.

---

## 1. `POST /api/projects` — загрузка проекта

Принимает ZIP, распаковывает, валидирует наличие `go.mod`, возвращает `project_id`. НЕ запускает анализ (см. §2).

### Request

```
POST /api/projects HTTP/1.1
Content-Type: multipart/form-data; boundary=…
Content-Length: ≤ 52_428_800
```

| Поле | Тип | Обязательно | Описание |
|---|---|---|---|
| `archive` | `file` | да | `.zip` с Go-проектом. `go.mod` — в корне архива или в первой подпапке (первый `go.mod` побеждает). |
| `name` | `string` | нет | Пользовательское имя проекта. По умолчанию — module name из `go.mod` или имя папки. |

### Response 201 Created

```json
{
  "project_id": "hs3NwQ1jZCEtj8pKmXKg9g",
  "name": "github.com/acme/example",
  "uploaded_at": "2026-04-18T12:34:56Z",
  "size_bytes": 1048576,
  "file_count": 142,
  "expires_at": "2026-04-18T13:04:56Z"
}
```

`expires_at` = `uploaded_at` + 30 min (NFR-10, TTL idle).

### Ошибки

| HTTP | code | когда |
|---|---|---|
| 400 | `invalid_zip` | битый ZIP или не-ZIP контент |
| 400 | `go_mod_missing` | в архиве нет `go.mod` |
| 400 | `zip_slip_detected` | путь в архиве содержит `..` или абсолютный |
| 413 | `archive_too_large` | > 50 МБ до распаковки (NFR-04) |
| 422 | `file_count_exceeded` | > 10 000 файлов в архиве |
| 422 | `unpacked_size_exceeded` | > 500 МБ распакованного (zip-bomb) |

### curl

```bash
curl -sSf -X POST http://localhost:8080/api/projects \
     -F archive=@./my-go-project.zip \
     -F name="my local go project"
```

---

## 2. `POST /api/projects/{id}/analyze` — запуск анализа (SSE)

Главный endpoint. Возвращает `text/event-stream`. Клиент открывает через `EventSource` либо через `fetch` + ручной парсинг.

EventSource не поддерживает POST-тело (MDN) — в варианте C мы принимаем POST с body (конфиг анализа) и сами перекладываем соединение на SSE. На клиенте используем `fetch()` с `ReadableStream` (есть polyfill через `@microsoft/fetch-event-source`), а не `EventSource`.

### Request

```
POST /api/projects/{id}/analyze HTTP/1.1
Accept: text/event-stream
Content-Type: application/json
```

Body — `EntryPointSpec` + `Filters`:

```json
{
  "entry_points": {
    "mode": "auto",
    "auto_kinds": ["main"],
    "manual": ["github.com/acme/example/api#Handler"],
    "interface_impl": ["github.com/acme/example/store#Store"]
  },
  "filters": {
    "include_kinds": ["package","struct","interface","func","method"],
    "exclude_paths": ["vendor/*","**/_examples/*"],
    "stdlib_exclude": true,
    "test_exclude": true
  }
}
```

Поля `entry_points` и `filters` оба опциональны. Дефолты (если body пустой):
- `mode: "auto"`, `auto_kinds: ["main"]`, `manual: []`, `interface_impl: []`
- `include_kinds: все 8`, `exclude_paths: []`, `stdlib_exclude: true`, `test_exclude: true`

### Response 200 OK (stream)

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Поток событий (формат `event: <type>\ndata: <json>\n\n`):

| event | data (пример) |
|---|---|
| `phase` | `{"seq":1,"phase":"loading","message":"unpacking sources"}` |
| `phase` | `{"seq":2,"phase":"parsing","progress":0.1}` |
| `phase` | `{"seq":3,"phase":"building_graph","progress":0.3}` |
| `partial_graph` | `{"seq":4,"nodes":[...50 nodes...],"edges":[...]}` |
| `partial_graph` | `{"seq":5,"nodes":[...],"edges":[...]}` |
| `phase` | `{"seq":6,"phase":"reachability","progress":0.85}` |
| `warning` | `{"seq":7,"code":"import_error","message":"package foo: cannot find module","package":"github.com/acme/example/foo"}` |
| `phase` | `{"seq":8,"phase":"exporting","progress":0.95}` |
| `done` | `{"seq":9,"phase":"done","node_count":1234,"edge_count":5678,"warnings_count":1,"elapsed_ms":8421,"graph_url":"/api/projects/<id>/graph"}` |

После `done` сервер закрывает соединение. При ошибке — шлётся `event: done, data: {phase:"failed", error:{...}}` и connection тоже закрывается.

Клиент обязан:
- читать все `partial_graph` и добавлять узлы инкрементально (FR-18, NFR-02);
- при получении `phase: done` делать `eventSource.close()`;
- при обрыве соединения (onerror) — не делать авто-reconnect, показать toast «analysis interrupted», дать кнопку «Re-run».

### Ошибки

| HTTP | code | когда |
|---|---|---|
| 400 | `invalid_entry_point` | manual entry point не резолвится (`pkg#Name` не найден) |
| 400 | `invalid_filters` | неизвестный kind в `include_kinds`/`exclude_kinds` |
| 404 | `project_not_found` | `project_id` не найден / TTL истёк |
| 409 | `analysis_in_progress` | для этого project_id уже идёт анализ (single-flight, ADR-10) |
| 500 | `internal` | panic внутри orchestrator — поймано `recover`, репортится и шлётся `done/failed` |

### curl (для отладки, нормальная работа — через браузер)

```bash
curl -N -X POST http://localhost:8080/api/projects/<id>/analyze \
     -H "Accept: text/event-stream" \
     -H "Content-Type: application/json" \
     -d '{"entry_points":{"mode":"auto"}}'
```

---

## 3. `GET /api/projects/{id}/graph` — финальный граф

Возвращает последний успешно посчитанный граф. Используется:
- клиентом на reload вкладки (restore через localStorage `project_id`);
- для отладки (через browser / curl);
- как fallback если клиент пропустил часть `partial_graph`.

### Request

```
GET /api/projects/{id}/graph HTTP/1.1
Accept: application/json
```

### Query параметры (опциональные)

| Параметр | Значение | Поведение |
|---|---|---|
| `aggregate` | `auto\|package\|none` | `auto` (default) — если nodes > 1000, вернуть package-aggregated; `package` — всегда aggregated; `none` — всегда детальный. FR-18. |
| `include_dead` | `true\|false` | default `true`. Если `false` — отфильтровать `Reachable==false` на сервере. |

### Response 200 OK

```json
{
  "project_id": "hs3NwQ1jZCEtj8pKmXKg9g",
  "generated_at": "2026-04-18T12:35:04Z",
  "aggregation": "none",
  "stats": {
    "node_count": 1234,
    "edge_count": 5678,
    "by_kind": {"package":42,"func":500,"method":300,"struct":200,"interface":30,"field":150,"var":12,"const":0},
    "dead_count": 89
  },
  "nodes": [
    {"id":"0a1b2c...","name":"Handler","kind":"struct","package":"github.com/acme/example/api","file":"api/handler.go","line":12,"exported":true,"reachable":true,"is_entry":false,"doc":"Handler implements http.Handler"}
  ],
  "edges": [
    {"id":"5e6f...","source":"0a1b2c...","target":"7d8e...","kind":"calls","weight":3}
  ],
  "warnings": [
    {"code":"import_error","message":"package foo: missing","package":"github.com/acme/example/foo"}
  ]
}
```

### Ошибки

| HTTP | code | когда |
|---|---|---|
| 404 | `project_not_found` | id не найден / TTL |
| 404 | `no_graph_yet` | проект загружен, но `/analyze` ни разу не вызывался |
| 503 | `stale_cache` | disk cache повреждён, запустить `/analyze` заново |

---

## 4. `GET /api/projects/{id}/dead-code` — отчёт о мёртвом коде

FR-20, FR-23, FR-24. Формат — по `Accept` или `?format=`:

### Request

```
GET /api/projects/{id}/dead-code?format=json HTTP/1.1
```

| `format` | Content-Type | Описание |
|---|---|---|
| `json` (default) | `application/json` | Структурированный |
| `txt` | `text/plain; charset=utf-8` | Строчный, FR-23 |

### Response 200 — JSON (FR-24)

```json
{
  "project_id": "hs3NwQ1jZCEtj8pKmXKg9g",
  "generated_at": "2026-04-18T12:35:04Z",
  "entries_count": 89,
  "entries": [
    {
      "kind": "method",
      "fqn": "github.com/acme/example/store.MongoStore.Close",
      "file": "store/mongo.go",
      "line": 128,
      "package": "github.com/acme/example/store",
      "name": "Close",
      "reason": "unreachable"
    }
  ]
}
```

### Response 200 — TXT (FR-23)

```
method github.com/acme/example/store.MongoStore.Close — store/mongo.go:128
func  github.com/acme/example/internal/util.DeprecatedHelper — internal/util/helper.go:42
```

Пустой отчёт:

```
no dead code detected
```

### Заголовки для download

При `?download=1` сервер добавляет `Content-Disposition: attachment; filename="<project>-dead-code.<ext>"`.

### Ошибки

| HTTP | code | когда |
|---|---|---|
| 404 | `project_not_found` | — |
| 404 | `no_graph_yet` | анализ не запущен |
| 400 | `invalid_format` | format не в {json, txt} |

---

## 5. `DELETE /api/projects/{id}` — ручное удаление

Удаляет project from memory + disk cache + sources dir. Идемпотентен.

### Request

```
DELETE /api/projects/{id} HTTP/1.1
```

### Response 204 No Content

Пустое тело.

### Ошибки

| HTTP | code | когда |
|---|---|---|
| 404 | `project_not_found` | уже удалён или не было |
| 409 | `analysis_in_progress` | нельзя удалить во время анализа; после `done` можно |

---

## 6. `GET /api/projects` — список активных (debug, не для UI)

Полезен для CLI-мониторинга и отладки.

### Response 200

```json
{
  "projects": [
    {
      "project_id": "hs3NwQ1jZCEtj8pKmXKg9g",
      "name": "github.com/acme/example",
      "uploaded_at": "2026-04-18T12:34:56Z",
      "last_access_at": "2026-04-18T12:40:12Z",
      "size_bytes": 1048576,
      "status": {"phase":"done", "node_count":1234}
    }
  ],
  "count": 1,
  "cache_bytes_total": 5242880
}
```

---

## 7. `GET /api/healthz` — health check

```
GET /api/healthz HTTP/1.1
```

### Response 200

```json
{"status":"ok","version":"1.0.0-rc1","uptime_sec":3600,"active_projects":1}
```

Никогда не возвращает 4xx/5xx (если процесс жив — ответ 200).

---

## 8. Сводная таблица endpoints

| Метод | Путь | Назначение | Покрываемые FR |
|---|---|---|---|
| `POST` | `/api/projects` | загрузить ZIP, валидировать, получить id | FR-01, FR-02, NFR-04, NFR-13, NFR-14 |
| `POST` | `/api/projects/{id}/analyze` | запустить анализ, получить SSE stream | FR-04..10, FR-19, NFR-01, NFR-02, NFR-08 |
| `GET` | `/api/projects/{id}/graph` | последний граф | FR-08, FR-11, FR-18 |
| `GET` | `/api/projects/{id}/dead-code` | отчёт (TXT/JSON) | FR-20, FR-23, FR-24 |
| `GET` | `/api/projects/{id}/expand?package=…` | раскрыть пакет в агрегированном режиме (nice-to-have) | FR-18 |
| `DELETE` | `/api/projects/{id}` | удалить проект | — |
| `GET` | `/api/projects` | список активных (debug) | — |
| `GET` | `/api/healthz` | health | — |

---

## 9. Версионирование и стабильность

- API v1 = MVP. Ломающие изменения — через новый префикс `/api/v2/` (до защиты не понадобится).
- SchemaVersion в disk cache — внутренняя деталь сервера, клиент её не видит.
- SSE event types — **open set**: клиент должен игнорировать неизвестные `event:` (forward compat).

---
