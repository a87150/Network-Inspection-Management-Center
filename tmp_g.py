import pathlib
for p, pat in [
  ("tests/architecture/test_demo_seed.py", "detail-bootstrap"),
  ("tests/architecture/test_public_urls.py", "detail-bootstrap"),
  ("tests/dashboard/test_asset_cards.py", "detail-bootstrap"),
]:
    lines = pathlib.Path(p).read_text(encoding="utf-8").splitlines()
    for i, l in enumerate(lines, 1):
        if pat in l:
            print(p, i, l.strip()[:120])