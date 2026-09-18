# Layer deletion persistence fix

Root cause: removeSelection removed the Fabric object before recording history.
Its inverse object.add copied the prior objectVersion (e.g. 7), but object.add
requires version 1. History validation threw, preventing persistence and layer
list updates while leaving the visual object removed.

Fix: recreation inverse uses version 1. Multi-selection deletion emits one
history batch. If recording fails, runtime objects, stacking order and selection
are restored and the editor surfaces an error.

Verification:
- Fabric editor tests: 20 passed, including edited multi-delete and rollback.
- Command history tests: 15 passed, including remove(version 7), undo(add version
  1), redo(remove current version 1).
- Web TypeScript and production build passed.
- Real browser on production build .next-production-layer-delete: right-side
  trash, save, undo, redo, finish, reload and reopen all passed. Database layer
  presence checked after each saved transition. No model calls.
- Isolated QA design: 7317e0ed-f7a2-4cef-a49e-e2603cf540c4.
- Screenshot: artifacts/native-board-creation/deletion-reopen.png.
- Original user document was only read, not modified by the test.
