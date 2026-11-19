import pathlib
for p in ["tests/architecture/test_demo_seed.py", "tests/architecture/test_public_urls.py", "tests/dashboard/test_asset_cards.py"]:
    t = pathlib.Path(p).read_text(encoding="utf-8")
    print(p, "has_import=", "workspace_detail_text" in t.split("class ")[0])