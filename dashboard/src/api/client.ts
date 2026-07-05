/**
 * Relay API client — lightweight fetch wrapper.
 * Token is passed explicitly to avoid stale closure issues with React state.
 */

const BASE = 'http://localhost:4000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

async function request(path: string, options: RequestInit = {}, token?: string): Promise<any> {
  const headers: AnyObj = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw Object.assign(new Error(body.error?.message ?? 'Request failed'), {
      status: res.status,
      code: body.error?.code ?? 'ERROR',
    });
  }

  if (res.status === 204) return undefined;
  return res.json();
}

export const api = {
  get:    (path: string, token?: string)                         => request(path, { method: 'GET' }, token),
  post:   (path: string, body: AnyObj, token?: string)          => request(path, { method: 'POST',  body: JSON.stringify(body) }, token),
  patch:  (path: string, body: AnyObj, token?: string)          => request(path, { method: 'PATCH', body: JSON.stringify(body) }, token),
  delete: (path: string, token?: string)                         => request(path, { method: 'DELETE' }, token),
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
