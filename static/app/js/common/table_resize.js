/* 列宽拖动：给所有 table.data-table 的表头加手柄，宽度存 localStorage。
   全站只有这一套手柄逻辑：Vue 页里手写的表（resource_table、alert_list、
   task_bar、resource_detail、maintenance_list、asset_workspace 等）也归它管；
   data_table.mjs 那份自己已经画好手柄和 colgroup 的表按「表头已有手柄”整表跳过，
   两边不重叠。 */
(function () {
    'use strict';

    var MIN_WIDTH = 72;

    function storageKey(table) {
        // 键优先取表格自己，其次取外层容器（模板里标在 card / shell 上）。
        var key = table.dataset.tableKey || '';
        if (!key) {
            var host = table.closest('[data-table-key]');
            key = host ? host.dataset.tableKey : '';
        }
        if (!key) {
            var region = table.closest('[role="region"]');
            key = region ? (region.getAttribute('aria-label') || '') : '';
        }
        return key ? 'table-widths:' + key : '';
    }

    function ensureColgroup(table, count) {
        var group = table.querySelector('colgroup');
        if (!group) {
            group = document.createElement('colgroup');
            // colgroup 在 HTML 内容模型里排在 caption 之后，别插到 caption 前面。
            var caption = table.querySelector('caption');
            table.insertBefore(group, caption ? caption.nextSibling : table.firstChild);
        }
        while (group.children.length < count) {
            group.appendChild(document.createElement('col'));
        }
        return group;
    }

    function applyWidths(table, widths) {
        var group = table.querySelector('colgroup');
        if (!group) return;
        var cells = table.querySelector('thead tr').children;
        Array.prototype.forEach.call(cells, function (th, index) {
            var key = th.dataset.columnKey || ('c' + index);
            var col = group.children[index];
            if (!col) return;
            col.style.width = key && widths[key] ? widths[key] + 'px' : '';
        });
    }

    function loadWidths(table) {
        var key = storageKey(table);
        if (!key) return {};
        try {
            return JSON.parse(localStorage.getItem(key) || '{}') || {};
        } catch (error) {
            return {};
        }
    }

    function saveWidths(table, widths) {
        var key = storageKey(table);
        if (!key) return;
        try {
            localStorage.setItem(key, JSON.stringify(widths));
        } catch (error) {
            /* 存不下就算了，本次会话内仍然生效。 */
        }
    }

    function enhance(table) {
        var head = table.querySelector('thead tr');
        if (!head) return;
        // data_table.mjs 渲染的表自带手柄和 colgroup，整表交给它；
        // 这里再插手就是两套宽度互相覆盖。
        if (head.querySelector('.table-resize-handle')) return;
        // 反复扫描（Vue 换表体、翻页）时宽度只从 localStorage 读一次。
        ensureColgroup(table, head.children.length);
        var widths = table.__resizeWidths || (table.__resizeWidths = loadWidths(table));
        applyWidths(table, widths);

        Array.prototype.forEach.call(head.children, function (th, index) {
            // 没标 data-column-key 的表按列序给键，模板不用改。
            if (!th.dataset.columnKey) th.dataset.columnKey = 'c' + index;
            var key = th.dataset.columnKey;
            if (th.querySelector('.table-resize-handle')) return;
            var handle = document.createElement('span');
            handle.className = 'table-resize-handle';
            handle.setAttribute('role', 'separator');
            handle.setAttribute('aria-orientation', 'vertical');
            handle.setAttribute('aria-label', '拖动调整「' + (th.textContent || '').trim() + '」列宽');
            handle.addEventListener('mousedown', function (event) {
                event.preventDefault();
                event.stopPropagation();
                var startX = event.clientX;
                var startWidth = th.getBoundingClientRect().width;
                function move(moveEvent) {
                    widths[key] = Math.max(MIN_WIDTH, Math.round(startWidth + moveEvent.clientX - startX));
                    applyWidths(table, widths);
                }
                function stop() {
                    document.removeEventListener('mousemove', move);
                    document.removeEventListener('mouseup', stop);
                    document.body.classList.remove('table-resizing');
                    saveWidths(table, widths);
                }
                document.body.classList.add('table-resizing');
                document.addEventListener('mousemove', move);
                document.addEventListener('mouseup', stop);
            });
            th.appendChild(handle);
        });
    }

    function scan(root) {
        (root || document).querySelectorAll('table.data-table').forEach(enhance);
    }

    // Vue 岛是挂载后才画出表头的，翻页也会整段换掉 tbody，
    // 所以除了首次扫描，还要盯着 DOM 变化再补一次（一帧内只扫一次）。
    var scheduled = false;
    function scheduleScan() {
        if (scheduled) return;
        scheduled = true;
        var run = function () {
            scheduled = false;
            scan();
        };
        if (window.requestAnimationFrame) {
            window.requestAnimationFrame(run);
        } else {
            window.setTimeout(run, 16);
        }
    }

    function observe() {
        if (!window.MutationObserver || !document.body) return;
        new MutationObserver(scheduleScan).observe(document.body, {childList: true, subtree: true});
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { scan(); observe(); }, {once: true});
    } else {
        scan();
        observe();
    }

    // 外部（例如详情弹窗塞入片段后）可以手动补扫。
})();
