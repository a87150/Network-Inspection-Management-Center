/** Vue island for the group member modal: selection state only, table stays server-rendered.
 *
 * Loaded both on the standalone member page and on the group list, because the modal is
 * fetched and injected there. Mounting is idempotent so injected markup gets picked up on
 * every app:modal-updated without double-binding the previous DOM.
 *
 * 翻页走 data-modal-navigate，整个 .modal-content 会被换掉，所以勾选存在外层 modal 的
 * dataset 上（按页码分桶）：换页时新岛读回同页那一桶，回到原页仍然勾着。
 */
import { createApp } from '../../../vendor/vue/vue.esm-browser.prod.js';
import { nextSelection, submitDisabled, summaryLabel } from './member_selection.mjs';

const STORE_FIELD = 'memberSelection';
const SORT_COLUMNS = { type: 1, name: 2, extra: 3 };

function readStore(modal) {
  try {
    return JSON.parse(modal?.dataset[STORE_FIELD] || '{}').pages || {};
  } catch (error) {
    return {};
  }
}

function writeStore(modal, page, selected) {
  if (!modal) return;
  const pages = readStore(modal);
  pages[page] = [...selected];
  modal.dataset[STORE_FIELD] = JSON.stringify({ pages });
}

function clearStore(modal) {
  if (modal) delete modal.dataset[STORE_FIELD];
}

function rowsOf(tbody) {
  return Array.from(tbody.rows).filter(row => !row.querySelector('.empty-state'));
}

function cellText(row, index) {
  return (row.children[index]?.textContent || '').trim();
}

/** 排序、页内筛选、导出：表格是服务端渲染的，这里只重排/隐藏/读行，不重新渲染。 */
function enhanceTable(root) {
  const table = root.querySelector('table.domain-members-table');
  if (!table || table.dataset.memberEnhanced === 'true') return;
  table.dataset.memberEnhanced = 'true';
  const tbody = table.tBodies[0];
  if (!tbody) return;

  let sort = { key: '', direction: 1 };
  const applySort = () => {
    if (!sort.key) return;
    const index = SORT_COLUMNS[sort.key];
    const ordered = rowsOf(tbody)
      .map((row, position) => ({ row, position, text: cellText(row, index) }))
      .sort((a, b) => a.text.localeCompare(b.text, 'zh-Hans-CN') * sort.direction
        || a.position - b.position);
    tbody.append(...ordered.map(item => item.row));
  };

  root.querySelectorAll('[data-member-sort]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.memberSort;
      sort = { key, direction: sort.key === key ? -sort.direction : 1 };
      root.querySelectorAll('[data-member-sort]').forEach(other => {
        const active = other === button;
        other.closest('th').setAttribute('aria-sort',
          active ? (sort.direction > 0 ? 'ascending' : 'descending') : 'none');
        other.querySelector('[data-member-sort-arrow]')?.remove();
        if (!active) return;
        const arrow = document.createElement('span');
        arrow.dataset.memberSortArrow = '';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = sort.direction > 0 ? ' ▲' : ' ▼';
        other.append(arrow);
      });
      applySort();
    });
  });

  const filter = root.querySelector('[data-member-page-filter]');
  filter?.addEventListener('input', () => {
    const needle = filter.value.trim().toLowerCase();
    rowsOf(tbody).forEach(row => {
      row.hidden = Boolean(needle) && !row.textContent.toLowerCase().includes(needle);
    });
  });

  const identityOf = row => {
    const cell = row.children[2];
    if (!cell) return '';
    return [cell.querySelector('strong'), cell.querySelector('span')]
      .map(node => (node?.textContent || '').trim()).filter(Boolean).join(' / ');
  };

  root.querySelector('[data-member-export]')?.addEventListener('click', event => {
    const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
    const lines = [['类型', '成员', '账号 / 计算机', '目录位置 / 关系'].map(quote)];
    rowsOf(tbody).filter(row => !row.hidden).forEach(row => {
      const base = [cellText(row, 1), identityOf(row), cellText(row, 3)].map(quote);
      lines.push(base);
    });
    const blob = new Blob(['\ufeff' + lines.map(line => line.join(',')).join('\r\n')],
      { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (event.currentTarget?.dataset.memberExportName || '域分组成员') + '.csv';
    link.click();
    // ponytail: 立即回收会打断部分浏览器的下载，推迟一拍足够。
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
}

function mountIsland(root) {
  if (!root || root.__vue_app__) return;

  const modal = root.closest('.modal');
  const page = root.dataset.memberPage || '1';
  const candidates = () => Array.from(root.querySelectorAll('input[data-member-target]:not(:disabled)'));
  // 服务端回填的 checked 必须在 Vue 接管之前读：失败重投表单靠它恢复。
  const serverChecked = Array.from(root.querySelectorAll('input[data-member-target]:checked'))
    .map(input => input.value);
  const saved = readStore(modal)[page];

  createApp({
    delimiters: ['[[', ']]'],
    data() {
      return {
        // 翻页前记下的勾选优先；没有就回到服务端渲染的初值。
        selected: Array.isArray(saved) ? saved : serverChecked,
        total: Number(root.dataset.candidateCount || 0),
        locked: root.dataset.memberLocked === 'true',
      };
    },
    computed: {
      summary() {
        return summaryLabel(this.selected.length, this.total);
      },
      submitDisabled() {
        return submitDisabled(this.selected.length, this.locked);
      },
    },
    watch: {
      selected(list) {
        writeStore(modal, page, list);
      },
    },
    methods: {
      select(action) {
        this.selected = nextSelection(this.selected, candidates().map(input => input.value), action);
      },
    },
  }).mount(root);

  enhanceTable(root);
}

function scan(scope) {
  (scope || document).querySelectorAll('#domain-members-island').forEach(mountIsland);
}

// 提交后服务端会清掉选择；失败会回填 checked，dataset 里的旧勾选要在这里让路。
document.addEventListener('submit', event => {
  if (event.target?.id === 'domain-group-member-action') {
    clearStore(event.target.closest('.modal'));
  }
}, true);

document.addEventListener('hidden.bs.modal', event => {
  if (event.target?.id === 'domainGroupMembersModal') clearStore(event.target);
});

scan();
document.addEventListener('app:modal-updated', event => scan(event.detail?.modal || document));
