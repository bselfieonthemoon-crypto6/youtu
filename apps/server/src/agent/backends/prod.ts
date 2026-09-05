import { resolve } from "node:path";
import {
  type AnyBackendProtocol,
  CompositeBackend,
  FilesystemBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";

import type { SyncBackendFactory } from "./index.js";

const DEFAULT_SKILLS_ROOT = "/opt/loomic/skills";

/**
 * Create a production backend without host shell access.
 *
 * 文件持久化（/workspace/、/memories/）走 StoreBackend (PostgresStore)，
 * 临时文件走 StateBackend，并随 LangGraph thread checkpoint 持久化。
 *
 * Routes:
 *   /workspace/        → StoreBackend (PostgresStore, per-project)
 *   /memories/         → StoreBackend (PostgresStore, per-project)
 *   /skills/           → FilesystemBackend (shared, read-only system skills)
 *   /workspace-skills/ → StoreBackend (user-installed workspace skills, optional)
 *   default            → StateBackend (no host filesystem or execute access)
 */
export function createProductionBackendFactory(
  canvasId: string,
  options?: {
    skillsRoot?: string;
    hasWorkspaceSkills?: boolean;
  },
): { factory: SyncBackendFactory } {
  const skillsRoot = resolve(options?.skillsRoot ?? DEFAULT_SKILLS_ROOT);

  const skillsBackend = new FilesystemBackend({ rootDir: skillsRoot, virtualMode: true });

  const factory: SyncBackendFactory = (stateAndStore) => {
    const routes: Record<string, AnyBackendProtocol> = {
      "/memories/": new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "memories"],
      }),
      "/workspace/": new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "workspace"],
      }),
      "/skills/": skillsBackend,
    };

    if (options?.hasWorkspaceSkills) {
      routes["/workspace-skills/"] = new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "workspace-skills"],
      });
    }

    return new CompositeBackend(new StateBackend(stateAndStore), routes);
  };

  return { factory };
}
