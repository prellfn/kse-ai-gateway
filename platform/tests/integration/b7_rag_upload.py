"""PoC 用例 B7：RAG 知识库文档上传扫描（在 KAIP 服务器上运行）

流程：临时启动「模拟知识库入库端点」(127.0.0.1:9099) → 将 KAIP 的 RAG 对接临时指向它（Webhook）→
逐个上传正常/含样本文档（category=rag, forward_rag=true）→ 校验：正常文档放行且已入库，含样本文档被阻断且未入库
→ 恢复原 RAG 对接配置。全部测试样本在内存中生成（EICAR 为无害标准测试串）。

用法（服务器上）：/opt/kaip/venv/bin/python b7_rag_upload.py
"""
import io
import json
import sqlite3
import subprocess
import tempfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx

PLATFORM = "http://127.0.0.1:8080"
DATA = Path("/var/lib/kaip")
EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

# ---------------- 模拟知识库入库端点 ----------------
RECEIVED: list[str] = []


class Ingest(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        name = "?"
        for part in body.split(b"\r\n"):
            if b'filename="' in part:
                name = part.split(b'filename="', 1)[1].split(b'"', 1)[0].decode("utf-8", "replace")
                break
        RECEIVED.append(name)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *a):
        pass


# ---------------- 样本构造 ----------------
def docx(extra: dict | None = None, text="KAIP 测试文档：公司差旅报销制度。") -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml",
                   '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   f'<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
        for k, v in (extra or {}).items():
            z.writestr(k, v)
    return b.getvalue()


def pdf(text="KAIP test PDF: product manual.", embed: bytes | None = None) -> bytes:
    objs = ["<< /Type /Catalog /Pages 2 0 R" + (" /Names << /EmbeddedFiles << /Names [(a.com) 6 0 R] >> >>" if embed else "") + " >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    stream = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode()
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(out.tell())
        if o is None:
            out.write(f"{i} 0 obj << /Length {len(stream)} >> stream\n".encode() + stream + b"\nendstream endobj\n")
        else:
            out.write(f"{i} 0 obj {o} endobj\n".encode())
    if embed:
        offs.append(out.tell())
        out.write(b"6 0 obj << /Type /Filespec /F (a.com) /EF << /F 7 0 R >> >> endobj\n")
        offs.append(out.tell())
        out.write(f"7 0 obj << /Type /EmbeddedFile /Length {len(embed)} >> stream\n".encode() + embed + b"\nendstream endobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(offs)+1}\n0000000000 65535 f \n".encode())
    for o in offs:
        out.write(f"{o:010d} 00000 n \n".encode())
    out.write(f"trailer << /Size {len(offs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def zipped(files: dict) -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in files.items():
            z.writestr(k, v)
    return b.getvalue()


def encrypted_zip() -> bytes | None:
    """用系统 zip 命令生成加密压缩包（内为正常文本）；无 zip 命令则跳过。"""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d)
        (p / "minutes.txt").write_text("加密的会议纪要（正常内容）")
        r = subprocess.run(["zip", "-q", "-P", "kaip-test", "enc.zip", "minutes.txt"], cwd=d, capture_output=True)
        return (p / "enc.zip").read_bytes() if r.returncode == 0 else None


CASES = [
    # 名称, 内容, 期望动作, 说明
    ("travel_policy.txt", "公司差旅报销制度（正常文本）。\n".encode() * 20, "allow", "正常文本"),
    ("handbook.docx", docx(), "allow", "正常 Word 文档"),
    ("manual.pdf", pdf(), "allow", "正常 PDF"),
    ("kb_bundle_clean.zip", zipped({"faq.md": "# FAQ\n正常内容".encode(), "guide.txt": b"normal guide"}), "allow", "正常文档压缩包"),
    ("report_with_payload.docx", docx({"word/embeddings/oleObject1.bin": EICAR}), "block", "Word 文档内嵌测试样本"),
    ("kb_bundle_payload.zip", zipped({"notes.md": b"# notes", "attachments/tool.com": EICAR}), "block", "压缩包内含测试样本"),
    ("nested.zip", zipped({"inner/level2.zip": zipped({"deep/a.com": EICAR})}), "block", "多层嵌套压缩包内含样本"),
    ("manual_with_attachment.pdf", pdf(embed=EICAR), "block", "PDF 内嵌附件为测试样本"),
]


def main():
    db = sqlite3.connect(DATA / "kaip.db")
    api_key = json.loads(db.execute("select v from kv where k='api_key'").fetchone()[0])
    pw = (DATA / "initial_admin_password.txt").read_text().strip()

    srv = HTTPServer(("127.0.0.1", 9099), Ingest)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    admin = httpx.Client(base_url=PLATFORM, timeout=120)
    admin.post("/api/v1/console/login", json={"username": "admin", "password": pw}).raise_for_status()
    old_rag = admin.get("/api/v1/console/settings").json()["rag"]
    admin.put("/api/v1/console/settings/rag", json={"enabled": True, "type": "webhook", "url": "http://127.0.0.1:9099/ingest",
                                                     "api_key": "", "workspace": ""}).raise_for_status()
    cases = list(CASES)
    enc = encrypted_zip()
    if enc:
        cases.append(("minutes_encrypted.zip", enc, "block", "加密压缩包（无法扫描→按未放行处理）"))

    api = httpx.Client(base_url=PLATFORM, timeout=300, headers={"X-API-Key": api_key})
    fails = 0
    try:
        print(f"{'文件':<28}{'说明':<26}{'判定':<14}{'检出/原因':<34}{'动作':<7}{'入库':<6}结果")
        for name, data, want, desc in cases:
            before = len(RECEIVED)
            r = api.post("/api/v1/supply/upload", files={"file": (name, data)},
                         data={"category": "rag", "forward_rag": "true"}).json()
            ingested = len(RECEIVED) > before and RECEIVED[-1] == name
            ok = r.get("action") == want and (ingested if want == "allow" else not ingested)
            fails += 0 if ok else 1
            why = r.get("detection") or r.get("reason") or ""
            print(f"{name:<28}{desc:<26}{r.get('verdict',''):<14}{why[:32]:<34}{r.get('action',''):<7}"
                  f"{'是' if ingested else '否':<6}{'PASS' if ok else 'FAIL'}")
    finally:
        admin.put("/api/v1/console/settings/rag", json=old_rag)
        srv.shutdown()
    print(f"\n模拟知识库实际收到：{RECEIVED}")
    print(f"结果：{len(cases) - fails}/{len(cases)} 通过；RAG 对接配置已恢复为测试前状态")
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
