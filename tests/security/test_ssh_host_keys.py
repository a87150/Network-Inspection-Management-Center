"""SSH 主机密钥策略：首次信任后锁定，指纹不符必须停。

设备口令是"一套传一套"的，这里放过一次就等于丢一片，所以测的都是拒绝路径。
"""
import paramiko
from django.test import TestCase

from net.infrastructure import host_keys
from net.models import SSHHostKey


class HostKeyPolicyTests(TestCase):
    def setUp(self):
        self._env = {}
        self._unset('NET_SSH_HOST_KEY_STRICT')

    def tearDown(self):
        import os

        for name, value in self._env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def _set(self, name, value):
        import os

        self._env.setdefault(name, os.environ.get(name))
        os.environ[name] = value

    def _unset(self, name):
        import os

        self._env.setdefault(name, os.environ.get(name))
        os.environ.pop(name, None)

    @staticmethod
    def _key():
        return paramiko.RSAKey.generate(2048)

    def test_first_connection_is_trusted_and_recorded(self):
        key = self._key()
        self.assertEqual(host_keys.verify('10.0.0.1', 22, key), 'trusted')
        row = SSHHostKey.objects.get(host='10.0.0.1', port=22)
        self.assertEqual(row.fingerprint, host_keys.fingerprint(key))
        self.assertEqual(row.source, SSHHostKey.Source.TOFU)

    def test_same_key_is_known_and_touches_verified_at(self):
        key = self._key()
        host_keys.verify('10.0.0.1', 22, key)
        self.assertEqual(host_keys.verify('10.0.0.1', 22, key), 'known')
        self.assertIsNotNone(SSHHostKey.objects.get().verified_at)

    def test_changed_key_is_rejected_even_without_strict_mode(self):
        host_keys.verify('10.0.0.1', 22, self._key())
        with self.assertRaises(host_keys.HostKeyChanged):
            host_keys.verify('10.0.0.1', 22, self._key())

    def test_strict_mode_refuses_unknown_host(self):
        self._set('NET_SSH_HOST_KEY_STRICT', '1')
        with self.assertRaises(host_keys.HostKeyError):
            host_keys.verify('10.0.0.2', 22, self._key())
        self.assertFalse(SSHHostKey.objects.filter(host='10.0.0.2').exists())

    def test_strict_mode_still_accepts_a_manually_trusted_host(self):
        self._set('NET_SSH_HOST_KEY_STRICT', '1')
        key = self._key()
        host_keys.trust('10.0.0.3', 22, key)
        self.assertEqual(host_keys.verify('10.0.0.3', 22, key), 'known')
        self.assertEqual(SSHHostKey.objects.get().source, SSHHostKey.Source.MANUAL)

    def test_forget_lets_a_replaced_device_be_trusted_again(self):
        host_keys.verify('10.0.0.1', 22, self._key())
        self.assertTrue(host_keys.forget('10.0.0.1', 22))
        self.assertEqual(host_keys.verify('10.0.0.1', 22, self._key()), 'trusted')

    def test_fingerprint_matches_openssh_shape(self):
        value = host_keys.fingerprint(self._key())
        self.assertTrue(value.startswith('sha256:'))
        self.assertFalse(value.endswith('='))
