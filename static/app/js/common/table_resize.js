/* 列宽拖动：给所有 table.data-table 的表头加手柄，宽度存 localStorage。
   全站只有这一套手柄逻辑：Vue 页里手写的表（resource_table、alert_list、
   task_bar、resource_detail、maintenance_list、asset_workspace 等）也归它管；
   data_table.mjs 那份自己已经画好手柄和 colgroup 的表按「表头已有手柄”整表跳过，
   两边不重叠。 */
(function () {
    'use strict';

    var MIN_WIDTH = 72;
    // 方向键一次挪多少像素：和 data_table.mjs 的 KEYBOARD_RESIZE_STEP 一致，
    // 两套手柄都在页面上时手感不能不一样。
    var KEYBOARD_STEP = 16;

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
            // 手柄是 span，不给键盘一条路就只有鼠标用户能调列宽；role=separator
            // 但不可聚焦对辅助技术来说是半个控件。
            handle.setAttribute('tabindex', '0');
            handle.setAttribute('aria-label', '调整「' + (th.textContent || '').trim() + '」列宽：拖动，或按左右方向键');
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
            // 键盘路径和拖拽共用同一份 widths 和同一个下限：两边各夹一套值会互相踩回去。
            function renderedWidth() {
                return th.getBoundingClientRect ? Math.round(th.getBoundingClientRect().width) : 0;
            }
            function currentWidth() {
                // 没存过宽度时拿表头此刻的渲染宽度当起点，否则第一次按方向键会从 0 起跳。
                return widths[key] || renderedWidth() || MIN_WIDTH;
            }
            function maxWidth() {
                var tableWidth = table.getBoundingClientRect
                    ? Math.round(table.getBoundingClientRect().width)
                    : 0;
                return tableWidth > MIN_WIDTH ? tableWidth : MIN_WIDTH * 4;
            }
            function syncAriaValue() {
                handle.setAttribute('aria-valuenow', String(currentWidth()));
            }
            function setWidth(value) {
                widths[key] = Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(value)));
                applyWidths(table, widths);
                saveWidths(table, widths);
                syncAriaValue();
            }
            handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
            handle.addEventListener('keydown', function (event) {
                if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    event.stopPropagation();
                    setWidth(currentWidth() - KEYBOARD_STEP);
                } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    event.stopPropagation();
                    setWidth(currentWidth() + KEYBOARD_STEP);
                } else if (event.key === 'Home') {
                    // Home 回自动列宽：删掉这一列的保存值，宽度交回浏览器排版。
                    event.preventDefault();
                    event.stopPropagation();
                    delete widths[key];
                    applyWidths(table, widths);
                    saveWidths(table, widths);
                    syncAriaValue();
                } else if (event.key === 'End') {
                    // End 是反过来的一档：一列最多占满整张表。
                    event.preventDefault();
                    event.stopPropagation();
                    setWidth(maxWidth());
                }
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
