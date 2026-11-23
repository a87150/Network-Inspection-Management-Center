"""设备类型里的英文存量值统一成中文。

同一列里中英混存（access switch 和 接入 并列），筛选下拉出现两种写法。
这里按常见中文叫法归一，只改能一一对应的值，不改用户自己填的自由文本。
"""
from django.db import migrations

NETWORK_LABELS = {
    'AC': '无线控制器',
    'ac': '无线控制器',
    'ap': '无线接入点',
    'access switch': '接入交换机',
    'core switch': '核心交换机',
    'distribution switch': '汇聚交换机',
    'firewall': '防火墙',
    'router': '路由器',
}

WEAK_LABELS = {
    'NVR': '硬盘录像机',
    'broadcast': '广播',
    'camera': '摄像机',
    'environment': '环境监测',
    'intercom': '对讲',
    'printer': '打印机',
}


def to_chinese(apps, schema_editor):
    NetworkDevice = apps.get_model('net', 'Network_Device')
    WeakDevice = apps.get_model('net', 'WeakCurrentDevice')
    for model, labels in ((NetworkDevice, NETWORK_LABELS), (WeakDevice, WEAK_LABELS)):
        for old, new in labels.items():
            model.objects.filter(device_type=old).update(device_type=new)


class Migration(migrations.Migration):
    dependencies = [('net', '0073_tasktargetrun_outcome_key')]
    operations = [migrations.RunPython(to_chinese, migrations.RunPython.noop)]
