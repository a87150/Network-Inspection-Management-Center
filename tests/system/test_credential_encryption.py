"""凭证加解密：看起来像密文的明文口令也必须被加密。

对应 docs/functional-review-2.32.md 的 A9。
"""
from django.test import SimpleTestCase, override_settings

from net.infrastructure.credentials import decrypt, encrypt, looks_encrypted

KEY = 'V6NyMLdzoMKswUV33psN2GpZlkAhw4y8ao_0J2lCp7E='


@override_settings(DEVICE_BACKUP_ENCRYPTION_KEY=KEY)
class CredentialPrefixTests(SimpleTestCase):
    def test_plaintext_that_starts_like_a_token_still_gets_encrypted(self):
        # 真实口令可能恰好以 gAAAA 开头，不能因此跳过加密。
        plain = 'gAAAA-should-not-be-treated-as-ciphertext'
        self.assertTrue(looks_encrypted(plain))

        stored = encrypt(plain)

        self.assertNotEqual(stored, plain)
        self.assertEqual(decrypt(stored), plain)

    def test_real_ciphertext_is_left_alone(self):
        """已经是本 key 的密文，重复加密会把它变成解读不了的字符串。"""
        once = encrypt('s3cret')
        twice = encrypt(once)

        self.assertEqual(twice, once)
        self.assertEqual(decrypt(twice), 's3cret')

    def test_empty_and_none_pass_through(self):
        self.assertEqual(encrypt(''), '')
        self.assertEqual(encrypt(None), None)
        self.assertEqual(decrypt(''), '')
        self.assertEqual(decrypt(None), None)
