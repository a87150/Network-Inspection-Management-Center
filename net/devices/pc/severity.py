"""PC finding health is independent from analysis execution status."""

LEVELS = {'info': '提示', 'warning': '警告', 'critical': '严重'}
RANK = {'info': 0, 'warning': 1, 'critical': 2}

# 这几项一条就够严重，不靠标题文字判断——设备侧叫「温度异常」、PC 侧叫
# 「CPU温度问题」，同一种物理风险在两个出口拿到两个级别。
CRITICAL_ITEMS = frozenset({'domain_trust', 'cpu_health', 'temperature'})


def grade_issue(issue, *, overrides=None):
    result = dict(issue)
    title = str(result.get('问题类型', ''))
    from net.inspections.issues import RULES, PROJECT_RULES
    item = str(result.get('analysis_item') or '')
    rules = PROJECT_RULES.get(result.get('project'), RULES)
    result['category'] = rules.get(item, ('其他', ''))[0]
    missing = result.get('data_state') in {'missing', 'unknown', 'partial', 'empty'} or '数据缺失' in title
    rule_key = f'missing.{item}' if missing else item
    result['rule_key'] = rule_key
    if result.get('severity') in LEVELS:
        severity = result['severity']
    elif missing:
        severity = 'info'
    elif item in CRITICAL_ITEMS or title in {'域信任问题', 'CPU温度问题'}:
        severity = 'critical'
    else:
        severity = result.get('severity', 'warning')
    if severity not in LEVELS:
        severity = 'warning'
    if overrides is not None and overrides.get(rule_key) in LEVELS:
        severity = overrides[rule_key]
    result.update(severity=severity, severity_label=LEVELS[severity])
    return result


def severity_counts(issues):
    counts = dict.fromkeys(LEVELS, 0)
    for issue in issues:
        counts[grade_issue(issue)['severity']] += 1
    return counts
