# Sorttie

Sorttie is a local-first Windows desktop application for finding, previewing,
organizing, and safely undoing changes to recently created files.

> Status: alpha. The repository is suitable for development and evaluation,
> but it is not a finished file manager. Back up important data before testing
> file operations.

## What works

- Explicitly connects one user-selected directory; no folder is scanned by default.
- Scans and watches first-level regular files without recursively entering folders.
- Classifies files into seven deterministic categories and shows real metadata.
- Provides bounded previews for supported images, video, audio, PDF, and text files.
- Supports favorites, list/card browsing, search, and multi-file review.
- Freezes organization plans in SQLite before performing same-volume moves.
- Runs per-file preflight checks, rejects changed identities and destination conflicts,
  records operation events, and supports reverse-order batch undo.
- Detects timeline references in user-selected Jianying draft roots and blocks current
  references before organization; backup-only evidence is treated as a warning.

## Experimental local AI

An optional Gemma classifier can be reached through a local Ollama instance. The
current experiment uses bounded file metadata and, for supported text files, a
limited text excerpt. It returns validated structured suggestions and has no file
operation authority. It is not yet the planned destination-library recommender and
the normal application flow does not depend on Ollama.

## Safety model

- Electron main owns filesystem and database access.
- The renderer receives a narrow, typed preload API and passes registered IDs rather
  than arbitrary paths for file actions.
- Organization uses a persisted plan, identity snapshot, preflight validation,
  conflict rejection, operation journal, and explicit undo checks.
- Cross-volume organization, overwrite, deletion, and automatic AI-controlled moves
  are not supported.
- Automated filesystem tests operate only on test-created temporary directories.

See [Trusted file operations](docs/architecture/TRUSTED_FILE_OPERATIONS.md) for the
operation model and invariants.

## Development

Requirements:

- Windows 10 or later
- Node.js 22 or later
- npm
- Optional: Ollama with `gemma4:e4b` or `gemma3:1b` for the experimental classifier

```powershell
cd apps/desktop
npm ci
npm start
```

On first launch, select a directory explicitly. Application configuration and the
SQLite database are stored in Electron's per-user `userData` directory, not in the
repository or watched directory.

## Verification

```powershell
cd apps/desktop
npm run typecheck
npm test
npm run test:ui
npm run build
```

Vitest and Playwright source tests are included. Generated reports, screenshots,
local databases, build output, and user files are intentionally excluded from this
public repository.

## License

No open-source license has been granted yet. The source is public for review and
portfolio purposes; all rights are reserved unless a license is added later.
