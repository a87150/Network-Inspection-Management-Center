"""One Netmiko session per network target; Linux keeps its own SSH client."""
from net.infrastructure import host_keys

DEVICE_TYPES = {
    'cisco': 'cisco_ios', 'h3c': 'hp_comware', 'huawei': 'huawei',
    'ruijie': 'ruijie_os', 'generic': 'generic_termserver',
}


def device_type_for(vendor, protocol):
    """Netmiko ships a telnet driver for every vendor we map; SSH is the bare name."""
    return DEVICE_TYPES[vendor] + ('_telnet' if protocol == 'telnet' else '')


def connect_network(device, timeout, vendor):
    from netmiko import ConnectHandler

    protocol = getattr(device, 'effective_cli_protocol', 'ssh')
    port = getattr(device, 'effective_port', None) or device.port or (23 if protocol == 'telnet' else 22)
    arguments = dict(
        device_type=device_type_for(vendor, protocol), host=device.ip, port=port,
        username=device.username, password=device.password,
        conn_timeout=timeout, auth_timeout=timeout, banner_timeout=timeout,
        blocking_timeout=timeout, timeout=timeout, session_timeout=timeout,
        fast_cli=False, encoding='utf-8',
        disable_lf_normalization=True, session_log=None, auto_connect=False,
    )
    # Telnet has no SSH layer, so the key/agent switches would only be ignored.
    if protocol != 'telnet':
        # ssh_strict=False 会让 netmiko 退回 AutoAddPolicy，等于无条件信任对端；
        # 这里换成会比对指纹的策略，未知主机的处理方式由 host_keys 决定。
        arguments.update(read_timeout_override=timeout, use_keys=False,
                         allow_agent=False, ssh_strict=True)
    client = ConnectHandler(**arguments)
    # netmiko 只在 AutoAddPolicy 和 RejectPolicy 之间二选一，两个都不合用：
    # 前者谁来都信，后者每次都要人工录入。连接建立前换成会比对指纹的策略。
    if protocol != 'telnet':
        client.key_policy = host_keys.policy()
    try:
        client.establish_connection()
        client.session_preparation()
    except BaseException:
        client.disconnect()
        raise
    return client
