"""巡检任务栏只剩一份实现：服务端输出 bootstrap JSON，表格由 Vue 岛渲染。

这里钉住三件事：JSON 能解析、行数据和 context 一致、服务端 HTML 里没有第二份表。
"""
import json
import re
from pathlib import Path

from django.test import TestCase
from django.urls import reverse

from net.models import InspectionProfile, TaskRun, TaskTargetRun
from tests.auth import login_reader

BOOTSTRAP = re.compile(
    r'<script type="application/json" data-taskbar-bootstrap>(.*?)</script>',
    re.S,
)
TEMPLATES = Path(__file__).resolve().parents[2] / 'inspections' / 'templates' / 'inspections'


class InspectionTaskbarIslandTests(TestCase):
    def setUp(self):
        login_reader(self.client)
        self.profile = InspectionProfile.objects.create(
            name='任务栏配置',
            device_type=InspectionProfile.DeviceType.SERVER,
            selected_items=['cpu'],
        )
        self.task = TaskRun.objects.create(
            task_type=TaskRun.TaskType.INSPECTION,
            source=TaskRun.Source.MANUAL,
            inspection_profile=self.profile,
            total_targets=1,
            target_scope_snapshot={'targets': [{'target_type': 'server', 'target_id': 'srv-1'}]},
        )
        TaskTargetRun.objects.create(
            task=self.task,
            target_type=TaskTargetRun.TargetType.SERVER,
            target_id='srv-1',
            status=TaskRun.Status.SUCCESS,
            result_snapshot={'status': TaskRun.Status.SUCCESS},
        )

    def test_record_page_feeds_the_vue_taskbar_from_serialized_rows(self):
        response = self.client.get(reverse('record_list', args=['servers']))
        html = response.content.decode(response.charset)

        self.assertContains(response, 'data-inspection-taskbar')
        # 服务端不再画表：行只存在于 bootstrap 里。
        self.assertNotIn('inspection-taskbar__row', html)
        match = BOOTSTRAP.search(html)
        self.assertIsNotNone(match, '任务栏 bootstrap JSON 缺失')
        bootstrap = json.loads(match.group(1))

        self.assertEqual([row['id'] for row in bootstrap['rows']], [str(self.task.pk)])
        self.assertEqual(
            bootstrap['rows'][0]['detail_url'],
            reverse('task_detail', args=[self.task.pk]),
        )
        for key in ('count', 'page', 'pages', 'sectionTitle', 'emptyTitle', 'selectedId'):
            self.assertIn(key, bootstrap)

    def test_no_second_server_side_taskbar_remains(self):
        self.assertFalse((TEMPLATES / 'taskbar.html').exists())
        body = (TEMPLATES / '_record_body.html').read_text(encoding='utf-8')
        self.assertNotIn("inspections/taskbar.html", body)
        self.assertIn('data-inspection-taskbar', body)
