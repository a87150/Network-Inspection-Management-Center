/* Minimal REST client: same-origin session auth, CSRF on writes, one error shape. */

export class ApiError extends Error {
    constructor(message, status, payload) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.payload = payload;
    }
}

export function csrfToken(doc = document) {
    const input = doc.querySelector('input[name="csrfmiddlewaretoken"]');
    if (input && input.value) return input.value;
    const match = (doc.cookie || '').match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

export function buildUrl(path, params, origin = window.location.origin) {
    const url = new URL(path, origin);
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value === '' || value === null || value === undefined) return;
            url.searchParams.set(key, value);
        });
    }
    return url;
}

async function readPayload(response) {
    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) return null;
    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

export async function apiRequest(path, options = {}) {
    const {method = 'GET', body, params, signal, origin} = options;
    const init = {
        method,
        credentials: 'same-origin',
        headers: {Accept: 'application/json'},
        signal,
    };
    if (method !== 'GET' && method !== 'HEAD') {
        init.headers['Content-Type'] = 'application/json';
        init.headers['X-CSRFToken'] = csrfToken();
        init.body = JSON.stringify(body ?? {});
    }
    const response = await fetch(buildUrl(path, params, origin), init);
    // 会话过期时页面视图回 302 → /login/，fetch 跟随后是一个 200 的 HTML。
    // 不识别出来，调用方拿到的是 null，接着在 payload.results 上抛 TypeError，
    // 用户看到的是 "Cannot read properties of null" 而不是让他重新登录。
    if (response.status === 401 || (response.redirected && /\/login\/?/.test(response.url))) {
        throw new ApiError('登录已失效，请重新登录', 401);
    }
    const payload = await readPayload(response);
    if (!response.ok) {
        // AI 模块用 error 字段，其余用 message，两边都认。
        const message = (payload && (payload.message || payload.error))
            || '请求失败（' + response.status + '）';
        throw new ApiError(message, response.status, payload);
    }
    if (payload === null && response.status !== 204
        && (response.headers.get('content-type') || '').includes('text/html')) {
        throw new ApiError('登录已失效，请重新登录', 401);
    }
    return payload;
}

export const api = {
    get: (path, params, signal) => apiRequest(path, {params, signal}),
    post: (path, body) => apiRequest(path, {method: 'POST', body}),
    delete: (path) => apiRequest(path, {method: 'DELETE'}),
};
