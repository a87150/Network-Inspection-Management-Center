"""知识库检索：向量为主，关键词作降级。

MariaDB 12.3 自带 VECTOR 类型和 VEC_DISTANCE_COSINE()，不需要 pgvector。
Django ORM 不支持这两样，所以这里全部走原生 SQL。

两条路径：
  vector  默认。调 embedding + VEC_DISTANCE_COSINE 排序。
  keyword 降级。AI_BASE_URL 没配、或没有 embedding 模型时用，只要数据库能查就能工作。
"""
import re
import uuid

from .config import ai_config
from django.db import connection

from .client import embed

_SEARCH_SQL = """
SELECT id, title, content, category,
       VEC_DISTANCE_COSINE(embedding, VEC_FromText(%s)) AS distance
FROM ai_assistant_knowledgedoc
WHERE embedding IS NOT NULL
ORDER BY distance
LIMIT %s
"""


def _row_id(value):
    """把裸 SQL 读出的主键变成和 ORM 一致的带横线 UUID 字符串。

    MariaDB 后端把 UUIDField 存成 char(32)（无横线），裸 SQL 不经过
    get_prep_value，读回来是 32 位裸 hex；ORM 的 str(uuid) 是 36 位带横线。
    两者不归一，同一条记录在融合时会被当成两条，via 永远算不出 both。
    """
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        return str(value)


def _literal(vector):
    """转成 VEC_FromText 认的字面量。

    直接写 '[1,0,0]' 会被 MariaDB 拒掉（错误 1292），必须包一层 VEC_FromText。
    """
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"


def search(question, top_k=None):
    """返回按距离升序的命中，不做阈值过滤。距离越小越像。"""
    config = ai_config()
    top_k = top_k or config["RETRIEVAL_TOP_K"]
    vectors = embed([question])
    if not vectors:
        return []
    with connection.cursor() as cursor:
        cursor.execute(_SEARCH_SQL, [_literal(vectors[0]), top_k])
        rows = cursor.fetchall()
    return [
        {
            "id": _row_id(row[0]),
            "title": row[1],
            "content": row[2],
            "category": row[3],
            "distance": float(row[4]),
        }
        for row in rows
    ]


# ---------- 降级：不依赖模型的检索 ----------
#
# 原方案写的「jieba + SQLite FTS5」在这个项目里跑不通：本项目是 MariaDB，
# 没有 FTS5；本机 MariaDB 也没编译 ngram 分词插件（创建索引报 1128
# Function 'ngram' is not defined）。所以降级路径用纯 Python 分词 + LIKE：
# 中文切 2-gram，英文按单词切，命中率用「命中词数 / 总词数」换算成和向量
# 同量纲的距离（1 - score），两条路径的返回值结构完全一致。

_TOKEN_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_.-]*|[\u4e00-\u9fff]+")
_STOPWORDS = frozenset({"的", "了", "是", "在", "和", "有", "我", "你", "它", "怎么", "如何", "什么"})


def _tokenize(text):
    """中文切 2-gram，英文保留整词。去重后按长度降序，长词更有区分度。"""
    tokens = []
    for chunk in _TOKEN_RE.findall(text or ""):
        if chunk[0].isascii():
            if len(chunk) >= 2:
                tokens.append(chunk.lower())
            continue
        if len(chunk) == 1:
            continue
        tokens.extend(chunk[index : index + 2] for index in range(len(chunk) - 1))
    seen = []
    for token in tokens:
        if token in _STOPWORDS or token in seen:
            continue
        seen.append(token)
    return sorted(seen, key=len, reverse=True)


def search_keyword(question, top_k=None):
    """不调 embedding 的关键词检索，返回结构与 search() 一致。"""
    config = ai_config()
    top_k = top_k or config["RETRIEVAL_TOP_K"]
    tokens = _tokenize(question)
    if not tokens:
        return []
    where = " OR ".join(["title LIKE %s OR content LIKE %s"] * len(tokens))
    params = []
    for token in tokens:
        pattern = "%" + token + "%"
        params.extend([pattern, pattern])
    sql = (
        "SELECT id, title, content, category FROM ai_assistant_knowledgedoc "
        "WHERE " + where
    )
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        rows = cursor.fetchall()
    scored = []
    for row in rows:
        blob = "%s\n%s" % (row[1], row[2])
        hit = sum(1 for token in tokens if token in blob)
        score = hit / len(tokens)
        if score <= 0:
            continue
        scored.append({
            "id": _row_id(row[0]),
            "title": row[1],
            "content": row[2],
            "category": row[3],
            "distance": round(1.0 - score, 4),
        })
    scored.sort(key=lambda item: item["distance"])
    return scored[:top_k]


# ---------- 混合检索 ----------
#
# 纯向量对字面量不敏感：「S5735」和「S5732」在语义空间挨得很近，但在运维里是
# 两个型号；设备名、问题编号、命令片段这类查询，关键词命中比语义近邻可靠。
# 所以默认两路都跑，用 RRF 融合排名。

# RRF 的平滑常数。60 是检索文献里的常用取值：它压低头部差异，
# 让「一路第一 + 另一路第五」和「两路都第三」不至于差出一个数量级。
RRF_K = 60

# 标题覆盖率够高时给的额外分。两路都排第一的 RRF 分约 0.033，
# 这个量级能把它顶到最前，又不足以让一个正文只擦边的条目挤掉真正的双路命中。
TITLE_BOOST = 0.05
TITLE_COVERAGE = 0.6


def _safe_vector_search(question, depth, limit):
    """向量路自己出问题不该连累关键词路：没配 API、上游超时都退化成空。"""
    try:
        return [row for row in search(question, depth) if row["distance"] <= limit]
    except Exception:
        return []


def _title_coverage(question, title):
    """标题命中了多少比例的查询词。0 到 1。"""
    tokens = _tokenize(question)
    if not tokens or not title:
        return 0.0
    lowered = title.lower()
    hit = sum(1 for token in tokens if token in lowered)
    return hit / len(tokens)


def fuse(question, ranked_lists, top_k):
    """RRF：每路只贡献排名分，不掺距离。返回带 score 与 via 的条目。"""
    scores = {}
    rows = {}
    via = {}
    for name, hits in ranked_lists:
        for rank, hit in enumerate(hits, 1):
            key = hit["id"]
            rows[key] = hit
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + rank)
            via.setdefault(key, set()).add(name)
    if not rows:
        return []
    for key, hit in rows.items():
        if _title_coverage(question, hit["title"]) >= TITLE_COVERAGE:
            scores[key] += TITLE_BOOST
    ordered = sorted(rows.values(), key=lambda row: scores[row["id"]], reverse=True)
    result = []
    for hit in ordered[:top_k]:
        row = dict(hit)
        row["score"] = round(scores[hit["id"]], 4)
        # via 是给页面的「依据」标签用的，让人看得出这条是字面命中还是语义命中。
        marks = via[hit["id"]]
        row["via"] = "both" if len(marks) > 1 else marks.pop()
        result.append(row)
    return result


# ---------- 统一入口 ----------


def retrieve(question, top_k=None):
    """命中且达标的条目；一条都不达标时返回 []，由调用方决定拒答。

    空列表这条路径很关键：把它交给模型，模型会硬答。
    """
    config = ai_config()
    backend = config.get("RAG_BACKEND", "hybrid")
    top_k = top_k or config["RETRIEVAL_TOP_K"]

    if backend == "keyword":
        limit = config.get("KEYWORD_MAX_DISTANCE", 0.75)
        return [row for row in search_keyword(question, top_k) if row["distance"] <= limit]

    if backend == "vector":
        limit = config["RETRIEVAL_MAX_DISTANCE"]
        return [row for row in search(question, top_k) if row["distance"] <= limit]

    # hybrid：两路各多取一些再融合，depth 小于 top_k 会让融合没得选。
    depth = max(top_k * 3, 12)
    keyword_limit = config.get("KEYWORD_MAX_DISTANCE", 0.75)
    vector_hits = _safe_vector_search(question, depth, config["RETRIEVAL_MAX_DISTANCE"])
    keyword_hits = [row for row in search_keyword(question, depth) if row["distance"] <= keyword_limit]
    return fuse(question, [("vector", vector_hits), ("keyword", keyword_hits)], top_k)
