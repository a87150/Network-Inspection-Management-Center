"""把台账里的厂商与设备类型统一成代码。

这两个字段历史上是自由文本：录入时写过 'H3C'、'华三'、'交换机'、'核心交换机'，
而筛选器和表单按代码比较，同一个东西写成两三种样子就查不到、也筛不出来。
一次性洗干净，代码里就不再需要为历史值层层兼容。

不能反推原始写法（'H3C' 和 '华三' 都归成 h3c），所以反向是空操作。
"""

from django.db import migrations


VENDOR = {
    'huawei': 'huawei', '华为': 'huawei',
    'h3c': 'h3c', 'h3': 'h3c', '华三': 'h3c',
    'ruijie': 'ruijie', '锐捷': 'ruijie',
    'cisco': 'cisco', '思科': 'cisco',
    'sangfor': 'sangfor', '深信服': 'sangfor',
    'hikvision': 'hikvision', '海康': 'hikvision', '海康威视': 'hikvision',
    'dahua': 'dahua', '大华': 'dahua',
    'uniview': 'uniview', '宇视': 'uniview',
    'tiandy': 'tiandy', '天地伟业': 'tiandy',
    'zkteco': 'zkteco', '中控': 'zkteco', '中控智慧': 'zkteco',
    'generic': 'generic', '其他': 'generic', '其它': 'generic',
}

DEVICE_TYPE = {
    'switch': 'switch', '交换机': 'switch', '核心交换机': 'switch',
    '接入交换机': 'switch', '汇聚交换机': 'switch',
    'router': 'router', '路由器': 'router', '路由': 'router',
    'firewall': 'firewall', '防火墙': 'firewall',
    'ac': 'ac', '无线控制器': 'ac',
    'ac_gateway': 'ac_gateway', '上网行为管理': 'ac_gateway', '安全网关': 'ac_gateway',
    'ap': 'ap', '无线ap': 'ap', '无线接入点': 'ap',
    'nvr': 'nvr', '录像机': 'nvr', '硬盘录像机': 'nvr', 'dvr': 'nvr',
    'camera': 'camera', '监控': 'camera', '摄像头': 'camera', '摄像机': 'camera',
    'access': 'access', '门禁': 'access', '门禁控制器': 'access',
    '闸机': 'access', '门禁闸机': 'access',
    'intercom': 'intercom', '对讲': 'intercom',
    'broadcast': 'broadcast', '广播': 'broadcast',
    'printer': 'printer', '打印机': 'printer',
    'environment': 'environment', '温湿度计': 'environment', '温湿度传感器': 'environment',
    'linux': 'linux', 'windows': 'windows',
}


def _canonical(mapping, value):
    key = str(value or '').strip().casefold()
    return mapping.get(key, '')


def normalize_rows(model, field, mapping):
    """只动认得出的值：认不出的保留，那是用户真正的自由文本。"""
    updates = {}
    for pk, value in model.objects.values_list('pk', field):
        canonical = _canonical(mapping, value)
        if canonical and canonical != value:
            updates.setdefault(canonical, []).append(pk)
    for canonical, pks in updates.items():
        model.objects.filter(pk__in=pks).update(**{field: canonical})
    return sum(len(pks) for pks in updates.values())


def normalize(apps, schema_editor):
    from net.models import DeviceCollectionTemplate, Network_Device, WeakCurrentDevice

    for label, model in (
        ('网络设备厂商', Network_Device), ('弱电设备厂商', WeakCurrentDevice),
    ):
        normalize_rows(model, 'vendor', VENDOR)
    for label, model in (
        ('网络设备类型', Network_Device), ('弱电设备类型', WeakCurrentDevice),
    ):
        normalize_rows(model, 'device_type', DEVICE_TYPE)
    normalize_rows(DeviceCollectionTemplate, 'vendor', VENDOR)


class Migration(migrations.Migration):

    dependencies = [
        ('net', '0079_domain_allow_insecure_bind'),
    ]

    operations = [
        migrations.RunPython(normalize, migrations.RunPython.noop),
    ]
