"""Workspace action bars are per page now.

Each page renders its own fragment (devices/_actions_list.html, pc/_actions_pc.html,
network/_actions_network.html, server/_actions_server.html,
weakcurrent/_actions_weakcurrent.html, people/_actions_people.html,
inspections/_actions_records.html). This module only supplies the switches those
fragments share: whether the kind owns a device form, whether its inventory is
importable, and whether the issue-severity settings belong to it.
"""


def workspace_action_context(kind, *, back_url=''):
    """Flags the per-page action fragments read. Button sets live in the templates."""
    from assets.forms import DEVICE_KINDS
    from net.data_exchange.inventory_csv import IMPORTABLE_ENTITIES
    return {
        'action_kind': kind,
        'action_can_manage_devices': kind in DEVICE_KINDS,
        'action_can_import': kind in IMPORTABLE_ENTITIES,
        'action_issue_settings': kind == 'computers',
        'action_back_url': back_url,
    }
