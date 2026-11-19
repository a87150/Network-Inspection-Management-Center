import pathlib
files = {
  "tests/architecture/test_demo_seed.py": "from tests.payloads import",
  "tests/architecture/test_public_urls.py": "from tests.payloads import",
  "tests/dashboard/test_asset_cards.py": "from tests.payloads import",
}
for p, pat in files.items():
    lines = pathlib.Path(p).read_text(encoding="utf-8").splitlines()
    for i, l in enumerate(lines, 1):
        if l.startswith(pat):
            print(p, i, l.strip())
            break
    else:
        print(p, "NO cargo")