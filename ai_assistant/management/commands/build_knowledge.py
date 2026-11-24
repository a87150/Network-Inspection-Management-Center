"""把仓库里的设备、模板、告警定义抽成知识库条目，并写入向量。

条目来源见 docs/ai-assistant-design.md 第 6 节。抽取全部走 Django 模型自省和模块常量，
不手写文案：字段改了、choices 加了一项，重跑一次就同步。
"""
from collections import Counter
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from ai_assistant.client import AiNotConfigured, AiUpstreamError, embed
from ai_assistant.models import KnowledgeDoc
from net.devices.collection_profiles import ALIASES, SUBTYPES, TYPE_ALIASES, VENDORS
from net.devices.network import default_profiles
from net.inspections.issues import METRIC_DEFAULTS, PC_THRESHOLD_FIELDS, PROJECT_LABELS, PROJECT_RULES
from net.inspections.selection import (
    LINUX_FIELDS, NETWORK_FUNCTION_ITEMS, SECURITY_FIELDS, WINDOWS_FIELDS,
)
from net.models import (
    AlertChannel, AlertDelivery, AlertEvent, AlertNotificationTemplate, AlertPolicy,
    AlertState, Computer, DeviceCollectionTemplate, MaintenanceWindow, Network_Device,
    Server, WeakCurrentDevice,
)
from net.models.alerts import MAX_DELIVERY_ATTEMPTS
from net.models.collection_profiles import KINDS

BATCH_SIZE = 32
DATA_FILE = Path(__file__).resolve().parents[2] / "data" / "troubleshooting.md"

_TYPE_LABELS = {
    "CharField": "短文本", "TextField": "长文本", "IntegerField": "整数",
    "PositiveIntegerField": "正整数", "PositiveSmallIntegerField": "小整数",
    "BigIntegerField": "整数", "DecimalField": "小数", "BooleanField": "开关",
    "DateTimeField": "时间", "DateField": "日期", "UUIDField": "UUID",
    "JSONField": "JSON", "URLField": "URL", "EmailField": "邮箱",
}

DEVICE_MODELS = (
    (Computer, "计算机终端", "Windows 终端台账，由 PC 采集脚本上报机器信息与登录用户。"),
    (Network_Device, "网络设备", "交换机、路由器、AC、AP、防火墙等，按 SSH 命令行或 SNMP 采集，也可走深信服 AC Open API。"),
    (Server, "服务器", "Linux 与 Windows 服务器巡检对象，Linux 走 SSH，Windows 走 HTTP 采集端。"),
    (WeakCurrentDevice, "弱电设备", "监控、门禁、广播、打印、环境监测等低电压系统设备。"),
)


def _doc(title, content, category):
    return {"title": title, "content": content.strip(), "category": category}


def _describe_field(field):
    if field.is_relation:
        kind = "外键 → %s" % field.related_model._meta.object_name
    else:
        kind = _TYPE_LABELS.get(field.get_internal_type(), field.get_internal_type())
    notes = []
    if getattr(field, "primary_key", False):
        notes.append("主键")
    if getattr(field, "unique", False) and not getattr(field, "primary_key", False):
        notes.append("唯一")
    if getattr(field, "null", False) and not getattr(field, "primary_key", False):
        notes.append("可空")
    if getattr(field, "blank", False):
        notes.append("可留空")
    label = field.verbose_name
    # 没写 verbose_name 时 Django 会按字段名自动生成英文说明（device_name → device name），
    # 这种噪音对检索没帮助，只留人工写的中文说明。
    if label and str(label) not in (field.name, field.name.replace("_", " ")):
        notes.append(str(label))
    line = "- %s（%s）" % (field.name, kind)
    if notes:
        line += "：" + "，".join(notes)
    choices = getattr(field, "flatchoices", None)
    if choices:
        line += "；取值 " + "、".join("%s=%s" % (value, label) for value, label in choices)
    return line


def _describe_model(model, summary):
    meta = model._meta
    lines = ["模型 %s，表 %s。%s" % (meta.object_name, meta.db_table, summary), ""]
    # Django 会给没有 docstring 的模型自动塞一行 "ClassName(字段1, 字段2, ...)"，
    # 那不是人写的说明，进向量只会污染语义；按生成格式精确比对后丢掉。
    generated = "%s(%s)" % (meta.object_name, ", ".join(field.name for field in meta.fields))
    doc = (model.__dict__.get("__doc__") or "").strip()
    if doc and doc != generated:
        lines.extend([doc, ""])
    lines.append("字段：")
    lines.extend(_describe_field(field) for field in meta.fields)
    uniques = [
        "、".join(constraint.fields)
        for constraint in meta.constraints
        if getattr(constraint, "fields", None)
    ]
    if uniques:
        lines.extend(["", "联合唯一约束：" + "；".join(uniques)])
    return "\n".join(lines)


def _device_docs():
    return [
        _doc("设备类型与字段：%s" % name, _describe_model(model, summary), "设备类型与字段")
        for model, name, summary in DEVICE_MODELS
    ]


def _vocabulary_docs():
    vendor_lines = ["设备类别与可选厂商。kind 是台账和采集模板共用的类别键。", ""]
    for kind, label in KINDS:
        options = VENDORS.get(kind) or []
        if options:
            vendor_lines.append("- %s（kind=%s）：%s" % (
                label, kind, "、".join("%s=%s" % pair for pair in options)))
        else:
            vendor_lines.append("- %s（kind=%s）：不区分厂商，按操作系统（linux / windows）分类。" % (label, kind))

    subtype_lines = ["设备类型代码。台账里 device_type 存代码，界面上显示中文。", ""]
    for kind, label in KINDS:
        options = [pair for pair in SUBTYPES.get(kind, ()) if pair[0]]
        subtype_lines.append("- %s（kind=%s）：%s" % (
            label, kind, "、".join("%s=%s" % (code, text) for code, text in options)))

    alias_lines = ["", "录入时接受的中文别名会被归一成代码："]
    alias_lines.append("- 厂商：" + "、".join("%s→%s" % pair for pair in ALIASES.items()))
    alias_lines.append("- 设备类型：" + "、".join("%s→%s" % pair for pair in TYPE_ALIASES.items()))
    return [
        _doc("设备类型与字段：设备类别与厂商代码", "\n".join(vendor_lines), "设备类型与字段"),
        _doc("设备类型与字段：设备类型代码对照", "\n".join(subtype_lines + alias_lines), "设备类型与字段"),
    ]


def _template_docs():
    content = _describe_model(
        DeviceCollectionTemplate,
        "可复用的采集配置，同厂商同类型的多台设备共用一个模板，设备侧再挂绑定做个别覆盖。",
    )
    content += """

继承规则（保存时校验）：
- 基础模板：填厂商，subtype 为空，没有父模板。
- 类型模板：继承同类别同厂商的基础模板，subtype 填具体设备类型。
- 系统版本模板：仅网络设备可用，version_match 填版本关键字；父模板必须是同厂商同类型的类型模板，版本模板不能再当父模板。
- 模板不能继承自身或形成循环。
- 已经有子模板时，不能把父模板改成别的类别、厂商或设备类型。
- 同一组（kind、vendor、subtype、version_match）只允许一条模板。
- 服务器模板只按操作系统分类，不配置厂商。
- SNMP 凭据不允许写进模板，必须放在设备基本配置或绑定的独立密码字段里。
"""
    return [_doc("巡检模板：采集模板与继承规则", content, "巡检模板")]


def _command_docs():
    docs = []
    for vendor, label in default_profiles.BRANDS.items():
        rules = default_profiles.function_rules(vendor)
        lines = ["%s（vendor=%s）的功能项目命令与默认采集方式。" % (label, vendor), ""]
        for item, commands in rules["commands"].items():
            lines.append("- %s：%s" % (NETWORK_FUNCTION_ITEMS.get(item, item), " / ".join(commands)))
        methods = rules.get("item_methods") or {}
        if methods:
            lines.extend(["", "默认采集方式：" + "、".join(
                "%s=%s" % (NETWORK_FUNCTION_ITEMS.get(key, key), value) for key, value in methods.items())])
        docs.append(_doc("巡检模板：%s 巡检命令" % label, "\n".join(lines), "巡检模板"))
    return docs


def _inspection_docs():
    function_lines = ["网络设备可以单独开关的功能项目，对应各自的采集命令与解析规则。", ""]
    function_lines.extend("- %s（item=%s）" % (label, item) for item, label in NETWORK_FUNCTION_ITEMS.items())
    function_lines.extend([
        "",
        "拓扑发现（LLDP/CDP）支持三种采集方式：snmp 走 LLDP MIB，ssh 走命令，auto 先用 SNMP 再用 SSH 补齐。",
    ])
    docs = [_doc("巡检模板：网络设备功能项目", "\n".join(function_lines), "巡检模板")]

    for title, mapping, note in (
        ("Linux 服务器", LINUX_FIELDS, "Linux 经 SSH 采集"),
        ("Windows 终端", WINDOWS_FIELDS, "Windows 由 HTTP 采集端上报"),
        ("弱电设备", SECURITY_FIELDS, "弱电设备按采集端返回的 JSON 取值"),
    ):
        lines = ["%s 的巡检项目与采集字段对应关系。%s。" % (title, note), ""]
        lines.extend("- %s → %s" % (item, "、".join(fields)) for item, fields in mapping.items())
        docs.append(_doc("巡检模板：%s字段映射" % title, "\n".join(lines), "巡检模板"))

    threshold_lines = ["巡检项目的默认告警阈值，可在项目策略里覆盖。", "", "指标类阈值（百分比）："]
    for project, defaults in METRIC_DEFAULTS.items():
        label = PROJECT_LABELS.get(project, project)
        rules = PROJECT_RULES.get(project, {})
        items = ["%s %s%%" % (rules.get(key, (None, key))[1], value) for key, value in defaults.items()]
        threshold_lines.append("- %s：%s" % (label, "、".join(items)))
    threshold_lines.extend(["", "PC 日志分析的阈值字段：", ""])
    for key, (rule, label, ceiling) in PC_THRESHOLD_FIELDS.items():
        threshold_lines.append("- %s：%s，上限 %s" % (label, key, ceiling))
    docs.append(_doc("巡检模板：巡检默认阈值", "\n".join(threshold_lines), "巡检模板"))
    return docs


def _alert_docs():
    policy = _describe_model(
        AlertPolicy, "默认策略管全局，项目策略按巡检或分析项目继承默认策略或整组覆盖。",
    )
    policy += """

策略规则：
- 默认策略必须是覆盖模式，不能关联项目配置；全平台只有一条。
- 项目策略必须且只能关联一个项目（巡检项目配置或 PC 分析配置）。
- 继承模式不能自己选渠道，实际发往默认策略上启用的渠道。
- 覆盖模式至少要选一个渠道。
- 策略保存后归属关系不能修改。
"""
    state = _describe_model(
        AlertState, "按项目和目标记录每类异常当前是正常还是异常，用来判断要不要发告警和恢复通知。",
    )
    state += """

去重规则：同一个项目、目标、finding_key 只保留一条状态记录；finding_key 是稳定的异常类别键，
同一目标同一类异常反复出现时更新状态而不是重复告警。
"""
    event = _describe_model(
        AlertEvent, "一次异常、一次恢复或一次任务总结产生的告警事件，是投递记录的上游。",
    )
    event += """

事件类型：abnormal 异常告警、recovery 恢复通知、summary 任务总结。
投递状态：pending 待发送、sending 发送中、delivered 已送达、recorded 仅记录、partial 部分送达、failed 发送失败。
"""
    delivery = _describe_model(
        AlertDelivery, "事件投给每个渠道的一条发送记录，带重试次数与租约。",
    )
    delivery += """

投递规则：
- 同一事件同一渠道只有一条投递记录。
- max_attempts 默认 3，上限 %d 次（MAX_DELIVERY_ATTEMPTS）；attempt_count 不能超过 max_attempts。
- 状态为 retry 必须记录 next_attempt_at，状态为 sending 必须持有租约（lease_token 与 lease_expires_at）。
- 状态为 sent 必须记录 delivered_at。
""" % MAX_DELIVERY_ATTEMPTS
    window = _describe_model(
        MaintenanceWindow, "计划变更窗口。窗口生效期间目标设备的告警不投递，但记录照样保留。",
    )
    window += """

窗口规则：ends_at 必须晚于 starts_at；窗口只对指定 target_type 与 target_id 的那台设备生效；
窗口内的告警记录保持待发送状态，不删除，历史里能查到当时触发了什么、为什么没发出去。
"""
    template = _describe_model(
        AlertNotificationTemplate, "任务总结通知的标题与正文模板。",
    )
    template += "\n\n模板规则：key 只支持 task_summary；mode 取 compact（简洁）或 detailed（详细）。"
    return [
        _doc("告警规则：告警渠道", _describe_model(
            AlertChannel, "告警发往哪里：飞书和钉钉走群机器人 webhook，邮件走 SMTP。"), "告警规则"),
        _doc("告警规则：告警策略与继承", policy, "告警规则"),
        _doc("告警规则：告警状态与去重", state, "告警规则"),
        _doc("告警规则：告警事件", event, "告警规则"),
        _doc("告警规则：告警投递与重试", delivery, "告警规则"),
        _doc("告警规则：维护窗口", window, "告警规则"),
        _doc("告警规则：通知模板", template, "告警规则"),
    ]


def _troubleshooting_docs():
    if not DATA_FILE.exists():
        return []
    text = DATA_FILE.read_text(encoding="utf-8")
    docs = []
    for chunk in text.split("\n## ")[1:]:
        heading, _, body = chunk.partition("\n")
        title = heading.strip()
        body = body.strip()
        if title and body:
            docs.append(_doc("故障处置：%s" % title, body, "故障处置"))
    return docs


def collect_docs():
    docs = []
    docs.extend(_device_docs())
    docs.extend(_vocabulary_docs())
    docs.extend(_template_docs())
    docs.extend(_command_docs())
    docs.extend(_inspection_docs())
    docs.extend(_alert_docs())
    docs.extend(_troubleshooting_docs())
    return docs


def _uuid_param(value):
    """UUID 主键在 MySQL/MariaDB 和 SQLite 上存的是 32 位无横线 hex。

    原生 SQL 不经过 UUIDField 的转换，按 str(uuid) 传会命中 0 行而且不报错。
    """
    if connection.features.has_native_uuid_field:
        return str(value)
    return value.hex


def _embed_text(doc):
    # 标题一起嵌：只嵌正文时，「告警渠道怎么配」这类短问句和长正文的相似度会被稀释。
    return "%s\n%s" % (doc.title, doc.content)


def _embed_individually(batch, failed):
    results = []
    consecutive = 0
    for index, doc in enumerate(batch):
        try:
            vectors = embed([_embed_text(doc)])
        except (AiUpstreamError, AiNotConfigured) as error:
            failed.append((doc.title, str(error)[:120]))
            consecutive += 1
            if consecutive >= 3:
                # 连续三条都失败，基本上是上游不可用，继续逐条只是白等超时。
                for rest in batch[index + 1:]:
                    failed.append((rest.title, "上游连续失败，本批剩余条目未重试"))
                break
            continue
        consecutive = 0
        if len(vectors) != 1:
            failed.append((doc.title, "返回的向量条数不是 1"))
            continue
        results.append((doc, vectors[0]))
    return results


def _embed_batch(batch, failed):
    try:
        vectors = embed([_embed_text(doc) for doc in batch])
    except (AiUpstreamError, AiNotConfigured):
        # 整批失败分不清是哪一条的问题（超长、上游偶发 5xx），逐条重试定位。
        return _embed_individually(batch, failed)
    if len(vectors) != len(batch):
        return _embed_individually(batch, failed)
    return list(zip(batch, vectors))


def _store(doc, vector, failed):
    expected = settings.AI_CONFIG["EMBED_DIMS"]
    if len(vector) != expected:
        failed.append((doc.title, "向量维度 %d，列定义要求 %d" % (len(vector), expected)))
        return False
    literal = "[" + ",".join(repr(float(value)) for value in vector) + "]"
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE ai_assistant_knowledgedoc SET embedding = VEC_FromText(%s), embedded_at = NOW() WHERE id = %s",
            [literal, _uuid_param(doc.pk)],
        )
    return True


def _sync(docs, rebuild, stdout):
    if rebuild:
        # 表由本命令独占维护：先清空，避免源码里已删掉的模型或规则在库里留下僵尸条目。
        # ponytail: 手工往这张表加的行也会一起没了；要保住手工条目得先加来源字段，眼下不值得。
        removed = KnowledgeDoc.objects.all().delete()[0]
        stdout.write("全量重建：清空 %s 条旧条目。" % removed)
        existing = {}
    else:
        existing = {doc.title: doc for doc in KnowledgeDoc.objects.all()}
        titles = {doc["title"] for doc in docs}
        stale = [title for title in existing if title not in titles]
        if stale:
            KnowledgeDoc.objects.filter(title__in=stale).delete()
            stdout.write("清理 %s 条源码里已不存在的旧条目。" % len(stale))
            for title in stale:
                existing.pop(title, None)

    pending = []
    skipped = 0
    for item in docs:
        current = existing.get(item["title"])
        if current is None:
            doc = KnowledgeDoc(title=item["title"], content=item["content"], category=item["category"])
            doc.save()
            pending.append(doc)
            continue
        if (current.content == item["content"] and current.category == item["category"]
                and current.embedded_at is not None):
            skipped += 1
            continue
        current.content = item["content"]
        current.category = item["category"]
        current.embedded_at = None
        current.save(update_fields=["content", "category", "embedded_at"])
        pending.append(current)
    return pending, skipped


class Command(BaseCommand):
    help = "从仓库现有定义抽取知识条目写入知识库，并计算 embedding。"

    def add_arguments(self, parser):
        parser.add_argument(
            "--rebuild", action="store_true",
            help="清空后全量重建；默认只处理新增条目和内容变了的条目",
        )

    def handle(self, *args, **options):
        config = getattr(settings, "AI_CONFIG", None) or {}
        if not config.get("BASE_URL") or not config.get("API_KEY"):
            raise CommandError(
                "未配置 AI_BASE_URL / AI_API_KEY：入库每条都要调 embedding 接口，"
                "请在环境变量里配好后再跑。"
            )

        docs = collect_docs()
        duplicated = [
            title for title, count in Counter(doc["title"] for doc in docs).items() if count > 1
        ]
        if duplicated:
            raise CommandError("知识条目标题重复，无法按标题增量更新：" + "、".join(sorted(duplicated)))

        pending, skipped = _sync(docs, options["rebuild"], self.stdout)
        self.stdout.write("待写入向量 %d 条（条目总数 %d，内容未变 %d）。" % (
            len(pending), len(docs), skipped))

        failed = []
        stored = 0
        for start in range(0, len(pending), BATCH_SIZE):
            batch = pending[start:start + BATCH_SIZE]
            self.stdout.write("计算 embedding：第 %d-%d 条 / 共 %d 条" % (
                start + 1, start + len(batch), len(pending)))
            for doc, vector in _embed_batch(batch, failed):
                if _store(doc, vector, failed):
                    stored += 1

        self.stdout.write(self.style.SUCCESS(
            "入库完成：写成向量 %d 条，内容未变跳过 %d 条，失败 %d 条。"
            % (stored, skipped, len(failed))))
        if failed:
            self.stderr.write("以下条目没有写成向量，修好后重跑（增量会自动补上）：")
            for title, reason in failed:
                self.stderr.write("  - %s（%s）" % (title, reason))
