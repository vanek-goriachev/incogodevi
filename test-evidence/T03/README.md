# T03 — CI test evidence

## Successful CI run on branch `ci/t03-github-actions`

- Run id: `24626591880`
- URL: https://github.com/vanek-goriachev/incogodevi/actions/runs/24626591880
- Head SHA: see `run-24626591880-summary.json`
- Status: completed / success
- Wall clock: ~38s end-to-end (well under the 5-minute NFR budget).

### Job conclusions

| Job | Conclusion | Duration |
|-----|-----------|----------|
| backend (ubuntu-latest / go 1.25) | success | 11s |
| backend (ubuntu-latest / go 1.26) | success | 25s |
| backend (macos-latest / go 1.25) | success | 27s |
| backend (macos-latest / go 1.26) | success | 25s |
| frontend (node 24) | success | 24s |
| status | success | 4s |

The `status` job is the single aggregate gate to mark as required in branch
protection on `main`.

## Files in this directory

- `run-24626591880-summary.json` — full `gh run view --json` payload for the
  successful run (status, conclusion, per-job timings, URL, head SHA).
- `run-24626591880-full.log` — captured `gh run view --log` of every job step.
