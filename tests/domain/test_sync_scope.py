"""域同步的停用范围。

搜索起点是 config.base_dn，所以「本次快照里没见到」只代表「不在这次的搜索范围
里」，不代表「对象被删了」。范围外的账号必须原地不动。
"""
from django.test import TestCase

from net.domain.sync import apply_domain_snapshot
from net.models import Domain_Account, Domain_Computer


def _user(login, dn):
    return {
        'sAMAccountName': login, 'distinguishedName': dn,
        'userAccountControl': '512', 'displayName': login,
    }


class InScopeDeactivationTests(TestCase):
    def setUp(self):
        self.base_dn = 'OU=Head', 'DC=corp', 'DC=local'
        self.base = 'OU=Head,DC=corp,DC=local'
        self.inside = Domain_Account.objects.create(
            login_name='inside', distinguished_name='CN=inside,' + self.base,
        )
        self.outside = Domain_Account.objects.create(
            login_name='outside', distinguished_name='OU=Branch,DC=corp,DC=local',
        )

    def test_accounts_outside_the_search_base_stay_active(self):
        apply_domain_snapshot(
            ([_user('inside', 'CN=inside,' + self.base)], [], []),
            base_dn=self.base,
        )

        self.inside.refresh_from_db()
        self.outside.refresh_from_db()
        self.assertTrue(self.inside.is_active, '范围内还在的对象不该被停用')
        self.assertTrue(self.outside.is_active, '范围外的账号不能因为收窄范围被停用')

    def test_accounts_missing_inside_the_search_base_are_deactivated(self):
        gone = Domain_Account.objects.create(
            login_name='gone', distinguished_name='CN=gone,' + self.base,
        )

        apply_domain_snapshot(
            ([_user('inside', 'CN=inside,' + self.base)], [], []),
            base_dn=self.base,
        )

        gone.refresh_from_db()
        self.assertFalse(gone.is_active, '范围内确实消失的账号应当停用')

    def test_without_a_base_dn_nothing_is_deactivated(self):
        """不知道自己在看哪的时候，宁可不动作。"""
        apply_domain_snapshot(([_user('inside', 'CN=inside,' + self.base)], [], []))

        self.inside.refresh_from_db()
        self.outside.refresh_from_db()
        self.assertTrue(self.inside.is_active)
        self.assertTrue(self.outside.is_active)

    def test_computers_follow_the_same_scope_rule(self):
        seen = Domain_Computer.objects.create(
            computer_name='PC-SEEN', distinguished_name='CN=PC-SEEN,' + self.base,
        )
        gone = Domain_Computer.objects.create(
            computer_name='PC-GONE', distinguished_name='CN=PC-GONE,' + self.base,
        )
        outside = Domain_Computer.objects.create(
            computer_name='PC-OUTSIDE', distinguished_name='OU=Branch,DC=corp,DC=local',
        )
        computers = [{'name': 'PC-SEEN', 'distinguishedName': 'CN=PC-SEEN,' + self.base}]

        apply_domain_snapshot(
            ([_user('inside', 'CN=inside,' + self.base)], computers, []),
            base_dn=self.base,
        )

        seen.refresh_from_db()
        gone.refresh_from_db()
        outside.refresh_from_db()
        self.assertTrue(seen.is_active, '范围内的对象还在')
        self.assertFalse(gone.is_active, '范围内确实消失的计算机应当停用')
        self.assertTrue(outside.is_active, '范围外的计算机同样不能被动')
