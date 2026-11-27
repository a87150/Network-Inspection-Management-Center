/* 任务状态轮询：任务中心与任务详情在任务跑完之前不会自己变——以前只有 people 的
   导入流程有轮询，任务跑完后这两处要手动刷新才看得到结果。

   四个约束，各占一段：
   1. 只在页面上还有未终态任务时轮。判据是服务端渲染在宿主上的
      data-task-pending，不是 DOM 里的状态徽章：徽章要等 Vue 岛挂载后才存在，
      初次加载读不到就会一直不轮。
   2. 页面隐藏时不排下一次，切回前台立刻补一拍——后台标签页的定时器会被
      浏览器节流甚至冻结，靠残留的定时等不来结果。
   3. 刷新拿到终态后停：继续轮下去等于给不再变化的数据持续发请求。
   4. 链式调度而不是 setInterval：慢响应时 setInterval 会叠出并发请求，
      后到的旧响应还会盖掉新的。 */

const PENDING_SELECTOR = '[data-task-pending="1"]';

function hasPendingStatus(documentRoot) {
    return Boolean(documentRoot?.querySelector?.(PENDING_SELECTOR));
}

function createStatusPolling({browserWindow, documentRoot, refresh, intervalMs = 5000}) {
    let timer = null;
    let stopped = true;
    let busy = false;

    const clear = () => {
        if (timer !== null) browserWindow.clearTimeout(timer);
        timer = null;
    };

    function schedule() {
        if (stopped || timer !== null || documentRoot.hidden || !hasPendingStatus(documentRoot)) return;
        timer = browserWindow.setTimeout(run, intervalMs);
    }

    async function run() {
        timer = null;
        // busy 挡住重入：上一拍的刷新还没回来就不该再发一份。
        if (stopped || busy || documentRoot.hidden) return;
        busy = true;
        try {
            await refresh();
        } catch (_error) {
            // 刷新失败按原节奏再来：轮询只是"看一眼"，一次网络抖动不该打断它；
            // 终态判断在下一拍重新读 data-task-pending，不做额外假设。
        } finally {
            busy = false;
        }
        if (!hasPendingStatus(documentRoot)) {
            stop();
            return;
        }
        schedule();
    }

    function start() {
        if (!stopped) return;
        // 没有要等的任务就别启动：否则每个静态页面都空转一个定时器。
        if (!hasPendingStatus(documentRoot)) return;
        stopped = false;
        schedule();
    }

    function stop() {
        stopped = true;
        clear();
    }

    function onVisibilityChange() {
        if (documentRoot.hidden) {
            clear();
            return;
        }
        if (stopped) return;
        // 回到前台立刻补一拍，顺手换掉还没触发的定时器，免得刚回来又拍一次。
        clear();
        run();
    }

    browserWindow.addEventListener?.('visibilitychange', onVisibilityChange);

    return {
        start, stop, run,
        isPolling: () => !stopped,
        detach() {
            stop();
            browserWindow.removeEventListener?.('visibilitychange', onVisibilityChange);
        },
    };
}

/* 任务详情既可能是一整页，也可能是 detail_modal 里的片段：片段场景的原始地址
   记在 [data-generic-detail-body] 的 data-detail-url 上，页面地址在弹窗里没用。 */
async function refreshTaskDetail({documentRoot, browserWindow}) {
    const host = documentRoot.querySelector?.('#task-detail');
    if (!host) return;
    const box = host.closest?.('[data-generic-detail-body]');
    const source = box?.dataset?.detailUrl || browserWindow.location.href;
    const response = await browserWindow.fetch(source, {
        credentials: 'same-origin',
        headers: {'X-Requested-With': 'XMLHttpRequest'},
    });
    if (!response.ok) throw new Error(String(response.status));
    const parsed = new browserWindow.DOMParser().parseFromString(await response.text(), 'text/html');
    const fresh = parsed.getElementById('task-detail');
    if (!fresh) return;
    const parent = host.parentElement;
    /* boot.mjs 按宿主的 parentElement 找 data-vue-bootstrap 指的那份 JSON。
       只换宿主不换旁边的 detail-bootstrap，重挂出来的岛读的还是旧进度——
       看起来像"刷新没生效"。 */
    const incomingPayload = parsed.getElementById('detail-bootstrap');
    const currentPayload = parent?.querySelector?.('#detail-bootstrap');
    if (currentPayload && incomingPayload) {
        parent.replaceChild(documentRoot.importNode(incomingPayload, true), currentPayload);
    }
    host.replaceWith(documentRoot.importNode(fresh, true));
    // 等岛挂完再判断终态，否则读到的还是替换前那一版 DOM。
    await browserWindow.mountPages?.(parent || documentRoot);
}

function install(documentRoot, browserWindow) {
    const refresh = async () => {
        // 任务中心的面板由 task_center_tabs.js 换（它知道当前视图，还要重挂表格与弹窗）；
        // 这里只管详情宿主。
        await browserWindow.AppTaskCenterTabs?.refresh?.();
        await refreshTaskDetail({documentRoot, browserWindow});
    };
    const polling = createStatusPolling({browserWindow, documentRoot, refresh});
    const check = () => {
        // 只在"有未终态任务但没在轮"时启动；已经在轮就让它按自己的节奏走。
        if (polling.isPolling() || !hasPendingStatus(documentRoot)) return;
        polling.start();
    };
    // 切回前台、弹窗换了一份详情、面板切了视图，都可能重新出现"运行中"。
    browserWindow.addEventListener?.('visibilitychange', check);
    documentRoot.addEventListener?.('app:modal-updated', check);
    check();
    return {check, polling};
}

if (typeof window !== 'undefined') {
    window.AppTaskStatusPoll = {createStatusPolling, hasPendingStatus, refreshTaskDetail, install};
    if (typeof document !== 'undefined') {
        const boot = () => install(document, window);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot, {once: true});
        } else {
            boot();
        }
    }
}

if (typeof module !== 'undefined') {
    module.exports = {createStatusPolling, hasPendingStatus, refreshTaskDetail, install};
}
