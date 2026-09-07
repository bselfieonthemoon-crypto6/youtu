import { expect, test } from "@playwright/test";

test("inline Fabric survives Excalidraw zoom, pointer edits, drops, switching and local reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/dev/inline-artboard");
  await expect(page.getByTestId("probe-ready")).toHaveText("ready");
  await page.getByRole("button", { name: "示例素材", exact: true }).click();
  const scene = async () =>
    JSON.parse(await page.getByTestId("probe-scene").innerText()) as Array<{
      id: string;
      type: string;
      x: number;
      y: number;
    }>;
  await expect.poll(async () => (await scene()).length).toBe(1);
  const before = await scene();
  const firstBounds = (await page.getByTestId("board-A").boundingBox())!;
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.getByRole("button", { name: "平移", exact: true }).click();
  await expect
    .poll(async () => (await page.getByTestId("board-A").boundingBox())!.width)
    .toBeGreaterThan(firstBounds.width);
  expect(await scene()).toEqual(before);

  const board = page.getByTestId("board-A");
  const bounds = (await board.boundingBox())!;
  const zoom = bounds.width / 640;
  // Actual Fabric hit testing and drag, not an imperative object update.
  const start = { x: before[0]!.x + 50, y: before[0]!.y + 40 };
  await page.mouse.move(bounds.x + start.x * zoom, bounds.y + start.y * zoom);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + (start.x + 40) * zoom,
    bounds.y + (start.y + 30) * zoom,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await scene())[0]!.x))
    .toBe(Math.round(before[0]!.x + 40));
  expect(Math.round((await scene())[0]!.y)).toBe(Math.round(before[0]!.y + 30));

  // Native HTML drag/drop from the shared drawer into a zoomed board.
  await page
    .getByRole("button", { name: "示例文字", exact: true })
    .dragTo(board, { targetPosition: { x: 220 * zoom, y: 240 * zoom } });
  await expect.poll(async () => (await scene()).length).toBe(2);
  const text = (await scene()).find((o) => o.type === "text")!;
  expect(text.x).toBeCloseTo(220, 0);
  expect(text.y).toBeCloseTo(240, 0);
  const a = await scene();
  await page.getByRole("button", { name: "画板 B", exact: true }).click();
  await expect(page.getByTestId("probe-ready")).toHaveText("ready");
  expect(await scene()).toEqual([]);
  await page.getByRole("button", { name: "示例文字", exact: true }).click();
  await expect.poll(async () => (await scene()).length).toBe(1);
  await page.getByRole("button", { name: "画板 A", exact: true }).click();
  await expect(page.getByTestId("probe-ready")).toHaveText("ready");
  expect(await scene()).toEqual(a);
  await page.getByRole("button", { name: "保存验证草稿", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("probe-ready")).toHaveText("ready");
  expect(await scene()).toEqual(a);
  await page.getByRole("button", { name: "保存验证草稿", exact: true }).click();
  expect(await scene()).toEqual(a);
  const reloadedBounds = (await board.boundingBox())!;
  await page.mouse.move(reloadedBounds.x + 300, reloadedBounds.y + 250);
  await page.mouse.wheel(0, -100);
  await expect
    .poll(async () => (await board.boundingBox())!.width)
    .toBeGreaterThan(reloadedBounds.width);
  expect(await scene()).toEqual(a);
  await page.getByRole("button", { name: "画板 B", exact: true }).click();
  await expect(page.getByTestId("probe-ready")).toHaveText("ready");
  expect((await scene()).length).toBe(1);
  await page.getByRole("button", { name: "画板 A", exact: true }).click();
  await expect(page.getByTestId("probe-ready")).toHaveText("ready");
  await page.screenshot({ path: "test-results/inline-artboard-probe.png" });
  expect(errors).toEqual([]);
});
