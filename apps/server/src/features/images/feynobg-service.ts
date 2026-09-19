import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type FeynobgMode =
  | "remove_background"
  | "region_matting"
  | "erase_transparent"
  | "smart_erase";
export type FeynobgSelectionRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type FeynobgSelectionPoint = { x: number; y: number; label: 0 | 1 };
export type FeynobgLayer = {
  kind: "foreground" | "background" | "element";
  buffer: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
  index?: number;
};
export type FeynobgResult = {
  model?: string;
  width: number;
  height: number;
  layers: FeynobgLayer[];
};

type WorkerResponse = {
  model?: string;
  id: string;
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  files?: Array<{
    kind: FeynobgLayer["kind"];
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    index?: number;
  }>;
};

type Pending = {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultModelDir = resolve(moduleDir, "../../../../../models/feynobg");
const defaultLamaModel = resolve(
  moduleDir,
  "../../../../../models/lama/lama_fp32.onnx",
);
const defaultSamModelDir = resolve(
  moduleDir,
  "../../../../../models/sam2.1-hiera-tiny",
);
const workerScript = resolve(moduleDir, "../../../scripts/feynobg_worker.py");

export function resolveFeynobgCpuThreads(
  configured = process.env.LOOMIC_FEYNOBG_CPU_THREADS,
  platform = process.platform,
): number {
  const parsed = Number.parseInt(configured?.trim() ?? "", 10);
  if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 32)
    return parsed;
  // Large OpenMP pools materially increase the peak commit charge of the
  // 1 GiB BiRefNet checkpoint on Windows. Two inference threads keep the
  // local worker responsive without competing with the web/dev processes.
  return platform === "win32" ? 2 : 8;
}

export function describeFeynobgWorkerExit(
  code: number | null,
  platform = process.platform,
): string {
  const unsignedCode = code === null ? null : code >>> 0;
  if (platform === "win32" && unsignedCode === 0xc0000005) {
    return (
      "FeyNoBG native runtime crashed (0xC0000005). " +
      "This is commonly caused by Windows native ML runtime memory pressure; " +
      "free memory and retry, or run the worker in the Linux container."
    );
  }
  return `FeyNoBG worker exited unexpectedly (${code ?? "unknown"}).`;
}

class PersistentFeynobgWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();

  async process(
    buffer: Buffer,
    mode: FeynobgMode,
    selectionRegion?: FeynobgSelectionRegion,
    maskBuffer?: Buffer,
    selectionPoints?: FeynobgSelectionPoint[],
  ): Promise<FeynobgResult> {
    const taskDir = await mkdtemp(join(tmpdir(), "loomic-feynobg-"));
    const inputPath = join(taskDir, "input-image");
    const outputDir = join(taskDir, "output");
    await writeFile(inputPath, buffer);
    const maskPath = maskBuffer ? join(taskDir, "erase-mask.png") : undefined;
    if (maskPath && maskBuffer) await writeFile(maskPath, maskBuffer);
    try {
      const response = await this.request({
        input_path: inputPath,
        output_dir: outputDir,
        mode,
        ...(selectionRegion ? { selection_region: selectionRegion } : {}),
        ...(selectionPoints ? { selection_points: selectionPoints } : {}),
        ...(maskPath ? { mask_path: maskPath } : {}),
      });
      if (!response.ok)
        throw new Error(response.error || "FeyNoBG inference failed.");
      if (!response.width || !response.height || !response.files?.length) {
        throw new Error("FeyNoBG returned an incomplete result.");
      }
      const layers = await Promise.all(
        response.files.map(async (file) => {
          const path = resolve(outputDir, file.name);
          const traversal = relative(outputDir, path);
          if (traversal.startsWith("..") || isAbsolute(traversal)) {
            throw new Error("FeyNoBG returned an invalid output path.");
          }
          return { ...file, buffer: await readFile(path) };
        }),
      );
      return { width: response.width, height: response.height, layers, ...(response.model ? { model: response.model } : {}) };
    } finally {
      await rm(taskDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const python =
      process.env.LOOMIC_PYTHON_BIN?.trim() ||
      (process.platform === "win32" ? "python" : "python3");
    const modelDir = resolve(
      process.env.LOOMIC_FEYNOBG_MODEL_DIR?.trim() || defaultModelDir,
    );
    const lamaModel = resolve(
      process.env.LOOMIC_LAMA_MODEL_PATH?.trim() || defaultLamaModel,
    );
    const samModelDir = resolve(
      process.env.LOOMIC_SAM2_MODEL_DIR?.trim() || defaultSamModelDir,
    );
    const cpuThreads = resolveFeynobgCpuThreads();
    const child = spawn(
      python,
      [
        workerScript,
        "--serve",
        "--model-dir",
        modelDir,
        "--lama-model",
        lamaModel,
        "--sam-model-dir",
        samModelDir,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          LOOMIC_FEYNOBG_CPU_THREADS: String(cpuThreads),
          OMP_NUM_THREADS:
            process.env.OMP_NUM_THREADS?.trim() || String(cpuThreads),
          MKL_NUM_THREADS:
            process.env.MKL_NUM_THREADS?.trim() || String(cpuThreads),
        },
      },
    );
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let response: WorkerResponse;
      try {
        response = JSON.parse(line) as WorkerResponse;
      } catch {
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    });
    child.stderr.on("data", (chunk) =>
      console.warn(`[feynobg] ${String(chunk).trimEnd()}`),
    );
    child.once("error", (error) => this.rejectAll(error));
    child.once("exit", (code) => {
      this.child = null;
      this.rejectAll(new Error(describeFeynobgWorkerExit(code)));
    });
    return child;
  }

  private request(payload: {
    input_path: string;
    output_dir: string;
    mode: FeynobgMode;
    selection_region?: FeynobgSelectionRegion;
    selection_points?: FeynobgSelectionPoint[];
    mask_path?: string;
  }): Promise<WorkerResponse> {
    const id = randomUUID();
    const child = this.ensureStarted();
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error("FeyNoBG processing timed out."));
      }, 10 * 60_000);
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error);
      });
    });
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const singleton = new PersistentFeynobgWorker();

export function processWithFeynobg(
  buffer: Buffer,
  mode: FeynobgMode,
  selectionRegion?: FeynobgSelectionRegion,
  maskBuffer?: Buffer,
  selectionPoints?: FeynobgSelectionPoint[],
): Promise<FeynobgResult> {
  return singleton.process(buffer, mode, selectionRegion, maskBuffer, selectionPoints);
}
