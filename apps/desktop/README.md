# Sorttie desktop client

The Electron + React client connects one explicitly selected local directory to
Sorttie's recent-file activity and reviewed organization workflows. It scans and
watches first-level regular files, previews supported content, and can perform
validated same-volume moves from frozen plans with explicit undo support.

```powershell
cd apps\desktop
npm ci
npm start
```

On first launch, choose a directory explicitly. The selection is stored under
Electron's per-user `userData` directory and restored on the next launch. No
default Downloads, Desktop, or home-directory scan is performed.

Verification:

```powershell
npm run typecheck
npm test
npm run test:ui
npm run build
```

`test:ui` launches the real Electron application against test-created temporary
directories and checks the main/preload/renderer chain and responsive geometry.
Generated screenshots and reports are ignored by Git.

The renderer has no Node.js filesystem access. Directory scanning, watching,
configuration persistence, bounded preview reads, organization, and undo remain in
the Electron main process behind the typed preload API.
