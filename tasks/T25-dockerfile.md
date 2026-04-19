# T25: Dockerfile multi-stage multi-arch + embed frontend

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (3.2 NFR-07)
- `docs/architecture.md` (ADR-04, §9 Deployment, §11 политика версий)

## Зависимости
- **T16 GET /graph + /dead-code** — backend API полностью готов.
- **T24 Export + aggregation** — фронтенд полностью готов.

## Цель
Собрать production Docker-образ multi-stage multi-arch: node stage → go stage → distroless runtime. Статика фронта копируется в `server/internal/web/dist/` и встраивается через `embed.FS`. Добавить `make docker-build` и `make docker-run`.

## Scope

### В scope
- `Dockerfile` (в корне репо):
  - Stage 1 `node:24-alpine` (Node 24 Active LTS; Node 20 EOL 2026-04-30) — `WORKDIR /web`, `COPY web/package.json web/package-lock.json`, `npm ci --ignore-scripts`, `COPY web/ .`, `npm run build` → `/web/dist/`.
  - Stage 2 `golang:1.26-alpine` — `WORKDIR /server`, `COPY server/go.mod go.sum`, `go mod download`, `COPY server/ .`, `COPY --from=stage1 /web/dist ./internal/web/dist`, `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/server ./cmd/server`.
  - Stage 3 `gcr.io/distroless/static-debian12:nonroot` — `COPY --from=stage2 /out/server /server`, `ENTRYPOINT ["/server"]`, `EXPOSE 8080`. Проверь на старте свежий default-тег distroless (github.com/GoogleContainerTools/distroless).
- `.dockerignore`:
  - `**/node_modules`, `**/dist`, `**/.git`, `.github/`, `tasks/`, `docs/`, `test-evidence/`, `coverage.out`, `server/bin/`, `web/e2e/`.
- `Makefile` расширить:
  - `docker-build` → `docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/$(GH_USER)/go-viz:$(VERSION) .`
  - `docker-run` → `docker run --rm -p 8080:8080 ghcr.io/$(GH_USER)/go-viz:$(VERSION)`
  - `docker-build-local` → без buildx, текущая arch, без push.
- Обновить корневой `README.md`: «Usage: `docker run -p 8080:8080 …` → open http://localhost:8080». Добавить бейдж CI.
- Smoke-тест в CI (опционально): `docker-build-local` + `docker run -d` + curl healthz → kill.
- Verify reproducibility: `build` дважды подряд → одинаковый bin hash (если `-trimpath` + pinned base images; proof of concept — note в README).

### Вне scope
- Push в GHCR из CI — вне MVP (ADR-04, NFR-05).
- Кэш-том volume конфигурация для prod — документация, не код.

## Технические детали
- Версии pinned: `node:24-alpine`, `golang:1.26-alpine`, `gcr.io/distroless/static-debian12:nonroot` (или debian13 если default на 2026-04-19+ после проверки). Исполнитель обязан свериться с последними тегами per architecture.md §11.
- `CGO_ENABLED=0` для statically linked bin → distroless static runs.
- `--platform linux/amd64,linux/arm64` через `docker buildx`. Убедиться, что `buildx` инсталл установлен.
- `embed.FS`: `//go:embed all:dist` в `server/internal/web/embed.go` (уже в T12); включает `.` hidden — здесь `all:` префикс важен.

## Acceptance criteria
- [ ] `docker build -t go-viz:dev .` успешно собирается локально.
- [ ] `docker run --rm -p 8080:8080 go-viz:dev` — открывается `http://localhost:8080`, landing виден.
- [ ] `docker buildx build --platform linux/amd64,linux/arm64 …` собирает оба (локально через `--load` только текущая arch).
- [ ] Размер образа ≤ 50 МБ (ориентир: ~15 МБ из ADR-04).
- [ ] Health: `curl localhost:8080/api/healthz` → 200.
- [ ] NFR-07: `docker info` на macOS ARM64 и на Linux amd64 — оба запускают.
- [ ] `.dockerignore` исключает node_modules/tasks/docs (не копируется в контекст).
- [ ] `version` baked via `-ldflags "-X main.version=..."`, `/api/healthz` возвращает эту версию.

## План тестирования

### Unit-тесты
- Не применимо (инфра).

### Integration-тесты
- Smoke: построенный контейнер + curl healthz + upload/analyze malый testdata (если есть ресурсы в CI, опционально).

### E2E / Browser-тесты
- В T26 — полный Playwright-прогон против Docker-контейнера.

## Definition of Done
- [ ] `docker build` и `docker run` работают локально.
- [ ] `docker buildx build` multi-arch собирает (проверено хотя бы через `--platform linux/amd64`).
- [ ] README обновлён с Usage.
- [ ] Коммиты `feat(docker): multi-stage multi-arch image`.
- [ ] PR, merge, `tasks/README.md` T25 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t25-dockerfile`
3. Сверь актуальные теги node/golang/distroless. Dockerfile + .dockerignore + Makefile targets. Локальный build. Тест run.
4. PR, merge.

## Out-of-band
- Если distroless `static-debian13` стал default — используй его. Задокументируй в PR description.
- Если final bundle > 50 МБ — проверь, что в `dist/` нет source-maps (`vite build` по умолчанию не генерит).
