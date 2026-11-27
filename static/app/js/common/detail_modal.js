/* 统一的"详情"弹窗：任何带 data-detail-modal 的按钮都在弹窗里打开，不再跳新页面。
   走 fetch 片段而不是 iframe，和设置类弹窗保持一致。
   打开的详情同步到 #detail=<路径>，所以链接可以分享，直接访问也会自动弹出。

   两次点击之间的体感要做对：
   1. 先画骨架再等网络，点下去立刻有反馈；
   2. Vue 模块提前预取，避免首次打开时现下载；
   3. 填充内容前后记住滚动位置，片段里的锚点或自动聚焦不会把页面顶走。 */
(function () {
    const MODAL_ID = 'genericDetailModal';
    const HASH_KEY = '#detail=';
    // 详情接口挂住时骨架会一直转圈，用户以为点坏了。给请求一个上限。
    const FETCH_TIMEOUT_MS = 8000;
    // 两次点击之间只有最后一次算数：先点一个慢的详情、再点一个快的，
    // 慢的那个后到会把快的结果覆盖掉。用编号判断响应是否还是当前那次。
    let openSequence = 0;

    // 提前把 Vue 运行时要过来，第一次点详情就不用等它下载。
    // 地址按本脚本自身推出来：部署在子路径（/net/…）时写死 /static 会 404。
    const bootModule = import(bootURL());

    function bootURL() {
        const script = document.currentScript
            || document.querySelector('script[src$="js/common/detail_modal.js"]');
        return script && script.src ? new URL('../../vue/boot.mjs', script.src).href : '';
    }

    function target() {
        return document.querySelector('[data-generic-detail-body]');
    }

    /** 弹窗是页面内部行为，不写地址栏；外部深链直接访问对应详情页。 */
    function syncHash() {}

    function pathFromHash() {
        const hash = window.location.hash || '';
        if (!hash.startsWith(HASH_KEY)) return '';
        try {
            return decodeURIComponent(hash.slice(HASH_KEY.length));
        } catch (error) {
            return '';
        }
    }

    function skeleton() {
        return '<div class="detail-skeleton" aria-hidden="true">'
            + '<div class="detail-skeleton__bar" style="width:38%"></div>'
            + '<div class="detail-skeleton__bar" style="width:82%"></div>'
            + '<div class="detail-skeleton__bar" style="width:64%"></div>'
            + '<div class="detail-skeleton__bar" style="width:74%"></div>'
            + '</div>';
    }

    function nextFrame() {
        return new Promise(function (resolve) {
            window.requestAnimationFrame(function () { window.requestAnimationFrame(resolve); });
        });
    }

    // 详情接口不会自己结束：超时后主动 abort，让 catch 走失败提示而不是永久骨架。
    async function fetchDetail(path) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
        const options = {headers: {'X-Requested-With': 'XMLHttpRequest'}};
        if (controller) options.signal = controller.signal;
        try {
            return await fetch(path, options);
        } finally {
            if (timer) window.clearTimeout(timer);
        }
    }

    async function open(path) {
        const modal = document.getElementById(MODAL_ID);
        const box = target();
        if (!modal || !box || !path) return;

        openSequence += 1;
        const sequence = openSequence;
        const isCurrent = () => sequence === openSequence;

        const scrollY = window.scrollY;
        // 详情正文靠这个地址算翻页/排序/筛选的接口锚点，弹窗里不能拿列表页地址。
        box.dataset.detailUrl = path;
        box.innerHTML = skeleton();
        if (window.bootstrap && window.bootstrap.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modal).show();
        }
        // 让浏览器先把骨架画出来，再去等网络。
        await nextFrame();
        if (!isCurrent()) return;

        try {
            const response = await fetchDetail(path);
            if (!response.ok) throw new Error(String(response.status));
            const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
            // 已经点了别的详情：这次响应作废，连 DOM 都不要碰。
            if (!isCurrent()) return;
            const content = parsed.getElementById('main-content') || parsed.body;
            box.innerHTML = content ? content.innerHTML : '<p class="mb-0">没有可显示的内容。</p>';
            // 详情正文是 Vue 渲染的，塞进来之后要在这里重新挂一遍。
            const { mountPages } = await bootModule;
            if (!isCurrent()) return;
            await mountPages(box);
            // mountPages 是异步渲染，等它回来时可能又开了新的一次详情。
            if (!isCurrent()) return;
            // 片段里如果带了表格（比如任务的目标明细），它的表格行为也要重新初始化。
            if (window.AppTableWorkspace && window.AppTableWorkspace.initializeAll) {
                window.AppTableWorkspace.initializeAll(box, window.localStorage, window.location);
            }
            bindInnerLinks(box);
        } catch (error) {
            if (!isCurrent()) return;
            box.innerHTML = '<p class="text-danger mb-0">详情加载失败，请稍后再试。</p>';
            return;
        } finally {
            // 片段里的锚点或自动聚焦可能动过滚动位置，恢复回去。
            // 过期请求不再碰滚动：那是当前这次请求的地盘。
            if (isCurrent() && window.scrollY !== scrollY) window.scrollTo(0, scrollY);
        }
        if (!isCurrent()) return;
        syncHash(path);
    }

    // 弹窗里的站内链接（翻页、返回列表、看原始日志）在弹窗内换内容，不再让整页跳走。
    function bindInnerLinks(box) {
        if (box.dataset.linksBound) return;
        box.dataset.linksBound = '1';
        box.addEventListener('click', (event) => {
            // 捕获阶段的拦截会放过带修饰键的点击，这里也得放过；否则弹窗里的
            // 翻页/返回链接被 Ctrl+点击时仍然变成弹窗内重载，开不出新标签。
            if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const link = event.target.closest && event.target.closest('a[href]');
            // data-detail-close 是"关掉弹窗回列表"，别在这里又加载一次列表页。
            if (!link || link.hasAttribute('data-detail-modal') || link.hasAttribute('data-detail-close')) return;
            if (link.target === '_blank' || link.hasAttribute('download')) return;
            const href = link.getAttribute('href');
            if (!href || href.startsWith('#') || !href.startsWith('/')) return;
            event.preventDefault();
            open(href);
        });
    }

    function close() {
        // 关掉弹窗后，路上那次详情请求的响应不能再往已经清空的容器里写内容。
        openSequence += 1;
        const box = target();
        if (box) {
            box.innerHTML = '';
            delete box.dataset.detailUrl;
        }
        syncHash('');
    }

    // 捕获阶段：行内链接常用 @click.stop 阻止冒泡（避免同时选中整行），
    // 冒泡阶段会漏掉它们，捕获阶段先拿到就稳。
    document.addEventListener('click', (event) => {
        // Ctrl/⌘/Shift/Alt 加点击、或者不是左键，是浏览器自己的导航语义
        // （新标签打开、新窗口、选中文本）：在同一层就拦掉会把这些动作吃成弹窗。
        // modal_transport.js 的冒泡处理用的是同一套判断。
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const trigger = event.target.closest && event.target.closest('[data-detail-modal]');
        // 独立详情页上没有这个弹窗容器：不拦，让链接照常导航。
        if (!trigger || !document.getElementById(MODAL_ID)) return;
        event.preventDefault();
        event.stopPropagation();
        open(trigger.dataset.detailModal);
    }, true);

    document.addEventListener('DOMContentLoaded', () => {
        const modal = document.getElementById(MODAL_ID);
        if (modal) modal.addEventListener('hidden.bs.modal', close);
        const initial = pathFromHash();
        if (initial) open(initial);
    });

    window.addEventListener('hashchange', () => {
        const path = pathFromHash();
        if (path) open(path);
    });
}());
