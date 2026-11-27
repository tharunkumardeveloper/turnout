// Waits for a service to answer before starting. After a server reboot Docker starts every container at once, and
// Flagsmith takes about half a minute to accept connections; a console that exits on its first "fetch failed" is
// only brought back by the restart policy, again and again (6 restarts after a reboot of the live demo, 27 Nov 2026).

/** Resolves once `url` answers with any HTTP status (a 401 or 404 still means it's up); throws after `timeoutMs`. */
export async function waitForHttp(
  url: string,
  opts: { timeoutMs?: number; everyMs?: number; log?: (line: string) => void; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<number> {
  const { timeoutMs = 180_000, everyMs = 2_000, log = () => {} } = opts;
  const get = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  let tries = 0;
  let said = false;
  for (;;) {
    tries++;
    try {
      const res = await get(url, { signal: AbortSignal.timeout(Math.max(1000, everyMs)) });
      await res.body?.cancel();
      if (said) log(`Flagsmith answers (after ${Math.round((now() - started) / 1000)} s).`);
      return tries;
    } catch (error) {
      const e = error as Error & { cause?: { code?: string } };
      if (now() - started >= timeoutMs) throw new Error(`${url} didn't answer within ${Math.round(timeoutMs / 1000)} s (${e.cause?.code ?? e.message})`);
      if (!said) log(`Waiting for Flagsmith at ${new URL(url).origin} (${e.cause?.code ?? e.message})…`);
      said = true;
      await sleep(everyMs);
    }
  }
}
