"""平台判定缓存回归测试：python tests/test_cache.py

验证：病毒库版本不变命中缓存（不再按 24 小时过期）；版本变化立即失效并清理旧条目；兜底有效期；控制台统计。
"""
import os
import shutil
import sys
import time
from pathlib import Path

DATA = Path(__file__).resolve().parent / ".cache-testdata"
shutil.rmtree(DATA, ignore_errors=True)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
os.environ["KAIP_DATA_DIR"] = str(DATA)
os.environ["KAIP_KSE_MODE"] = "mock"

from app import db, kse, scanner  # noqa: E402
from app.kse import EICAR  # noqa: E402


def set_bases(v):
    kse._bases.update(v=v, t=time.time())


def scan(data):
    return scanner.scan(data=data, name="x.bin", category="file", source="api", record_clean=False)


def test_same_bases_hits():
    set_bases("B1")
    a = scan(b"clean sample 1")
    b = scan(b"clean sample 1")
    assert not a["cached"] and b["cached"] and b["bases_version"] == "B1", (a, b)
    d1, d2 = scan(EICAR), scan(EICAR)
    assert d2["cached"] and d2["verdict"] == "DETECT" and d2["detection"] == d1["detection"]


def test_old_entry_within_7_days_still_valid():
    set_bases("B1")
    scan(b"clean sample old")
    db.execute("UPDATE verdict_cache SET ts=? WHERE bases='B1'", (time.time() - 3 * 86400,))
    assert scan(b"clean sample old")["cached"], "版本不变 3 天前的判定应仍有效"


def test_bases_change_invalidates_and_purges():
    set_bases("B1")
    scan(b"clean sample 2")
    set_bases("B2")
    r = scan(b"clean sample 2")
    assert not r["cached"] and r["bases_version"] == "B2"
    left = db.query_one("SELECT COUNT(*) AS n FROM verdict_cache WHERE bases IS NOT 'B2'")["n"]
    assert left == 0, f"旧病毒库条目未清理：{left}"
    assert scan(b"clean sample 2")["cached"]


def test_cache_valid_rules():
    now = time.time()
    assert scanner.cache_valid({"verdict": "CLEAN", "ts": now - 6 * 86400, "bases": "B"}, "B", now)
    assert not scanner.cache_valid({"verdict": "CLEAN", "ts": now - 8 * 86400, "bases": "B"}, "B", now)
    assert not scanner.cache_valid({"verdict": "CLEAN", "ts": now, "bases": "A"}, "B", now)
    assert not scanner.cache_valid({"verdict": "RISK", "ts": now, "bases": "B"}, "B", now)
    # 查不到病毒库版本（KSE 不可达）：退回 24 小时
    assert scanner.cache_valid({"verdict": "CLEAN", "ts": now - 3600, "bases": "A"}, None, now)
    assert not scanner.cache_valid({"verdict": "CLEAN", "ts": now - 25 * 3600, "bases": "A"}, None, now)


def test_console_cache_info():
    set_bases("B3")
    scan(b"clean sample 3")
    scan(b"clean sample 3")
    c = scanner.cache_info()
    assert c["bases"] == "B3" and c["valid"] >= 1 and c["hits"] >= 1 and 0 < c["hit_rate"] <= 1, c


if __name__ == "__main__":
    fails = 0
    for k, fn in list(globals().items()):
        if k.startswith("test_"):
            try:
                fn()
                print("PASS", k)
            except AssertionError as e:
                fails += 1
                print("FAIL", k, e)
    shutil.rmtree(DATA, ignore_errors=True)
    sys.exit(1 if fails else 0)
