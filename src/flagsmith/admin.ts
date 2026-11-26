// Thin client for Flagsmith's Admin (Management) API.
export type Auth = { token: string } | { apiKey: string };

export class FlagsmithApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(method: string, path: string, status: number, body: unknown) {
    super(`${method} ${path} → ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export class AdminClient {
  readonly root: string;
  auth: Auth | undefined;

  // apiUrl is the SDK-style URL, e.g. http://flagsmith:8000/api/v1/
  constructor(apiUrl: string, auth?: Auth) {
    this.root = apiUrl.replace(/\/api\/v1\/?$/, '');
    this.auth = auth;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  // Flagsmith returns some lists bare and some paginated as { results }.
  async list<T>(path: string): Promise<T[]> {
    const data = await this.get<T[] | { results: T[] }>(path);
    return Array.isArray(data) ? data : data.results;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.auth && 'token' in this.auth) headers.authorization = `Token ${this.auth.token}`;
    if (this.auth && 'apiKey' in this.auth) headers.authorization = `Api-Key ${this.auth.apiKey}`;

    const send = () =>
      fetch(`${this.root}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let res: Response;
    try {
      res = await send();
    } catch (error) {
      // A kept-alive socket the server closed while idle fails before any response. A read is safe to send again.
      if (method !== 'GET' || !isClosedSocket(error)) throw error;
      res = await send();
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON; keep the text
    }
    if (!res.ok) throw new FlagsmithApiError(method, path, res.status, parsed);
    return parsed as T;
  }
}

// fetch() reports a socket the server closed as "fetch failed" with the reason in its cause. Flagsmith's gunicorn
// closes idle connections after GUNICORN_KEEP_ALIVE seconds (2 by default); Node keeps idle sockets for 4.
export function isClosedSocket(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE';
}

// Shapes of the objects Turnover reads. Only the fields it uses.
export type Organisation = { id: number; name: string };
export type Project = { id: number; name: string; organisation: number };
export type Environment = { id: number; name: string; api_key: string; project: number };
export type MvOption = { id: number; key: string | null; string_value: string | null; default_percentage_allocation: number };
export type Feature = { id: number; name: string; initial_value: string | null; multivariate_options: MvOption[]; tags: number[] };
export type Metric = { id: number; name: string; aggregation: string; direction: string; definition: { event: string } };
export type Experiment = { id: number; name: string; status: string; feature: { id: number; name: string } }; // nested in lists
export type WarehouseConnection = { id: number; status: string; warehouse_type: string };
