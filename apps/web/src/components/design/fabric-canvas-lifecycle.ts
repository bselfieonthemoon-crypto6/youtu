export type DisposableFabricCanvas = {
  dispose(): Promise<unknown>;
};

/**
 * Serializes Fabric setup/teardown so React remounts can never leave two live
 * canvases behind. Fabric 7 dispose is asynchronous and must be awaited.
 */
export class FabricCanvasLifecycle {
  private active: DisposableFabricCanvas | null = null;
  private transition: Promise<void> = Promise.resolve();

  mount<T extends DisposableFabricCanvas>(
    create: () => T | Promise<T>,
  ): Promise<T> {
    let mounted!: T;
    const operation = this.transition.then(async () => {
      await this.disposeActive();
      mounted = await create();
      this.active = mounted;
    });
    this.transition = operation.catch(() => undefined);
    return operation.then(() => mounted);
  }

  unmount(canvas?: DisposableFabricCanvas): Promise<void> {
    const operation = this.transition.then(async () => {
      // A stale React cleanup may arrive after a replacement was mounted.
      // Replacement already disposed the old instance, so it is a no-op.
      if (canvas && this.active !== canvas) return;
      await this.disposeActive();
    });
    this.transition = operation.catch(() => undefined);
    return operation;
  }

  hasActiveCanvas() {
    return this.active !== null;
  }

  private async disposeActive() {
    const canvas = this.active;
    this.active = null;
    if (canvas) await canvas.dispose();
  }
}

export const fabricCanvasLifecycle = new FabricCanvasLifecycle();
