import os, django
os.environ['DB_NAME'] = 'net-test'
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'net.settings')
django.setup()
from django.test import Client
from django.contrib.auth import get_user_model
c = Client(SERVER_NAME='127.0.0.1')
u = get_user_model().objects.filter(is_superuser=True).first()
c.force_login(u)
r = c.get('/assets/people/')
print('people', r.status_code, sorted(r.context['overview'].keys()))
r2 = c.get('/assets/networks/')
print('networks', r2.status_code, sorted(r2.context['overview'].keys()))