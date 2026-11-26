"""Non-secret enqueue-time routing; credentials and revocation remain live."""
from net.models import AlertPolicy, ComputerAnalysisProfile


def snapshot_routing(profile):
    field = 'analysis_profile' if isinstance(profile, ComputerAnalysisProfile) else 'inspection_profile'
    policy = AlertPolicy.objects.filter(**{field: profile}).first()
    default = AlertPolicy.objects.filter(default_slot=AlertPolicy.DEFAULT_SLOT).first()
    mode = policy.mode if policy else 'inherit'
    effective = policy if mode == 'override' else default
    routes = []
    if effective is not None:
        # 模板和渠道的配对在策略上（AlertPolicyRoute）。这里把配对一起冻结：
        # 任务跑起来之后改策略或改模板绑定，都不会影响这一轮已经在路上的通知。
        routes = [
            {'channel_id': str(route.channel_id),
             'template_id': str(route.template_id),
             'trigger': route.trigger}
            for route in effective.routes.filter(channel__is_enabled=True)
            .order_by('channel_id', 'trigger')
        ]
    return {'mode': mode, 'policy_id': str(policy.pk) if policy else None,
            'effective_policy_id': str(effective.pk) if effective else None,
            'channel_ids': [str(pk) for pk in effective.channels.filter(is_enabled=True)
                            .order_by('pk').values_list('pk', flat=True)] if effective else [],
            'routes': routes}
