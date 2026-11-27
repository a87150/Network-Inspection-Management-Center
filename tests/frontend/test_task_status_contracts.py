"""任务状态轮询与页签 ARIA 的模板/脚本契约。

这些缺陷都是「接线存在但没接上」：模板缺标记、脚本缺触发点，跑起来人眼看不出来。
把它们钉在源码上，改坏时测试先叫。
"""
from pathlib import Path

from django.test import SimpleTestCase

ROOT = Path(__file__).resolve().parents[2]


def _read(*parts):
    return (ROOT.joinpath(*parts)).read_text(encoding='utf-8')


class TaskStatusContractTests(SimpleTestCase):
    def test_task_center_tabs_control_the_pane_and_leave_the_keyboard_path_open(self):
        source = _read('inspections', 'templates', 'inspections', 'task_center.html')
        buttons = [line for line in source.splitlines() if 'data-center-tab=' in line]
        self.assertTrue(buttons)
        for line in buttons:
            self.assertIn('role="tab"', line, line)
        # 每个页签都要指向同一个面板，并且只有一个停在 Tab 序列里。
        self.assertIn('aria-controls="task-center-pane"', source)
        self.assertEqual(source.count('aria-controls="task-center-pane"'), 2)
        self.assertIn('tabindex="{% if view == \'tasks\' %}0{% else %}-1{% endif %}"', source)
        self.assertIn('tabindex="{% if view == \'errors\' %}0{% else %}-1{% endif %}"', source)
        self.assertIn('id="center-tab-tasks"', source)
        self.assertIn('id="center-tab-errors"', source)

    def test_pane_is_the_tabpanel_and_carries_the_pending_marker(self):
        source = _read('inspections', 'templates', 'inspections', '_task_center_pane.html')
        self.assertIn('id="task-center-pane"', source)
        self.assertIn('role="tabpanel"', source)
        self.assertIn('aria-labelledby="center-tab-{{ view }}"', source)
        self.assertIn('data-task-pending="{% if task_pending %}1{% endif %}"', source)

    def test_task_detail_host_carries_the_pending_marker(self):
        source = _read('inspections', 'templates', 'inspections', '_task_detail_body.html')
        self.assertIn('id="task-detail"', source)
        self.assertIn('data-task-pending="1"', source)

    def test_pending_flag_comes_from_active_statuses(self):
        source = _read('inspections', 'tasks.py')
        # 状态轮询的判据由服务端算：前端读徽章会早于 Vue 岛挂载，永远认为"没有运行中"。
        self.assertIn("context['task_pending'] = view == 'tasks' and bool(", source)
        self.assertIn("'task_pending': task.status in TaskRun.ACTIVE_STATUSES,", source)

    def test_tab_keyboard_navigation_is_implemented(self):
        source = _read('static', 'app', 'js', 'inspections', 'task_center_tabs.js')
        for key in ('ArrowRight', 'ArrowLeft', 'Home', 'End'):
            self.assertIn(key, source)
        # 面板刷新要给状态轮询用，否则任务跑完页面不会自己变。
        self.assertIn('AppTaskCenterTabs = {refresh', source)

    def test_status_polling_is_wired_into_every_page(self):
        base = _read('index', 'templates', 'common', 'base.html')
        self.assertIn('app/js/common/task_status_poll.js', base)
        source = _read('static', 'app', 'js', 'common', 'task_status_poll.js')
        self.assertIn("const PENDING_SELECTOR = '[data-task-pending=\"1\"]';", source)
        # 隐藏页面不排定时器、终态之后停：两条都要真的在代码里。
        self.assertIn('documentRoot.hidden', source)
        self.assertIn('visibilitychange', source)


class DeviceViewTabCleanupTests(SimpleTestCase):
    def test_dead_view_tab_script_is_gone_and_unreferenced(self):
        self.assertFalse(
            (ROOT / 'static' / 'app' / 'js' / 'devices' / 'view_tabs.js').exists(),
            'view_tabs.js 整块死代码：[data-view-tab] 在任何模板里都不存在',
        )
        for path in ROOT.rglob('*.html'):
            if 'runtime' in path.parts:
                continue
            source = path.read_text(encoding='utf-8', errors='ignore')
            self.assertNotIn('view_tabs.js', source, path)
            self.assertNotIn('data-view-tab', source, path)
