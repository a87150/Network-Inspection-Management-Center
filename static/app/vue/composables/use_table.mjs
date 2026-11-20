/* 工作区表格的共用规则：初始状态、地址栏写法、单元格取值。
   具体请求逻辑留在 component 里，这里只放会被多处调用的纯函数，避免双重抽象。 */
import { api } from '../api.mjs';

/** 从 props 和地址栏取初始状态。 */
export function tableData(props) {
    return {
        items: props.rows || [],
        total: props.count || 0,
        currentPage: props.page || 1,
        totalPages: props.pages || 1,
        pageSize: props.page_size || 20,
        from: props.start_index || 0,
        to: props.end_index || 0,
        jumpPage: props.page || 1,
        loading: false,
        error: '',
        sortKey: props.sort || '',
        sortOrder: props.order || 'asc',
        draftFilters: {...(props.filters || {})},
    };
}

/** 地址栏只留真正有值的参数：第 1 页、默认条数、空筛选一律不写。 */
export function syncUrl(changes, { pageSize = 20, prefix = '' } = {}) {
    if (!window.history.replaceState) return;
    const params = new URLSearchParams(window.location.search);
    const name = (key) => (prefix ? prefix + '_' + key : key);
    Object.keys(changes).forEach((key) => {
        const value = changes[key];
        const blank = value === null || value === undefined || String(value).trim() === '';
        const isDefault = (key === 'page' && Number(value) <= 1)
            || (key === 'page_size' && Number(value) === pageSize);
        if (blank || isDefault) {
            params.delete(name(key));
        } else {
            params.set(name(key), String(value));
        }
    });
    const kept = Array.from(params.entries()).filter(([, value]) => String(value).trim() !== '');
    const search = new URLSearchParams(kept).toString();
    window.history.replaceState({}, '', window.location.pathname + (search ? '?' + search : ''));
}

/** 页面上的筛选值 → 接口参数。接口这一层不带前缀，前缀只用于地址栏。 */
export function apiParams(filters, extra = {}) {
    const params = {};
    Object.keys(filters || {}).forEach((key) => {
        const value = filters[key];
        if (value === '' || value === null || value === undefined) return;
        params['filter_' + key] = value;
    });
    return {...params, ...extra};
}

/** 三个纯函数，展示组件里也要用，所以单独导出。 */
export function cellOf(row, key) {
    const value = row && row.cells ? row.cells[key] : null;
    return value || { text: '-' };
}

export function badgeClassOf(row, key) {
    const badge = cellOf(row, key).badge || {};
    return badge.class || ('text-bg-' + (badge.tone || 'info'));
}

export function actionClassOf(action) {
    const style = action.variant === 'primary'
        ? 'btn-outline-primary'
        : (action.danger ? 'btn-outline-danger' : 'btn-outline-dark');
    return 'btn btn-sm ' + style;
}

/** 请求一页。调用方负责把结果塞进自己的 state。 */
export async function fetchPage(endpoint, page, { filters = {}, pageParam = 'page' } = {}) {
    return api.get(endpoint, apiParams(filters, {[pageParam]: page}));
}
