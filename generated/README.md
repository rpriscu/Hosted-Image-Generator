# `generated/`

This directory is the **public image bucket**. The service commits generated
images here so a network-restricted agent can fetch them from
`raw.githubusercontent.com` with no auth token.

- Path convention: `generated/{YYYY-MM-DD}/{uuid}.png`
- `generated/poc/` holds the proof-of-concept placeholder image used to validate
  the fetch path before fal.ai is wired up.
- Files here are **disposable** and pruned automatically by
  `.github/workflows/prune.yml` after the retention window.

Do not hand-edit files here; they are machine-generated.
