(function (factory) {
    'use strict';

    const selection = typeof module === 'object' && module.exports
        ? require('./table_selection.js')
        : window.AppTableSelection;
    const controller = factory(selection);
    if (typeof window !== 'undefined') window.AppTableWorkspace = controller;
    if (typeof module === 'object' && module.exports) {
        module.exports = controller;
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            let storage = null;
            try {
                storage = window.localStorage;
            } catch (_error) {
                storage = null;
            }
            controller.initializeAll(document, storage, window.location);
            controller.bindPartialTableNavigation(document, storage, window);
            controller.openAutoOpenImportModal(document, window.bootstrap);
        });
    }
}(function (selection) {
    'use strict';

    const STORAGE_PREFIX = 'inspection-table:v1:';
    const {
        configurationDownloadHref,
        configurationDownloadState,
        downloadConfiguration,
        handleConfigurationDownload,
        renderConfigurationFeedback,
        updateConfigurationDownload,
        updateTargetSelection,
    } = selection;

    function storageKey(tableKey) {
        return `${STORAGE_PREFIX}${tableKey}`;
    }

    function checkedKeys(toggles, keyName) {
        return toggles
            .filter((toggle) => toggle.checked)
            .map((toggle) => toggle.dataset[keyName]);
    }

    function intersect(values, allowedKeys) {
        if (!Array.isArray(values)) return null;
        const allowed = new Set(allowedKeys);
        return values.filter((value) => typeof value === 'string' && allowed.has(value));
    }

    function readPreferences(storage, key, defaults, available) {
        if (!storage) return null;
        try {
            const raw = storage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const visibleFields = intersect(parsed.visibleFields, available.columnKeys);
            const filterFields = intersect(parsed.filterFields, available.filterKeys);
            const pageSize = Number(parsed.pageSize);
            return {
                visibleFields: visibleFields === null ? defaults.visibleFields : visibleFields,
                filterFields: filterFields === null ? defaults.filterFields : filterFields,
                pageSize: available.pageSizes.includes(pageSize) ? pageSize : defaults.pageSize,
            };
        } catch (_error) {
            return null;
        }
    }

    function applyPreferences(elements, preferences) {
        const visibleFields = new Set(preferences.visibleFields);
        const filterFields = new Set(preferences.filterFields);

        elements.columnToggles.forEach((toggle) => {
            toggle.checked = visibleFields.has(toggle.dataset.columnKey);
        });
        elements.columnCells.forEach((cell) => {
            cell.hidden = !visibleFields.has(cell.dataset.columnKey);
        });
        elements.filterToggles.forEach((toggle) => {
            toggle.checked = filterFields.has(toggle.dataset.filterKey);
        });
        elements.filterFields.forEach((field) => {
            field.hidden = !filterFields.has(field.dataset.filterKey);
        });
        if (elements.moreFilters) {
            elements.moreFilters.open = elements.moreFilterFields.some(
                (field) => !field.hidden,
            );
        }
        if (elements.pageSize) {
            elements.pageSize.value = String(preferences.pageSize);
        }
    }

    function activeFilterKeys(elements) {
        return elements.filterToggles
            .filter((toggle) => toggle.dataset.filterActive !== undefined)
            .map((toggle) => toggle.dataset.filterKey);
    }

    function keepActiveFiltersVisible(preferences, elements) {
        const visible = new Set(preferences.filterFields);
        activeFilterKeys(elements).forEach((key) => visible.add(key));
        return {...preferences, filterFields: Array.from(visible)};
    }

    function filterParameters(source) {
        return String(source?.dataset?.filterParameters || '').split(/\s+/).filter(Boolean);
    }

    // 页内导航统一出口：有表格工作区就 fetch 换内容，地址栏保持不动。
    // 拿不到 fetch/DOMParser 时返回 false，由调用方决定是否退回整页导航。
    function partialNavigate(elements, href, location) {
        const documentRoot = elements?.documentRoot || null;
        const browserWindow = elements?.browserWindow || null;
        if (!documentRoot || typeof browserWindow?.fetch !== 'function'
            || typeof browserWindow?.DOMParser !== 'function') return false;
        let target;
        try {
            target = new URL(href, location?.href || browserWindow.location?.href).toString();
        } catch (_error) {
            return false;
        }
        refreshTableWorkspaces(documentRoot, target, elements.storage, browserWindow);
        return true;
    }

    function clearActiveFilterSource(elements, source, location) {
        if (!source || source.dataset.filterActive === undefined) return false;
        const controls = Array.from(source.querySelectorAll?.('[name]') || []);
        const parameters = filterParameters(source);
        const focusTarget = source.querySelector?.('[name]:not([type="hidden"])') || controls[0];
        focusTarget?.focus?.();
        controls.forEach((control) => {
            control.value = '';
            control.disabled = true;
            if (control.name && !parameters.includes(control.name)) parameters.push(control.name);
        });
        delete source.dataset.filterActive;
        elements.exportLinks.forEach((link) => {
            if (!link.href) return;
            const exportUrl = new URL(link.href, location?.href);
            parameters.forEach((parameter) => exportUrl.searchParams.delete(parameter));
            exportUrl.searchParams.delete('page');
            link.href = exportUrl.toString();
        });
        if (!location?.href) return true;
        const pageUrl = new URL(location.href);
        parameters.forEach((parameter) => pageUrl.searchParams.delete(parameter));
        pageUrl.searchParams.delete('page');
        if (partialNavigate(elements, pageUrl.toString(), location)) return true;
        if (typeof location.replace === 'function') location.replace(pageUrl.toString());
        return true;
    }

    function clearActiveFilter(elements, toggle, location) {
        const key = toggle.dataset.filterKey;
        const sources = elements.activeFilterSources?.length ? elements.activeFilterSources : elements.filterFields;
        const source = sources.find(
            (candidate) => candidate.dataset.filterKey === key,
        );
        if (!source || source.dataset.filterActive === undefined) return;
        delete toggle.dataset.filterActive;
        clearActiveFilterSource(elements, source, location);
    }
    function currentPreferences(elements, defaults) {
        return {
            visibleFields: checkedKeys(elements.columnToggles, 'columnKey'),
            filterFields: checkedKeys(elements.filterToggles, 'filterKey'),
            pageSize: elements.pageSize ? Number(elements.pageSize.value) : defaults.pageSize,
        };
    }

    function writePreferences(storage, key, preferences) {
        if (!storage) return;
        try {
            storage.setItem(key, JSON.stringify(preferences));
        } catch (_error) {
            // Storage can be unavailable in private or restricted browser contexts.
        }
    }

    function removePreferences(storage, key) {
        if (!storage) return;
        try {
            storage.removeItem(key);
        } catch (_error) {
            // Reset still applies the server defaults when storage is unavailable.
        }
    }

    // 换每页条数时只带真正有值的参数去请求，空筛选框不进 URL。
    function cleanSearch(url) {
        const kept = Array.from(url.searchParams.entries()).filter(([, value]) => String(value).trim() !== '');
        return new URLSearchParams(kept).toString();
    }

    function replacePageSizeQuery(location, pageSize, value, elements) {
        if (!location?.href || !pageSize) return;
        const parameter = pageSize.name || 'page_size';
        const url = new URL(location.href);
        const pageParameter = parameter === 'page_size'
            ? 'page'
            : parameter.replace(/_page_size$/, '_page');
        url.searchParams.set(parameter, String(value));
        url.searchParams.delete(pageParameter);
        const search = cleanSearch(url);
        const href = url.pathname + (search ? '?' + search : '');
        if (partialNavigate(elements, href, location)) return;
        if (typeof location.replace === 'function') location.replace(href);
    }

    function initializeWorkspace(workspace, storage, location = null) {
        const tableKey = workspace.dataset.tableKey;
        if (!tableKey) return;

        const elements = {
            workspace,
            documentRoot: workspace.ownerDocument || null,
            browserWindow: workspace.ownerDocument?.defaultView || null,
            storage,
            columnToggles: Array.from(workspace.querySelectorAll('[data-column-toggle]')),
            columnCells: Array.from(workspace.querySelectorAll('th[data-column-key], td[data-column-key]')),
            filterToggles: Array.from(workspace.querySelectorAll('[data-filter-toggle]')),
            filterFields: Array.from(workspace.querySelectorAll('[data-filter-field][data-filter-key]')),
            pageSize: workspace.querySelector('[data-page-size]'),
            reset: workspace.querySelector('[data-table-reset]'),
            moreFilters: workspace.querySelector('[data-more-filters]'),
            exportLinks: Array.from(workspace.querySelectorAll('[data-filtered-export]')),
            configurationExport: workspace.querySelector('[data-selected-config-export]'),
            selectionAll: workspace.querySelector('[data-device-select-all]'),
            selectionInvert: workspace.querySelector('[data-device-select-invert]'),
            configurationFeedback: workspace.querySelector('[data-configuration-export-feedback]'),
            suggestionSelects: Array.from(workspace.querySelectorAll('[data-filter-suggestion-select]')),
            activeFilterSources: Array.from(workspace.querySelectorAll('[data-active-filter-source]')),
        };
        elements.moreFilterFields = elements.moreFilters
            ? Array.from(elements.moreFilters.querySelectorAll(
                '[data-filter-field][data-filter-key]',
            ))
            : [];
        const defaults = {
            visibleFields: elements.columnToggles
                .filter((toggle) => toggle.defaultChecked)
                .map((toggle) => toggle.dataset.columnKey),
            filterFields: elements.filterToggles
                .filter((toggle) => toggle.defaultChecked)
                .map((toggle) => toggle.dataset.filterKey),
            pageSize: Number(elements.pageSize?.dataset.defaultPageSize || elements.pageSize?.value || 0),
        };
        const available = {
            columnKeys: elements.columnToggles.map((toggle) => toggle.dataset.columnKey),
            filterKeys: elements.filterToggles.map((toggle) => toggle.dataset.filterKey),
            pageSizes: elements.pageSize
                ? Array.from(elements.pageSize.options).map((option) => Number(option.value))
                : [defaults.pageSize],
        };
        const current = currentPreferences(elements, defaults);
        // 服务端这一版渲染用的每页条数；和偏好不一致才需要补一次页内刷新。
        const servedPageSize = elements.pageSize ? Number(elements.pageSize.value) : 0;
        const key = storageKey(tableKey);
        const storedPreferences = readPreferences(storage, key, defaults, available);
        const preferences = keepActiveFiltersVisible(
            storedPreferences || current,
            elements,
        );
        applyPreferences(elements, preferences);
        // 服务端工具栏的「全选/反选/下载所选」作用在表格里的复选框上，而 Vue
        // 表格页的复选框是岛挂载之后才画出来的；initializeWorkspace 跑在
        // mountPages 之前，这里同步快照下来的数组永远是空的，工具栏就永久失效。
        // 改成用的时候再查一次 DOM，并靠 change 事件委托感知单个勾选，挂载顺序
        // 不再影响结果。
        const selectionTargets = () => Array.from(
            workspace.querySelectorAll('[data-device-selection-target]'),
        );
        const refreshDownloadButton = () => updateConfigurationDownload(
            elements.configurationExport, selectionTargets(),
        );
        refreshDownloadButton();
        workspace.addEventListener?.('change', (event) => {
            if (!event.target?.matches?.('[data-device-selection-target]')) return;
            refreshDownloadButton();
            renderConfigurationFeedback(elements.configurationFeedback, '');
        });
        const applyTargetSelection = (action) => {
            const targets = selectionTargets();
            updateTargetSelection(targets, action);
            refreshDownloadButton();
            renderConfigurationFeedback(elements.configurationFeedback, '');
            // Vue 岛在根节点上用 @change 读选择，直接改 checked 不会触发它，
            // 岛里「已选 N 台」和它自己的下载链接就和复选框对不上。补发一次
            // 冒泡 change，和岛内 selectAll 的做法保持一致。
            const EventConstructor = workspace.ownerDocument?.defaultView?.Event
                || (typeof Event === 'function' ? Event : null);
            if (!EventConstructor) return;
            targets.forEach((target) => target.dispatchEvent?.(
                new EventConstructor('change', {bubbles: true}),
            ));
        };
        elements.selectionAll?.addEventListener('click', () => applyTargetSelection('all'));
        elements.selectionInvert?.addEventListener('click', () => applyTargetSelection('invert'));
        elements.configurationExport?.addEventListener('click', async (event) => {
            const browserWindow = workspace.ownerDocument?.defaultView;
            await handleConfigurationDownload(
                event,
                elements.configurationExport,
                elements.configurationFeedback,
                browserWindow,
            );
        });
        if (storedPreferences && servedPageSize !== Number(preferences.pageSize)) {
            replacePageSizeQuery(location, elements.pageSize, preferences.pageSize, elements);
        }

        const save = () => writePreferences(storage, key, currentPreferences(elements, defaults));
        elements.columnToggles.forEach((toggle) => {
            toggle.addEventListener('change', () => {
                applyPreferences(elements, currentPreferences(elements, defaults));
                save();
            });
        });
        elements.filterToggles.forEach((toggle) => {
            toggle.addEventListener('change', () => {
                if (!toggle.checked) {
                    clearActiveFilter(elements, toggle, location);
                }
                applyPreferences(elements, currentPreferences(elements, defaults));
                save();
            });
        });
        elements.suggestionSelects.forEach((select) => {
            select.addEventListener('change', () => {
                const inputId = select.dataset.filterInput;
                const input = inputId ? workspace.querySelector(`#${inputId}`) : null;
                if (!input || !select.value) return;
                input.value = select.value;
                select.value = '';
                input.focus?.();
            });
        });
        elements.pageSize?.addEventListener('change', () => {
            save();
            replacePageSizeQuery(location, elements.pageSize, elements.pageSize.value, elements);
        });
        elements.reset?.addEventListener('click', () => {
            removePreferences(storage, key);
            applyPreferences(elements, defaults);
            if (elements.pageSize && defaults.pageSize) {
                replacePageSizeQuery(location, elements.pageSize, defaults.pageSize, elements);
            } else if (elements.pageSize?.form) {
                elements.pageSize.form.requestSubmit();
            }
        });
    }

    function initializeAll(documentRoot, storage, location = null) {
        documentRoot.querySelectorAll('[data-table-workspace]').forEach((workspace) => {
            initializeWorkspace(workspace, storage, location);
        });
    }

    function announceTableUpdate(documentRoot, replacements) {
        const liveRegion = documentRoot.getElementById?.('app-live-region');
        if (!liveRegion) return;
        const summary = replacements
            .map(replacement => replacement.querySelector('[data-result-summary]')?.textContent?.trim())
            .find(Boolean);
        liveRegion.textContent = summary ? `列表已更新。${summary}` : '列表已更新。';
    }

    /** 片段替换后把里面的 Vue 岛重新挂上（boot.mjs 只在首次加载时挂过一次）。 */
    function remountIslands(root) {
        if (!root || !root.querySelector || !root.querySelector('[data-vue-page]')) return;
        import('/static/app/vue/boot.mjs')
            .then((boot) => boot.mountPages?.(root))
            .catch(() => {});
    }

    // 换每页条数、连续取消筛选、连点分页都会连续触发页内刷新，而网络返回的
    // 顺序不等于请求发出的顺序：晚发的先回，早发的旧内容就会盖住新内容。
    // 给每次请求编号，只让最后一次的响应落 DOM。
    function nextRefreshToken(documentRoot) {
        const token = (documentRoot.__tableRefreshToken || 0) + 1;
        documentRoot.__tableRefreshToken = token;
        return token;
    }

    function isLatestRefresh(documentRoot, token) {
        return documentRoot.__tableRefreshToken === token;
    }

    function tableWorkspaces(documentRoot) {
        return Array.from(documentRoot.querySelectorAll('[data-table-workspace]'));
    }

    async function refreshTableWorkspaces(documentRoot, href, storage, browserWindow, options = {}) {
        const token = nextRefreshToken(documentRoot);
        tableWorkspaces(documentRoot).forEach((workspace) => workspace.setAttribute('aria-busy', 'true'));
        try {
            const response = await browserWindow.fetch(href, {
                credentials: 'same-origin',
                headers: {'X-Requested-With': 'XMLHttpRequest'},
            });
            if (!response.ok) throw new Error(`Table request failed: ${response.status}`);
            const parsed = new browserWindow.DOMParser().parseFromString(
                await response.text(),
                'text/html',
            );
            const replacements = Array.from(parsed.querySelectorAll('[data-table-workspace]'));
            // 过期响应直接扔掉：既不替换 DOM，也不能拿它做整页跳转兜底——那会
            // 把最后一次请求的结果覆盖掉。
            if (!isLatestRefresh(documentRoot, token)) return [];
            // 替换目标在响应回来时重新查一次：先发的请求可能已经把发起时那个
            // 节点换掉了，对着 detached 的旧节点 replaceWith 等于什么都没换。
            const pairs = tableWorkspaces(documentRoot).map((workspace) => {
                const replacement = replacements.find(
                    (candidate) => candidate.dataset.tableKey === workspace.dataset.tableKey,
                );
                if (!replacement) throw new Error(`Missing table workspace: ${workspace.dataset.tableKey}`);
                return {workspace, replacement};
            });
            // 排序、筛选、翻页只换表格内容，地址栏保持外部进来时的样子。
            pairs.forEach(({workspace, replacement}) => {
                workspace.replaceWith(replacement);
                initializeWorkspace(replacement, storage, browserWindow.location);
                // 换进来的是新 DOM，Vue 岛必须重挂，否则只剩表头没有行。
                // 用传进来的 browserWindow 而不是裸的全局 window：这个函数在
                // 非浏览器环境（测试、SSR）里没有 window，裸引用会直接抛
                // ReferenceError，被下面的 catch 吞掉后走整页跳转兜底，
                // 顺带把后面的焦点恢复也一起跳过了。
                browserWindow.mountPages?.(replacement);
            });
            announceTableUpdate(documentRoot, pairs.map(({replacement}) => replacement));
            restoreFocusAfterRefresh(pairs, options);
            return pairs.map(({replacement}) => replacement);
        } catch (_error) {
            if (!isLatestRefresh(documentRoot, token)) return [];
            tableWorkspaces(documentRoot).forEach((workspace) => workspace.removeAttribute('aria-busy'));
            browserWindow.location.assign(href);
            return [];
        }
    }

    // 局部刷新把整块 DOM 换掉，被点的那个元素已经不在文档里，浏览器会把焦点
    // 丢回 body。只认 focusSortKey 会把分页和「重置查询」漏掉，所以按被点元素
    // 的类别分别找同一个控件：排序链接按列键，分页按钮按 data-page（翻到末页
    // 时它变成不可聚焦的 span，退到页码输入框），重置查询退到第一个可见控件。
    function restoreFocusAfterRefresh(pairs, options) {
        if (!options.focusTableKey) return;
        const table = pairs.find(
            ({replacement}) => replacement.dataset.tableKey === options.focusTableKey,
        )?.replacement;
        if (!table?.querySelector) return;
        const selectors = [];
        if (options.focusSortKey) selectors.push(`[data-sort-key="${options.focusSortKey}"]`);
        if (options.focusPage) selectors.push(`a[data-page="${options.focusPage}"]`);
        if (options.focusQueryReset) selectors.push('[data-query-reset]');
        if (!selectors.length) return;
        selectors.push('.page-pagination__input', '[data-table-query-form] input:not([type="hidden"])');
        const destination = selectors
            .map((selector) => table.querySelector(selector))
            .find((candidate) => typeof candidate?.focus === 'function');
        destination?.focus();
    }

    function bindPartialTableNavigation(documentRoot, storage, browserWindow) {
        if (documentRoot.__partialTableNavigation) return documentRoot.__partialTableNavigation;

        const supported = typeof browserWindow?.fetch === 'function'
            && typeof browserWindow?.DOMParser === 'function';
        const handleClick = async (event) => {
            const link = event.target?.closest?.('.table-sort-link, [data-query-reset], a.page-pagination__button');
            if (!supported || !link || event.defaultPrevented || event.button !== 0
                || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
                || link.target || link.hasAttribute?.('download')) return;
            const url = new URL(link.href, browserWindow.location.href);
            if (url.origin !== browserWindow.location.origin) return;
            const workspace = link.closest('[data-table-workspace]');
            if (!workspace || workspace.getAttribute('aria-busy') === 'true') return;
            event.preventDefault();
            return refreshTableWorkspaces(
                documentRoot, url.toString(), storage, browserWindow,
                {
                    focusTableKey: workspace.dataset.tableKey,
                    focusSortKey: link.dataset.sortKey || '',
                    // 分页按钮和「重置查询」也要带焦点意图，否则翻页后焦点掉回 body。
                    focusPage: link.dataset.page || '',
                    focusQueryReset: link.hasAttribute?.('data-query-reset') === true,
                },
            );
        };
        const handleSubmit = async (event) => {
            const form = event.target;
            if (!supported || event.defaultPrevented
                || !form?.matches?.('[data-table-query-form]')
                || String(form.method || 'get').toLowerCase() !== 'get') return;
            const workspace = form.closest('[data-table-workspace]');
            if (!workspace || workspace.getAttribute('aria-busy') === 'true') return;
            const url = new URL(form.action || browserWindow.location.href, browserWindow.location.href);
            const formData = new browserWindow.FormData(form);
            url.search = new URLSearchParams(formData.entries()).toString();
            url.searchParams.delete('page');
            event.preventDefault();
            return refreshTableWorkspaces(documentRoot, url.toString(), storage, browserWindow);
        };
        const handlePopState = () => refreshTableWorkspaces(
            documentRoot,
            browserWindow.location.href,
            storage,
            browserWindow,
            {updateHistory: false},
        );
        documentRoot.addEventListener('click', handleClick);
        documentRoot.addEventListener('submit', handleSubmit);
        browserWindow.addEventListener('popstate', handlePopState);
        const binding = {handleClick, handleSubmit, handlePopState};
        documentRoot.__partialTableNavigation = binding;
        return binding;
    }
    function openAutoOpenImportModal(documentRoot, bootstrapApi) {
        const modalElement = documentRoot.querySelector(
            '#importModal[data-auto-open="true"]',
        );
        if (!modalElement || typeof bootstrapApi?.Modal?.getOrCreateInstance !== 'function') {
            return;
        }
        bootstrapApi.Modal.getOrCreateInstance(modalElement).show();
    }

    return {announceTableUpdate, bindPartialTableNavigation, clearActiveFilterSource, configurationDownloadHref, configurationDownloadState, downloadConfiguration, handleConfigurationDownload, initializeWorkspace, initializeAll, openAutoOpenImportModal, refreshTableWorkspaces, storageKey, updateTargetSelection};
}));
