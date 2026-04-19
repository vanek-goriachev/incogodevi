# T18: Landing + Upload (drag-n-drop, recent projects)

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.1 FR-01, 2.6 FR-26, 3.4 NFR-11/12)
- `docs/api-contract.md` (§1 POST /api/projects — errors mapping)
- `docs/design.md` (§2 J1, §3.1 Landing wireframe, §7 состояния, §8 localStorage)

## Зависимости
- **T14 POST /api/projects** — бекенд готов.
- **T17 Frontend app shell** — ApiClient, Toasts, Router, localStorage.

## Цель
Реализовать Landing-экран: drop-zone + кнопка «browse» для выбора ZIP, список Recent projects (из localStorage), auto-переход на Analyzing view после успешной загрузки. Inline-ошибки на все error-код'ы из api-contract §1.

## Scope

### В scope
- `web/src/pages/Landing/Landing.tsx`:
  - Центральная drop-zone (design.md §3.1) с визуальными состояниями: idle / dragging / uploading / error.
  - Клик = открытие file picker (`<input type="file" accept=".zip">`).
  - drag-over anywhere на `document` активирует drop-zone (per interaction table).
  - Requirements-подпись под zone: «go.mod at archive root · ≤ 50 MB, ≤ 10 000 files».
  - `Recent projects` list (из localStorage `go-viz:recent-projects`, max 10):
    - колонки: name, relative time, `[Restore]`, `[Forget]`.
    - `Restore`: `GET /api/projects/{id}/graph` — если 200 → `navigate('main', {projectId})` + `useGraph(graph)`; если 404 → toast «project expired — please re-upload».
    - `Forget`: удалить все `go-viz:<id>:*` ключи + элемент из `recent-projects`.
- `web/src/pages/Landing/UploadFlow.tsx`:
  - Hook `useUpload()`:
    - validate file: .zip extension, size ≤ 50 MB (клиентская проверка, сервер — authoritative).
    - POST через ApiClient.uploadProject, показывает progress bar (из XHR onprogress).
    - on success: добавляет в `recent-projects`, navigate to `analyzing` с полученным `project_id`.
    - on error: inline message + toast (не редиректит). Mapping: `archive_too_large|go_mod_missing|zip_slip_detected|file_count_exceeded|unpacked_size_exceeded|invalid_zip` → human-readable english messages.
- `web/src/pages/Landing/Landing.module.css` (или CSS-file): стили согласно design.md §5 (typography, colors).
- `__tests__/Landing.test.tsx`:
  - Рендер drop-zone + requirements text.
  - Drag over → CSS-класс `dragging` применяется.
  - Клик на zone → file input opens (jsdom test: spy на `<input>.click()`).
  - Успешный upload (mock ApiClient) → `navigate('analyzing')` вызван с корректным id.
  - Каждая ошибка API → соответствующий inline-message и toast.
  - Recent projects list: add, restore, forget.

### Вне scope
- SSE/Analyzing view — **T19**.
- Graph-экран и панели — **T20+**.

## Технические детали
- Нативный drag-n-drop: `onDragEnter/Over/Leave/Drop` handlers на `<main>` + на `<label>` drop-zone. `e.preventDefault()` в dragover обязателен.
- Upload progress: `XMLHttpRequest.upload.onprogress` — fetch() не даёт; обернуть в ApiClient.
- Recent projects формат (design.md §8): `[{project_id, name, uploaded_at}]`, max 10, LIFO.
- Дата «2 h ago» — простой formatter (без moment/dayjs — bundle-bloat).
- Локализация: строго английский (NFR-12). Все строки — константы в `web/src/i18n/en.ts` (хотя формально NFR-12 запрещает i18n-слой — держим как обычные константы).

### UI visual requirements
- Normal: landing по wireframe §3.1.
- Loading: progress bar внутри drop-zone (0→100 %).
- Error: красная inline-строка + toast; drop-zone активна для повтора.
- Empty (recent projects): просто не рендерить секцию.
Цветовая/типографическая консистентность — из `tokens.css` (T17).

## Acceptance criteria
- [ ] FR-01 acceptance: drag-n-drop `.zip` принимается; отсутствие `go.mod` → HTTP 400 → inline message «archive is missing go.mod at root» (английский).
- [ ] NFR-11 acceptance: от открытия landing до видимого analyzing view — ≤ 3 действия пользователя (drop → ожидание → навигация автоматическая).
- [ ] File > 50 MB → клиентская проверка ломает upload до запроса (сообщение из FR mapping); альтернативно сервер отвечает 413.
- [ ] Recent projects persist между reload.
- [ ] `Restore` на expired project → toast, возврат на landing.

## План тестирования

### Unit-тесты
- vitest + RTL, per scenario выше.
- Coverage Landing ≥ 70 %.

### Integration-тесты
- Не применимо (backend замокан в unit-тестах).

### E2E / Browser-тесты (обязательно для UI)
Используем webapp-testing skill.
В `test-evidence/T18/`:
- Скриншоты: normal, dragging state, uploading state, error state, recent list.
- Лог: drop → upload success flow.

Сценарии:
- **J1**: backend запущен, UI на `http://localhost:5173`; drag-drop валидный тестовый ZIP из `web/e2e/fixtures/simple.zip` → analyzing-экран виден (пока заглушка из T19 или stub).
- **J2**: upload невалидного ZIP (без `go.mod`) → видно inline error «archive is missing go.mod».
- **J3**: reload → recent list содержит последний project.

## Definition of Done
- [ ] `npm run typecheck|lint|test|build` — зелёные.
- [ ] `test-evidence/T18/` создан и содержит артефакты.
- [ ] Коммиты `feat(web): landing + upload`.
- [ ] PR, merge, `tasks/README.md` T18 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t18-landing-upload`
3. Landing → useUpload → recent list → тесты + E2E smoke.
4. PR, merge.

## Out-of-band
- Если `XMLHttpRequest` не даёт точный progress на backed-by-proxy upload — задокументируй и покажи пользователю «Uploading…» без процентов как fallback.
