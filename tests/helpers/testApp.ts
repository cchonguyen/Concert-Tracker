// In-memory request dispatcher for integration tests.
//
// Sends one request straight into an Express app (or any `(req, res)` handler)
// without opening a socket, so tests pass in sandboxes that refuse loopback
// (`connect EPERM`). Express routing and error middleware run unchanged.
import { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';

export type DispatchOptions = {
  method?: string;
  /** Path and query, e.g. `/api/share?x=1`. */
  url: string;
  headers?: Record<string, string>;
  /** A string or Buffer is sent as is. Any other value is sent as JSON. */
  body?: unknown;
};

export type DispatchResponse = {
  status: number;
  /** Lowercase lookups; `getSetCookie()` lists repeated `set-cookie` values. */
  headers: Headers;
  /** The body decoded as UTF-8. */
  body: string;
  /** The raw body bytes. */
  buffer: Buffer;
  text(): string;
  json<T = any>(): T;
};

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

const TIMEOUT_MS = 10_000;

function encodeBody(body: unknown, headers: Record<string, string>): Buffer | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (!Object.keys(headers).includes('content-type')) headers['content-type'] = 'application/json';
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function dispatch(app: Handler, options: DispatchOptions): Promise<DispatchResponse> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host ??= '127.0.0.1';

  const payload = method === 'GET' || method === 'HEAD' ? undefined : encodeBody(options.body, headers);
  if (payload) headers['content-length'] = String(payload.length);

  // A stand-in socket. The request reads from it; the response writes to a sink.
  const socket = Object.assign(new PassThrough(), { remoteAddress: '127.0.0.1', encrypted: false });
  const sink = new PassThrough();
  sink.resume();

  const req = new IncomingMessage(socket as never);
  req.method = method;
  req.url = options.url;
  req.headers = headers;
  if (payload) req.push(payload);
  req.push(null);
  // A real request is complete once its body is in; body-parser uses this to skip a second parse.
  req.complete = true;

  const res = new ServerResponse(req);
  res.assignSocket(sink as never);

  // Capture what the app writes. Node's `end(chunk)` skips the public `write`, so both are wrapped.
  const chunks: Buffer[] = [];
  const collect = (chunk: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array));
  };
  const rawWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const rawEnd = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    collect(chunk);
    return rawWrite(chunk, ...rest);
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    collect(chunk);
    return rawEnd(chunk, ...rest);
  }) as typeof res.end;

  return new Promise<DispatchResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dispatch timed out: ${method} ${options.url}`)), TIMEOUT_MS);
    timer.unref();
    res.once('finish', () => {
      clearTimeout(timer);
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.getHeaders())) {
        for (const v of Array.isArray(value) ? value : [value]) {
          if (v !== undefined) responseHeaders.append(name, String(v));
        }
      }
      const buffer = Buffer.concat(chunks);
      const body = buffer.toString('utf8');
      resolve({
        status: res.statusCode,
        headers: responseHeaders,
        body,
        buffer,
        text: () => body,
        json: <T = any>() => JSON.parse(body) as T,
      });
    });
    try {
      const out = app(req, res);
      if (out instanceof Promise) out.catch(reject);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}
