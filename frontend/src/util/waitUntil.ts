export default async function waitUntil(conditionFn: () => unknown, wait = 100, timeout: number | null = null) {
  const startedAt = performance.now();
  while (!(await conditionFn())) {
    await new Promise((resolve) => setTimeout(resolve, wait));

    if (timeout && performance.now() - startedAt >= timeout) {
      throw new Error('waitUntil timed out');
    }
  }
}
