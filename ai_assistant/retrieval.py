"""知识库检索：向量为主，关键词作降级。

MariaDB 12.3 自带 VECTOR 类型和 VEC_DISTANCE_COSINE()，不需要 pgvector。
Django ORM 不支持这两样，所以这里全部走原生 SQL。

两条路径：
  vector  默认。调 embedding + VEC_DISTANCE_COSINE 排序。
  keyword 降级。AI_BASE_URL 没配、或没有 embedding 模型时用，只要数据库能查就能工作。
"""
import re

from django.conf import settings
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


def _literal(vector):
    """转成 VEC_FromText 认的字面量。

    直接写 '[1,0,0]' 会被 MariaDB 拒掉（错误 1292），必须包一层 VEC_FromText。
    """
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"


def search(question, top_k=None):
    """返回按距离升序的命中，不做阈值过滤。距离越小越像。"""
    config = settings.AI_CONFIG
    top_k = top_k or config["RETRIEVAL_TOP_K"]
    vectors = embed([question])
    if not vectors:
        return []
    with connection.cursor() as cursor:
        cursor.execute(_SEARCH_SQL, [_literal(vectors[0]), top_k])
        rows = cursor.fetchall()
    return [
        {
            "id": str(row[0]),
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
    config = settings.AI_CONFIG
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
            "id": str(row[0]),
            "title": row[1],
            "content": row[2],
            "category": row[3],
            "distance": round(1.0 - score, 4),
        })
    scored.sort(key=lambda item: item["distance"])
    return scored[:top_k]


# ---------- 统一入口 ----------


def retrieve(question, top_k=None):
    """命中且距离达标的条目；一条都不达标时返回 []，由调用方决定拒答。

    空列表这条路径很关键：把它交给模型，模型会硬答。
    """
    config = settings.AI_CONFIG
    backend = config.get("RAG_BACKEND", "vector")
    if backend == "vector":
        limit = config["RETRIEVAL_MAX_DISTANCE"]
        rows = search(question, top_k)
    else:
        # 两套量纲不能共用一个阈值：向量距离 0.30 已经很像，
        # 而关键词的 1 - 命中率在问句较长时天然偏高（命中一半就是 0.5）。
        limit = config.get("KEYWORD_MAX_DISTANCE", 0.75)
        rows = search_keyword(question, top_k)
    return [row for row in rows if row["distance"] <= limit]
