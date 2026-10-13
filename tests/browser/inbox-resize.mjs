import { expect } from "@playwright/test";

// Real grid geometry, pointer dragging and keyboard sizing cannot be proven in
// jsdom. Inbox covers shared input/bounds; Drafts covers cross-view retention.
export async function resizeInboxDetail(page, detail) {
  const handle = detail.getByRole("separator", {
    name: "Resize main and secondary panels",
  });
  await expect(handle).toBeVisible();
  const width = async () => (await detail.boundingBox()).width;
  const defaultWidth = await width();
  // Start at the 320px list boundary so the full keyboard/drag sequence has room.
  await handle.press("End");
  const initial = await width();
  const listWidth = async () =>
    detail.evaluate(
      (element) => element.previousElementSibling.getBoundingClientRect().width,
    );
  const grip = await handle.boundingBox();
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    // The default detail can already be at its maximum. Drag toward the detail
    // to make the list wider, proving movement without running into that limit.
    await page.mouse.move(x + 64, y);
    await expect.poll(width).toBeCloseTo(initial - 64, 0);
  } finally {
    await page.mouse.up();
  }
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-sidebar-resizing",
  );
  await handle.press("ArrowRight");
  await expect.poll(width).toBeCloseTo(initial - 80, 0);
  await handle.press("Shift+ArrowLeft");
  await expect.poll(width).toBeCloseTo(initial - 32, 0);
  // Over-dragging may widen the list up to an equal split, never beyond it.
  const halfWidth = await detail.evaluate(
    (element) => element.parentElement.clientWidth / 2,
  );
  for (const [offset, expected] of [
    [1000, halfWidth],
    [-1000, 320],
  ]) {
    const grip = await handle.boundingBox();
    const x = grip.x + grip.width / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x + offset, y);
      await expect.poll(listWidth).toBeCloseTo(expected, 0);
    } finally {
      await page.mouse.up();
    }
  }
  await handle.press("Home");
  await expect
    .poll(width)
    .toBeCloseTo(Number(await handle.getAttribute("aria-valuemin")), 0);
  await expect.poll(listWidth).toBeCloseTo(halfWidth, 0);
  await expect.poll(width).toBeCloseTo(await listWidth(), 0);
  await handle.press("End");
  await expect
    .poll(width)
    .toBeCloseTo(Number(await handle.getAttribute("aria-valuemax")), 0);
  await expect.poll(listWidth).toBeCloseTo(320, 0);
  await expect
    .poll(async () => Number(await handle.getAttribute("aria-valuenow")))
    .toBeCloseTo(await width(), 0);
  await handle.dblclick();
  await expect.poll(width).toBeCloseTo(defaultWidth, 0);
  await handle.press("End");
  await handle.press("ArrowRight");
  await expect.poll(width).toBeCloseTo(initial - 16, 0);
  return await width();
}
