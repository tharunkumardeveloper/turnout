// Waits until a fake Flagsmith's recorded exposures and events stop changing: the proxy records them after the
// response has finished, so a fixed pause (20 ms) was sometimes too short on a busy machine and a test failed.
export async function settle(flags: { tracked: unknown[]; exposures?: unknown[] }, quietMs = 60, maxMs = 3000): Promise<void> {
  const count = () => `${flags.tracked.length}/${flags.exposures?.length ?? 0}`;
  let last = count();
  let quietSince = Date.now();
  for (const end = Date.now() + maxMs; Date.now() < end; ) {
    await new Promise((r) => setTimeout(r, 10));
    const now = count();
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) return;
  }
}
