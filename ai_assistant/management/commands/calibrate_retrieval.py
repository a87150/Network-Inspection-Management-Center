"""实测知识库检索的 top-1 距离，给出 RETRIEVAL_MAX_DISTANCE 的建议值。

见 docs/ai-assistant-design.md 第 7 节：取工作类最大值与无关类最小值的中点。
阈值跟着 embedding 模型走，不跟着代码走，换模型后必须重跑。
"""
import statistics

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from ai_assistant.client import AiNotConfigured, AiUpstreamError
from ai_assistant.models import KnowledgeDoc
from ai_assistant.retrieval import search

WORK_QUESTIONS = (
    "交换机 CPU 占用率持续超过 90% 怎么处置？",
    "网络设备巡检支持哪些厂商？",
    "弱电设备台账里 camera 对应什么设备类型？",
    "采集模板的继承层级是怎么设计的？",
    "华为交换机查看 ARP 表的命令是什么？",
    "告警策略的继承和覆盖有什么区别？",
    "维护窗口生效期间告警会被丢弃吗？",
    "PC 磁盘使用率的默认阈值是多少？",
    "告警发送失败最多重试几次？",
    "交换机端口 err-disabled 导致终端断网怎么处理？",
)

UNRELATED_QUESTIONS = (
    "红烧肉怎么做才不腻？",
    "明天去杭州的高铁票怎么买？",
    "推荐几本适合入门的心理学书。",
    "世界杯历史上巴西队夺冠几次？",
    "六个月大的婴儿怎么添加辅食？",
    "Python 的装饰器怎么用？",
    "手冲咖啡的水温控制在多少度？",
    "房贷利率下调对房价有什么影响？",
    "哪款手机夜间拍照效果最好？",
    "成人学钢琴应该先练什么指法？",
)


def _top1_distance(question):
    """取一条问题的 top-1 距离。

    这里用 search 不用 retrieve：retrieve 会按当前阈值过滤，无关问题必然返回空列表，
    拿不到它的 top-1 距离，校准就没有数据了。
    """
    hits = search(question, top_k=1)
    return hits[0]["distance"] if hits else None


def _summary(values):
    return "最小 %.4f / 最大 %.4f / 中位数 %.4f" % (
        min(values), max(values), statistics.median(values))


class Command(BaseCommand):
    help = "实测工作类与无关类问题的 top-1 检索距离，给出 RETRIEVAL_MAX_DISTANCE 建议值。"

    def handle(self, *args, **options):
        config = getattr(settings, "AI_CONFIG", None) or {}
        if not config.get("BASE_URL") or not config.get("API_KEY"):
            raise CommandError(
                "未配置 AI_BASE_URL / AI_API_KEY：两组问题都要真实调用 embedding 接口才能测出距离，"
                "先在环境变量里配好再跑。"
            )
        if not KnowledgeDoc.objects.filter(embedded_at__isnull=False).exists():
            raise CommandError("知识库里还没有向量，先跑 python manage.py build_knowledge。")

        work = self._measure("工作", WORK_QUESTIONS)
        unrelated = self._measure("无关", UNRELATED_QUESTIONS)
        if not work or not unrelated:
            raise CommandError("两组各至少要有 1 条测出距离，才能给出建议阈值。")

        self.stdout.write("")
        for label, values in (("工作", work), ("无关", unrelated)):
            self.stdout.write("%s类 %d 条：%s" % (label, len(values), _summary(values)))

        highest = max(work)
        lowest = min(unrelated)
        suggestion = (highest + lowest) / 2
        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(
            "建议阈值 %.4f（工作类最大 %.4f 与无关类最小 %.4f 的中点）"
            % (suggestion, highest, lowest)))
        if highest >= lowest:
            self.stdout.write(self.style.WARNING(
                "两组有重叠：工作类最远 %.4f 已经不小于无关类最近 %.4f，不存在能分开的阈值。"
                "先补知识条目或换 embedding 模型，不要硬调阈值。"
                % (highest, lowest)))
        current = config.get("RETRIEVAL_MAX_DISTANCE")
        if current is not None:
            self.stdout.write(
                "当前 AI_RETRIEVAL_MAX_DISTANCE = %.4f；按建议值改环境变量后重跑验收用例。" % current)

    def _measure(self, label, questions):
        self.stdout.write("")
        self.stdout.write("=== %s类问题 ===" % label)
        values = []
        for question in questions:
            try:
                distance = _top1_distance(question)
            except (AiUpstreamError, AiNotConfigured) as error:
                self.stdout.write(self.style.ERROR("  调用失败：%s（%s）" % (question, error)))
                continue
            if distance is None:
                self.stdout.write(self.style.ERROR("  没有命中：%s（知识库向量为空）" % question))
                continue
            values.append(distance)
            self.stdout.write("  %.4f  %s" % (distance, question))
        return values
