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

/** 排序、筛选、翻页都在岛内完成，不写地址栏；URL 只由外部入口决定。 */
export function syncUrl() {}

/** 页面上的筛选值 → 接口参数。接口这一层不带前缀，前缀只用于地址栏。
    数值是 {op, value}、日期是 {from, to}，下划线开头的是服务端内部键，不外发。 */
export function apiParams(filters, extra = {}) {
    const params = {};
    Object.keys(filters || {}).forEach((key) => {
        const value = filters[key];
        const name = 'filter_' + key;
        if (value !== null && typeof value === 'object') {
            if (value.value !== undefined) {
                if (String(value.value).trim() === '') return;
                params[name] = value.value;
                params[name + '_op'] = value.op || 'gt';
            } else {
                if (value.from) params[name + '_from'] = value.from;
                if (value.to) params[name + '_to'] = value.to;
            }
            return;
        }
        if (value === '' || value === null || value === undefined) return;
        params[name] = value;
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
