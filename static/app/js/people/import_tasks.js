function createPeopleTaskController({document, window, fetchImpl = fetch, pollIntervalMs = 3000, maxBackoffMs = 60000}) {
    const root = document.querySelector('[data-people-task-notifications]');
    if (!root) return {start() {}, stop() {}, async poll() {}};
    const runningList = root.querySelector('[data-people-running-list]');
    const modalElement = root.querySelector('#peopleTaskCompletionModal');
    const messageElement = root.querySelector('[data-people-completion-message]');
    const jumpElement = root.querySelector('[data-people-completion-jump]');
    const closeElements = root.querySelectorAll
        ? Array.from(root.querySelectorAll('[data-people-completion-close]'))
        : [root.querySelector('[data-people-completion-close]')].filter(Boolean);
    const shownTerminal = new Set();
    /* 已经进终态、但还没轮到展示的任务。一轮里两个任务同时完成是常态：
       以前 showTerminal 只 find 第一个就 return，其余的几个被 shownTerminal
       记成"已提示"却从没显示过——用户永远看不到它们的结果。 */
    const terminalQueue = [];
    let timer = null;
    let currentTerminal = null;
    /* 连续失败次数，用来算退避间隔；成功一次就清零。 */
    let failures = 0;

    async function postAcknowledgement(task, kind) {
        const response = await fetchImpl(task.ack_url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'X-CSRFToken': root.dataset.csrfToken,
            },
            body: `kind=${encodeURIComponent(kind)}`,
        });
        if (!response.ok) throw new Error('acknowledgement failed');
    }

    async function dismissRunning(task) {
        await postAcknowledgement(task, 'running');
        await poll();
    }

    async function acknowledgeTerminal(task = currentTerminal, {advance = true} = {}) {
        if (!task) return;
        await postAcknowledgement(task, 'terminal');
        // 只有正在展示的那个被确认才轮得到下一个：工作流里的行内提示（task 另有其人）
        // 确认完不该把弹窗队列顶掉。
        if (task !== currentTerminal) return;
        currentTerminal = null;
        // 队列里的下一个在这里就顶上来，不等下一次轮询——任务全都终态后轮询本来就停了。
        // 打开结果页的那条路径要等结果展示完再推进，否则会和新内容抢同一个模态位。
        if (advance) showNextTerminal();
    }

    function renderRunning(tasks) {
        const notices = tasks.filter(task => task.show_running).map(task => {
            const alert = document.createElement('div');
            alert.className = 'alert alert-info d-flex flex-wrap align-items-center justify-content-between gap-2';
            alert.textContent = task.message;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-sm btn-outline-primary';
            button.textContent = '知道了，本次不再显示';
            button.addEventListener('click', () => dismissRunning(task));
            alert.append(button);
            return alert;
        });
        runningList.replaceChildren(...notices);
    }

    /* 导入流程还开着：就地给提示，几个任务完成就给几条，不跟弹窗抢同一个位置。 */
    function showInlineTerminal(task, workflow) {
        const notice = document.createElement('div');
        notice.className = 'alert alert-info';
        notice.textContent = task.message + ' ';
        const link = document.createElement('a');
        link.href = task.jump_url;
        link.textContent = '查看结果 / 继续下一步';
        link.addEventListener('click', () => acknowledgeTerminal(task));
        notice.append(link);
        workflow.querySelector('.modal-body').prepend(notice);
    }

    function showNextTerminal() {
        // 一次只展开一个：模态弹窗被下一个顶掉，前一个的结果就再也回不去了。
        if (currentTerminal || !terminalQueue.length) return;
        currentTerminal = terminalQueue.shift();
        messageElement.textContent = currentTerminal.message;
        jumpElement.href = currentTerminal.jump_url;
        window.bootstrap?.Modal.getOrCreateInstance(modalElement).show();
    }

    function collectTerminals(tasks) {
        const workflow = document.querySelector('#importModal.show, #peoplePreviewModal.show');
        tasks.filter(task => task.show_terminal && !shownTerminal.has(task.id)).forEach(task => {
            shownTerminal.add(task.id);
            if (workflow) {
                showInlineTerminal(task, workflow);
                return;
            }
            terminalQueue.push(task);
        });
        showNextTerminal();
    }

    function schedule(delay) {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(poll, delay);
    }

    /* 失败一次不代表任务没了：后端重启、反向代理 502、手机切网都会让某一次查询失败。
       以前 catch 里直接 timer = null，轮询从此永久停摆——导入完成、结果可以查看时，
       页面再也不自己发现。改成指数退避（封顶 maxBackoffMs），成功一次就回到正常节奏。 */
    function retryDelay() {
        return Math.min(pollIntervalMs * 2 ** Math.max(failures - 1, 0), maxBackoffMs);
    }

    async function poll() {
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
        try {
            const response = await fetchImpl(root.dataset.statusUrl, {
                credentials: 'same-origin', headers: {'Accept': 'application/json'},
            });
            if (!response.ok) throw new Error('status failed');
            const payload = await response.json();
            const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
            failures = 0;
            renderRunning(tasks);
            collectTerminals(tasks);
            if (tasks.some(task => task.status === 'queued' || task.status === 'running')) {
                schedule(pollIntervalMs);
            }
        } catch (_error) {
            failures += 1;
            schedule(retryDelay());
        }
    }

    function start() { poll(); }
    function stop() {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
    }

    /* 后台标签页的定时器会被浏览器节流甚至冻结，网络恢复后也没人叫醒它：
       页面重新可见、网络重新上线时立刻补一拍，不等残留的那次定时。 */
    function resume() {
        failures = 0;
        poll();
    }
    document.addEventListener?.('visibilitychange', () => {
        if (!document.hidden) resume();
    });
    window.addEventListener?.('online', resume);

    closeElements.forEach(element => {
        element.addEventListener('click', () => acknowledgeTerminal());
    });
    /* 结果页本身是带 auto-open 预览弹窗的整页；只把那个弹窗取回来放进当前页，
       地址栏和列表都不动。 */
    async function showResultModal(task) {
        const response = await fetchImpl(task.jump_url, {
            credentials: 'same-origin', headers: {'X-Requested-With': 'XMLHttpRequest'},
        });
        if (!response.ok) throw new Error('result page failed');
        const page = new window.DOMParser().parseFromString(await response.text(), 'text/html');
        const incoming = page.querySelector('#peoplePreviewModal');
        if (!incoming) throw new Error('result modal missing');
        const existing = document.querySelector('#peoplePreviewModal');
        let resultModal = existing;
        if (resultModal) {
            const current = resultModal.querySelector('.modal-content');
            const fresh = incoming.querySelector('.modal-content');
            if (current && fresh) current.replaceWith(fresh.cloneNode(true));
        } else {
            resultModal = incoming.cloneNode(true);
            (document.body || document.documentElement).appendChild(resultModal);
        }
        window.bootstrap?.Modal.getOrCreateInstance(resultModal).show();
        document.dispatchEvent?.(new window.CustomEvent('app:modal-updated', {detail: {modal: resultModal}}));
    }

    async function followTerminalResult(event) {
        event.preventDefault();
        const task = currentTerminal;
        if (!task) return;
        const workflow = document.querySelector('#importModal.show, #peoplePreviewModal.show');
        try {
            // 先不推进队列：下面这些 hide / show 都要用同一个模态位。
            await acknowledgeTerminal(task, {advance: false});
        } catch (_error) {
            messageElement.textContent = '结果确认失败，请重试后再查看。';
            return;
        }
        try {
            if (workflow) return;
            window.bootstrap?.Modal.getInstance?.(modalElement)?.hide?.();
            await showResultModal(task);
        } catch (_error) {
            messageElement.textContent = '结果页加载失败，请稍后重试。';
        } finally {
            // 结果页开不了也不能把队列卡死：这条任务的提示已经给过了，轮到下一个。
            showNextTerminal();
        }
    }
    jumpElement?.addEventListener('click', followTerminalResult);
    return {start, stop, poll, dismissRunning, acknowledgeTerminal};
}

if (typeof module !== 'undefined') module.exports = {createPeopleTaskController};

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const controller = createPeopleTaskController({document, window});
        controller.start();
        document.addEventListener('people:operation-submitted', () => controller.poll());
    });
}
