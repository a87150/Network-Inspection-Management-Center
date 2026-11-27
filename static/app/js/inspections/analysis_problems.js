(function () {
    'use strict';

    function initAnalysisProblems(modal, fetcher) {
        if (!modal) return;
        const body = modal.querySelector('[data-problem-body]');
        const title = modal.querySelector('#analysisProblemsTitle');
        let generation = 0;
        let controller;

        async function load(url) {
            const current = ++generation;
            if (controller) controller.abort();
            controller = new AbortController();
            body.textContent = '正在加载问题明细…';
            try {
                const response = await fetcher(url, {
                    credentials: 'same-origin', signal: controller.signal,
                    headers: {'X-Requested-With': 'XMLHttpRequest'},
                });
                if (response.redirected) throw new Error('登录状态已失效，请刷新页面重新登录。');
                if (!response.ok) throw new Error('加载失败，请关闭弹窗后重新点击问题类型。');
                const html = await response.text();
                if (current === generation) {
                    body.innerHTML = html;
                    /* 这个片段里是一块空的 data-vue-page="analysis-problems" 岛，
                       行要客户端渲染。innerHTML 插入的 <script> 按 HTML 规范不会执行，
                       所以必须手动重挂——不挂就只剩「共 N 条」和一片空白，还不报错。
                       同一片段在任务详情里走的是 device_workspace 那条 mountPages 路径。 */
                    window.mountPages?.(body);
                }
            } catch (error) {
                if (current === generation && error.name !== 'AbortError') {
                    body.textContent = error.message || '加载失败，请稍后重试。';
                }
            }
        }

        modal.addEventListener('show.bs.modal', event => {
            const trigger = event.relatedTarget;
            if (!trigger || !trigger.dataset.problemUrl) return;
            title.textContent = trigger.dataset.problemLabel + '问题明细';
            return load(trigger.dataset.problemUrl);
        });
        modal.addEventListener('click', event => {
            const page = event.target.closest('[data-problem-page]');
            if (!page) return;
            event.preventDefault();
            return load(page.getAttribute('href'));
        });
        modal.addEventListener('hidden.bs.modal', () => {
            ++generation;
            if (controller) controller.abort();
            body.textContent = '';
        });
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = {initAnalysisProblems};
    if (typeof document !== 'undefined') {
        initAnalysisProblems(document.getElementById('analysisProblemsModal'), window.fetch.bind(window));
    }
}());
