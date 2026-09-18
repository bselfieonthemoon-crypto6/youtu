// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CanvasPage from "../src/app/canvas/page";

const {
  canvasApiMock,
  canvasEditorState,
  fetchCanvasMock,
  fetchProjectMock,
  navigationState,
  replaceMock,
} = vi.hoisted(() => ({
  canvasApiMock: {
    getAppState: vi.fn((): { selectedElementIds: Record<string, boolean> } => ({ selectedElementIds: {} })),
    getSceneElements: vi.fn((): Array<{ id: string }> => []),
    getSceneElementsIncludingDeleted: vi.fn(() => []),
    updateScene: vi.fn(),
  },
  canvasEditorState: {
    onCanvasRefreshRequest: null as null | (() => Promise<void>),
    onRequestCanvasSelection: null as null | ((canvasId: string) => { elementIds: string[] }),
  },
  fetchCanvasMock: vi.fn(),
  fetchProjectMock: vi.fn(),
  navigationState: { canvasId: "canvas-a" },
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(`id=${navigationState.canvasId}`),
}));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: { access_token: "token" },
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchCanvas: fetchCanvasMock,
  fetchProject: fetchProjectMock,
  ApiAuthError: class ApiAuthError extends Error {},
}));

vi.mock("../src/hooks/use-websocket", () => ({
  useWebSocket: () => ({ connected: false }),
}));

vi.mock("../src/hooks/use-job-fallback-polling", () => ({
  useJobFallbackPolling: () => ({ checkForTimedOutJobs: vi.fn() }),
}));

vi.mock("../src/lib/canvas-elements", () => ({
  insertImageOnCanvas: vi.fn(),
  insertVideoOnCanvas: vi.fn(),
}));

vi.mock("../src/lib/canvas-element-merge", () => ({
  mergeCanvasElements: vi.fn(),
}));

vi.mock("../src/components/loading-screen", () => ({
  LoadingScreen: () => <div>loading</div>,
}));

vi.mock("../src/components/canvas-editor", () => ({
  CanvasEditor: (props: {
    canvasId: string;
    projectId: string;
    onApiReady: (api: typeof canvasApiMock) => void;
    onCanvasRefreshRequest: () => Promise<void>;
  }) => {
    canvasEditorState.onCanvasRefreshRequest = props.onCanvasRefreshRequest;
    return (
      <button
        type="button"
        data-testid="canvas-editor"
        onClick={() => props.onApiReady(canvasApiMock)}
      >
        {props.canvasId}:{props.projectId}
      </button>
    );
  },
}));

vi.mock("../src/components/editable-project-name", () => ({
  EditableProjectName: (props: { initialName: string }) => (
    <div data-testid="project-name">{props.initialName}</div>
  ),
}));

vi.mock("../src/components/brand-kit-selector", () => ({
  BrandKitSelector: (props: { currentBrandKitId: string | null }) => (
    <div data-testid="brand-kit">{props.currentBrandKitId ?? "none"}</div>
  ),
}));

vi.mock("../src/components/chat-sidebar", () => ({
  ChatSidebar: (props: {onOpenDesign: (id: string) => void; onSessionChange: (id: string) => void; activeDesignId?: string; beforeDesignSend?: () => Promise<void>; onRequestCanvasSelection: (canvasId: string) => { elementIds: string[] }}) => {
    canvasEditorState.onRequestCanvasSelection = props.onRequestCanvasSelection;
    return (
    <div>
      <button onClick={() => props.onOpenDesign("design-a")}>open design</button>
      <button onClick={() => props.onSessionChange("session-new")}>change session</button>
      <div data-testid="agent-design">{props.activeDesignId}:{typeof props.beforeDesignSend}</div>
    </div>
    );
  },
}));
vi.mock("../src/components/canvas-empty-hint", () => ({
  CanvasEmptyHint: () => null,
}));
vi.mock("../src/components/canvas-logo-menu", () => ({
  CanvasLogoMenu: () => null,
}));
vi.mock("../src/components/canvas-bottom-bar", () => ({
  CanvasBottomBar: () => null,
}));
vi.mock("../src/components/canvas-files-panel", () => ({
  CanvasFilesPanel: () => null,
}));
vi.mock("../src/components/canvas-layers-panel", () => ({
  CanvasLayersPanel: () => null,
}));
vi.mock("../src/components/credits/credit-header-button", () => ({
  CreditHeaderButton: () => null,
}));
vi.mock("../src/components/design/design-editor-session", () => ({
  DesignEditorSession: (props: {inline: boolean}) => <div data-testid="design-mode">{props.inline ? "inline" : "overlay"}</div>,
}));

type CanvasResponse = ReturnType<typeof canvasResponse>;
type ProjectResponse = ReturnType<typeof projectResponse>;

function canvasResponse(
  canvasId: string,
  projectId: string,
): {
  canvas: {
    id: string;
    name: string;
    projectId: string;
    revision: number;
    content: {
      elements: Record<string, unknown>[];
      appState: Record<string, unknown>;
      files: Record<string, Record<string, unknown>>;
    };
  };
} {
  return {
    canvas: {
      id: canvasId,
      name: canvasId,
      projectId,
      revision: 1,
      content: { elements: [], appState: {}, files: {} },
    },
  };
}

function projectResponse(name: string, brandKitId: string) {
  return {
    project: {
      name,
      brand_kit_id: brandKitId,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("canvas page loading", () => {
  beforeEach(() => {
    navigationState.canvasId = "canvas-a";
    fetchCanvasMock.mockReset();
    fetchProjectMock.mockReset();
    replaceMock.mockReset();
    canvasApiMock.getAppState.mockReset().mockReturnValue({ selectedElementIds: {} });
    canvasApiMock.getSceneElements.mockReset().mockReturnValue([]);
    canvasApiMock.getSceneElementsIncludingDeleted.mockClear();
    canvasApiMock.updateScene.mockClear();
    canvasEditorState.onCanvasRefreshRequest = null;
    canvasEditorState.onRequestCanvasSelection = null;
  });

  afterEach(() => cleanup());

  it("binds the send-time reader to the current canvas API and rejects previous-canvas selections", async () => {
    fetchCanvasMock.mockImplementation(async (_token: string, canvasId: string) => canvasResponse(canvasId, `project-${canvasId}`));
    fetchProjectMock.mockResolvedValue(projectResponse("Project", "kit"));
    const { rerender } = render(<CanvasPage />);
    const editorA = await screen.findByTestId("canvas-editor");
    const readSelection = canvasEditorState.onRequestCanvasSelection!;
    expect(readSelection("canvas-a")).toEqual({ elementIds: [] });
    canvasApiMock.getAppState.mockReturnValue({ selectedElementIds: { "text-a": true, "foreign-text": true } });
    canvasApiMock.getSceneElements.mockReturnValue([{ id: "text-a" }]);
    fireEvent.click(editorA);
    expect(readSelection("canvas-a")).toEqual({ elementIds: ["text-a"] });
    expect(readSelection("canvas-b")).toEqual({ elementIds: [] });

    navigationState.canvasId = "canvas-b";
    rerender(<CanvasPage />);
    await waitFor(() => expect(screen.getByTestId("canvas-editor")).toHaveTextContent("canvas-b:"));
    // The B editor is mounted but has not provided its API; A's scene must not leak.
    expect(readSelection("canvas-b")).toEqual({ elementIds: [] });
    expect(readSelection("canvas-a")).toEqual({ elementIds: [] });
    canvasApiMock.getAppState.mockReturnValue({ selectedElementIds: { "text-b": true } });
    canvasApiMock.getSceneElements.mockReturnValue([{ id: "text-b" }]);
    fireEvent.click(screen.getByTestId("canvas-editor"));
    expect(readSelection("canvas-b")).toEqual({ elementIds: ["text-b"] });
  });

  it("opens the inline artboard and binds Agent context without a URL flag", async () => {
    fetchCanvasMock.mockResolvedValue(canvasResponse("canvas-a", "project-a"));
    fetchProjectMock.mockResolvedValue(projectResponse("Project A", "kit-a"));
    render(<CanvasPage />);
    fireEvent.click(await screen.findByText("open design"));
    expect(await screen.findByTestId("design-mode")).toHaveTextContent("inline");
    expect(screen.getByTestId("agent-design")).toHaveTextContent("design-a:function");
    fireEvent.click(screen.getByText("change session"));
    expect(replaceMock).toHaveBeenLastCalledWith("/canvas?id=canvas-a&session=session-new");
  });

  it("ignores an older canvas response after the canvas id changes", async () => {
    const canvasA = deferred<CanvasResponse>();
    const canvasB = deferred<CanvasResponse>();
    fetchCanvasMock.mockImplementation((_token: string, canvasId: string) =>
      canvasId === "canvas-a" ? canvasA.promise : canvasB.promise,
    );
    fetchProjectMock.mockResolvedValue(projectResponse("Project B", "kit-b"));

    const { rerender } = render(<CanvasPage />);
    await waitFor(() =>
      expect(fetchCanvasMock).toHaveBeenCalledWith("token", "canvas-a"),
    );

    navigationState.canvasId = "canvas-b";
    rerender(<CanvasPage />);
    await waitFor(() =>
      expect(fetchCanvasMock).toHaveBeenCalledWith("token", "canvas-b"),
    );

    await act(async () => {
      canvasB.resolve(canvasResponse("canvas-b", "project-b"));
    });
    expect(await screen.findByTestId("canvas-editor")).toHaveTextContent(
      "canvas-b:project-b",
    );

    await act(async () => {
      canvasA.resolve(canvasResponse("canvas-a", "project-a"));
    });
    expect(screen.getByTestId("canvas-editor")).toHaveTextContent(
      "canvas-b:project-b",
    );
    expect(fetchProjectMock).not.toHaveBeenCalledWith("token", "project-a");
  });

  it("ignores stale project and brand-kit data from the previous canvas", async () => {
    const projectA = deferred<ProjectResponse>();
    fetchCanvasMock.mockImplementation(
      async (_token: string, canvasId: string) =>
        canvasId === "canvas-a"
          ? canvasResponse("canvas-a", "project-a")
          : canvasResponse("canvas-b", "project-b"),
    );
    fetchProjectMock.mockImplementation((_token: string, projectId: string) =>
      projectId === "project-a"
        ? projectA.promise
        : Promise.resolve(projectResponse("Project B", "kit-b")),
    );

    const { rerender } = render(<CanvasPage />);
    await waitFor(() =>
      expect(fetchProjectMock).toHaveBeenCalledWith("token", "project-a"),
    );

    navigationState.canvasId = "canvas-b";
    rerender(<CanvasPage />);
    expect(await screen.findByTestId("project-name")).toHaveTextContent(
      "Project B",
    );
    expect(screen.getByTestId("brand-kit")).toHaveTextContent("kit-b");

    await act(async () => {
      projectA.resolve(projectResponse("Project A", "kit-a"));
    });
    expect(screen.getByTestId("project-name")).toHaveTextContent("Project B");
    expect(screen.getByTestId("brand-kit")).toHaveTextContent("kit-b");
  });

  it("clears the previous canvas error when a new canvas starts loading", async () => {
    const canvasB = deferred<CanvasResponse>();
    fetchCanvasMock
      .mockRejectedValueOnce(new Error("canvas A failed"))
      .mockReturnValueOnce(canvasB.promise);
    fetchProjectMock.mockResolvedValue(projectResponse("Project B", "kit-b"));

    const { rerender } = render(<CanvasPage />);
    expect(
      await screen.findByText("Failed to load canvas."),
    ).toBeInTheDocument();

    navigationState.canvasId = "canvas-b";
    rerender(<CanvasPage />);
    expect(await screen.findByText("loading")).toBeInTheDocument();
    expect(
      screen.queryByText("Failed to load canvas."),
    ).not.toBeInTheDocument();

    await act(async () => {
      canvasB.resolve(canvasResponse("canvas-b", "project-b"));
    });
    expect(await screen.findByTestId("canvas-editor")).toHaveTextContent(
      "canvas-b:project-b",
    );
  });

  it("ignores an in-flight sync from the previous canvas", async () => {
    const staleSync = deferred<CanvasResponse>();
    let canvasAFetches = 0;
    fetchCanvasMock.mockImplementation(
      (_token: string, requestedCanvasId: string) => {
        if (requestedCanvasId === "canvas-a") {
          canvasAFetches += 1;
          return canvasAFetches === 1
            ? Promise.resolve(canvasResponse("canvas-a", "project-a"))
            : staleSync.promise;
        }
        return Promise.resolve(canvasResponse("canvas-b", "project-b"));
      },
    );
    fetchProjectMock.mockImplementation(
      async (_token: string, projectId: string) =>
        projectResponse(
          projectId === "project-a" ? "Project A" : "Project B",
          projectId === "project-a" ? "kit-a" : "kit-b",
        ),
    );

    const { rerender } = render(<CanvasPage />);
    const editor = await screen.findByTestId("canvas-editor");
    fireEvent.click(editor);
    const oldCanvasSync = canvasEditorState.onCanvasRefreshRequest;
    expect(oldCanvasSync).not.toBeNull();
    const oldSyncPromise = oldCanvasSync?.();
    await waitFor(() => expect(canvasAFetches).toBe(2));

    navigationState.canvasId = "canvas-b";
    rerender(<CanvasPage />);
    expect(await screen.findByTestId("canvas-editor")).toHaveTextContent(
      "canvas-b:project-b",
    );

    await act(async () => {
      staleSync.resolve({
        canvas: {
          ...canvasResponse("canvas-a", "project-a").canvas,
          revision: 2,
          content: {
            elements: [{ id: "old-a-element" }],
            appState: {},
            files: { "old-a-file": { id: "old-a-file" } },
          },
        },
      });
      await oldSyncPromise;
    });

    expect(canvasApiMock.updateScene).not.toHaveBeenCalled();
    expect(screen.getByTestId("canvas-editor")).toHaveTextContent(
      "canvas-b:project-b",
    );
  });
});
