"""KSE syslog（ICAP CEF）解析回归测试：python tests/test_siem.py

样本取自 KSE 2.2 ICAP 模式经 Squid 拦截 EICAR 时实际发出的 CEF 报文（主机名已替换）。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from app.siem import parse_kse_line  # noqa: E402

DETECT = ("<14>CEF:0|Kaspersky|Scan Engine ICAP Service|2.2.0.8899|3|Scan result detect|8|msg=Memory scan result, ObjectId: 4, "
          "result: Detect src=127.0.0.1 dvcpid=437814 dvchost=kse-host dvc=0.0.0.0 cs2=- cs2Label=X-Client-Username "
          "cs3=10.20.30.40 cs3Label=X-Client-IP start=Nov 15 2026 22:42:18.463 fileHash=44D88612FEA8A8F36DE82E1278ABB02F "
          "request=https://secure.eicar.org/eicar.com cs1=Detect cs1Label=Scan result cs4=EICAR-Test-File cs4Label=Virus name "
          "cs5=275A021BBFB6489E54D471899F7DB9D1663FC695EC2FE2A2C4538AABF651FD0F cs5Label=SHA256 cs6=RESPMOD cs6Label=ICAP mode "
          "cn1=68 cn1Label=Request size flexString1=8.10.3.677 flexString1Label=Anti-Virus Engine version")
AUDIT = ("CEF:0|Kaspersky|Scan Engine ICAP Service|2.2.0.8899|1|Audit|3|msg=Kaspersky Scan Engine started in the working mode ICAP. "
         "System audit enabled. dvcpid=437814 dvchost=kse-host dvc=0.0.0.0 start=Nov 15 2026 22:42:12.490")
OTHER = ("CEF:0|Kaspersky|Scan Engine ICAP Service|2.2.0.8899|3|Scan result other|5|msg= src=127.0.0.1 cs3=- cs3Label=X-Client-IP "
         "request=https://example.com/enc.zip cs1=Non_scanned cs1Label=Scan result")


def test_icap_detect():
    ev = parse_kse_line(DETECT)
    assert ev["verdict"] == "DETECT"
    assert ev["detection"] == "EICAR-Test-File"          # 取 Virus name，而不是 cs2（用户名 "-"）
    assert ev["object"] == "https://secure.eicar.org/eicar.com"
    assert ev["host"] == "10.20.30.40"                    # X-Client-IP（发起下载的终端）
    assert ev["sha256"] == "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f"


def test_url_with_query():
    # KSE 不转义 URL 查询参数中的 =，曾导致 request 字段丢失、对象显示为事件名
    ev = parse_kse_line(DETECT.replace("eicar.com cs1=", "eicar.com?x=6046&y=1 cs1="))
    assert ev["object"] == "https://secure.eicar.org/eicar.com?x=6046&y=1"
    assert ev["detection"] == "EICAR-Test-File" and ev["host"] == "10.20.30.40"


def test_audit_ignored():
    assert parse_kse_line(AUDIT) is None                  # 启动 / 停止 / KSN 等审计事件不入库


def test_other_non_scanned():
    ev = parse_kse_line(OTHER)
    assert ev["verdict"] == "NON_SCANNED" and ev["detection"] == "" and ev["host"] == "127.0.0.1"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("PASS", name)
