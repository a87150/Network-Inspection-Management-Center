import os, django
os.environ['DB_NAME']='net-test'
os.environ.setdefault('DJANGO_SETTINGS_MODULE','net.settings')
django.setup()
from django.test.utils import setup_test_environment
setup_test_environment()
from django.test import Client
from django.contrib.auth import get_user_model
c = Client(SERVER_NAME='127.0.0.1')
c.force_login(get_user_model().objects.filter(is_superuser=True).first())
r = c.get('/assets/computers/?object=analyses')
b = r.content.decode()
print('status', r.status_code)
for k in ['暂无巡检任务','暂无日志分析任务','任务概况','最新任务统计','问题类型分布','巡检任务栏']:
    print(' ', k, b.count(k))
i = b.find('巡检任务栏')
print('--- taskbar area ---')
print(b[i:i+400].replace('\n',' ')[:400] if i>0 else 'not found')
