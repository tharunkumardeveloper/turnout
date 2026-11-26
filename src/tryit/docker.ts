// A small Docker Engine API client over the Unix socket, for "Try it with your app" (local only): pull an image, build
// one from a pasted Dockerfile or straight from a public git URL, and run containers on a private network. No Docker
// CLI needed in the image. Engine API reference: https://docs.docker.com/reference/api/engine/
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';

export type DockerOptions = { socketPath?: string; timeoutMs?: number };
type Line = { stream?: string; status?: string; error?: string; errorDetail?: { message?: string } };

export class DockerError extends Error {}

export function createDocker(o: DockerOptions = {}) {
  const socketPath = o.socketPath ?? '/var/run/docker.sock';

  // One request; a streamed answer (pull, build) is read line by line, each line a JSON object.
  function request(method: string, path: string, body?: Buffer | object | { file: string }, opts: { headers?: Record<string, string>; onLine?: (line: Line) => void; timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      // A file on disk (an uploaded project folder or image, possibly large) is streamed, never held in memory.
      const file = body && typeof body === 'object' && 'file' in body && !Buffer.isBuffer(body) ? (body as { file: string }).file : null;
      const payload = body === undefined || file ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string> = { ...(payload && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) };
      if (payload) headers['content-length'] = String(payload.length);
      if (file) headers['content-length'] = String(statSync(file).size);
      const req = http.request({ socketPath, method, path, headers, timeout: opts.timeoutMs ?? o.timeoutMs ?? 30_000 }, (res) => {
        let text = '';
        let pending = '';
        let streamError: string | null = null;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (!opts.onLine || (res.statusCode ?? 200) >= 400) return void (text += chunk);
          pending += chunk;
          let at;
          while ((at = pending.indexOf('\n')) >= 0) {
            const raw = pending.slice(0, at).trim();
            pending = pending.slice(at + 1);
            if (!raw) continue;
            try {
              const line = JSON.parse(raw) as Line;
              if (line.error) streamError = line.errorDetail?.message ?? line.error;
              opts.onLine(line);
            } catch {
              /* a partial line: ignored */
            }
          }
        });
        res.on('end', () => {
          if (streamError) return reject(new DockerError(streamError));
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* plain text */
          }
          if ((res.statusCode ?? 500) >= 400) {
            const message = (parsed as { message?: string } | null)?.message ?? String(parsed ?? res.statusMessage);
            return reject(Object.assign(new DockerError(message), { status: res.statusCode }));
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('timeout', () => req.destroy(new DockerError(`Docker didn't answer ${method} ${path} in time`)));
      req.on('error', reject);
      if (file) return void createReadStream(file).on('error', (e) => req.destroy(e)).pipe(req);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const q = (params: Record<string, string | undefined>) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString();
  const say = (onLog: ((l: string) => void) | undefined) => (line: Line) => {
    const t = (line.stream ?? line.status ?? '').trim();
    if (t) onLog?.(t);
  };

  return {
    ping: () => request('GET', '/_ping').then(() => true).catch(() => false),
    async pull(image: string, onLog?: (l: string) => void): Promise<void> {
      const [name, tag] = splitTag(image);
      await request('POST', `/images/create?${q({ fromImage: name, tag })}`, undefined, { onLine: say(onLog), timeoutMs: 15 * 60_000 });
    },
    /** Builds `tag` from a Dockerfile's text (no other files: COPY needs a git repo instead) or a public git URL. */
    async build(tag: string, from: { dockerfile: string } | { remote: string }, onLog?: (l: string) => void): Promise<void> {
      const common = { t: tag, rm: '1', forcerm: '1', memory: String(2 * 1024 ** 3) };
      if ('remote' in from) {
        await request('POST', `/build?${q({ ...common, remote: from.remote })}`, Buffer.alloc(0), { onLine: say(onLog), timeoutMs: 30 * 60_000 });
      } else {
        const tar = tarOne('Dockerfile', from.dockerfile);
        await request('POST', `/build?${q(common)}`, tar, { headers: { 'content-type': 'application/x-tar' }, onLine: say(onLog), timeoutMs: 30 * 60_000 });
      }
    },
    /** Builds `tag` from an uploaded project folder (a tar file), with the Dockerfile named inside it. */
    async buildFolder(tag: string, tarFile: string, dockerfile: string, onLog?: (l: string) => void): Promise<void> {
      await request('POST', `/build?${q({ t: tag, rm: '1', forcerm: '1', memory: String(2 * 1024 ** 3), dockerfile })}`, { file: tarFile }, { headers: { 'content-type': 'application/x-tar' }, onLine: say(onLog), timeoutMs: 30 * 60_000 });
    },
    /** Loads an uploaded image file (docker save output); answers the image's name (or its ID if it has none). */
    async load(tarFile: string, onLog?: (l: string) => void): Promise<string> {
      let loaded = '';
      await request('POST', '/images/load', { file: tarFile }, { headers: { 'content-type': 'application/x-tar' }, timeoutMs: 30 * 60_000, onLine: (line) => {
        const m = (line.stream ?? '').match(/Loaded image(?: ID)?: (\S+)/);
        if (m) loaded = m[1]!;
        say(onLog)(line);
      } });
      if (!loaded) throw new DockerError('Docker loaded the file but named no image in it. Make it with: docker save -o app.tar yourimage:tag');
      return loaded;
    },
    async imageExists(image: string): Promise<boolean> {
      return request('GET', `/images/${encodeURIComponent(image)}/json`).then(() => true).catch(() => false);
    },
    /** The first TCP port the image exposes (its EXPOSE line), or null. */
    async exposedPort(image: string): Promise<number | null> {
      const r = await request('GET', `/images/${encodeURIComponent(image)}/json`);
      const ports = Object.keys((r.body as { Config?: { ExposedPorts?: Record<string, unknown> } }).Config?.ExposedPorts ?? {});
      const tcp = ports.map((p) => p.split('/')).find(([, proto]) => !proto || proto === 'tcp');
      return tcp ? Number(tcp[0]) : null;
    },
    async ensureNetwork(name: string): Promise<void> {
      const exists = await request('GET', `/networks/${encodeURIComponent(name)}`).then(() => true).catch(() => false);
      if (!exists) await request('POST', '/networks/create', { Name: name, Labels: { 'turnout.tryit': '1' } });
    },
    async connect(network: string, container: string): Promise<void> {
      await request('POST', `/networks/${encodeURIComponent(network)}/connect`, { Container: container }).catch((error: DockerError & { status?: number }) => {
        if (!/already exists|already attached|endpoint with name/i.test(error.message)) throw error;
      });
    },
    async remove(name: string): Promise<void> {
      await request('DELETE', `/containers/${encodeURIComponent(name)}?force=1`).catch((error: DockerError & { status?: number }) => {
        if (error.status !== 404) throw error;
      });
    },
    async run(o: { name: string; image: string; network: string; aliases: string[]; env?: string[]; memoryMb?: number }): Promise<void> {
      await request('POST', `/containers/create?${q({ name: o.name })}`, {
        Image: o.image,
        Env: o.env ?? [],
        Labels: { 'turnout.tryit': '1' },
        // host.docker.internal: your machine (a database or service you run there), as in turnout compare.
        HostConfig: { NetworkMode: o.network, Memory: (o.memoryMb ?? 768) * 1024 * 1024, RestartPolicy: { Name: 'unless-stopped' }, ExtraHosts: ['host.docker.internal:host-gateway'] },
        NetworkingConfig: { EndpointsConfig: { [o.network]: { Aliases: o.aliases } } },
      });
      await request('POST', `/containers/${encodeURIComponent(o.name)}/start`);
    },
    async logs(name: string, tail = 20): Promise<string> {
      const r = await request('GET', `/containers/${encodeURIComponent(name)}/logs?${q({ stdout: '1', stderr: '1', tail: String(tail) })}`).catch(() => ({ body: '' }));
      // The log stream is multiplexed: an 8-byte header per frame. Keep the printable text.
      return String(r.body ?? '').replace(/[\x00-\x08\x0e-\x1f]/g, '').trim();
    },
  };
}

export type Docker = ReturnType<typeof createDocker>;

/** "nginx:1.27" → ["nginx", "1.27"]; "registry:5000/app" → ["registry:5000/app", "latest"]. */
export function splitTag(image: string): [string, string] {
  const at = image.lastIndexOf(':');
  return at > image.lastIndexOf('/') && at > 0 ? [image.slice(0, at), image.slice(at + 1)] : [image, 'latest'];
}

/** A tar archive holding one file (the build context for a lone Dockerfile). */
export function tarOne(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  const put = (text: string, at: number, len: number) => header.write(text.slice(0, len), at, len, 'ascii');
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  put(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
  put('        ', 148, 8); // checksum placeholder: spaces
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, pad, Buffer.alloc(1024, 0)]);
}
