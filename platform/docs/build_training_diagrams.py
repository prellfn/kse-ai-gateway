"""生成《KAIP 产品培训手册》插图（卡巴斯基设计风格）。
用法：python build_training_diagrams.py [输出目录，默认 training-img]
字体：中文 Microsoft YaHei；拉丁文字优先 Kaspersky Sans Display（未安装时退回 Segoe UI）。
"""
import os
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("training-img"))
OUT.mkdir(parents=True, exist_ok=True)

GREEN = (0, 168, 142)        # Kaspersky green #00A88E
GREEN_D = (0, 109, 92)       # 深绿 #006D5C
GREEN_L = (230, 246, 243)    # 浅绿底 #E6F6F3
INK = (29, 29, 27)           # 石墨黑 #1D1D1B
GRAPH = (60, 60, 59)         # #3C3C3B
GRAY = (138, 138, 138)
LINE = (205, 213, 210)
BG = (255, 255, 255)
PANEL = (244, 246, 245)
WHITE = (255, 255, 255)

WIN = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
USR = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Windows/Fonts"


def _font(cands, size):
    for c in cands:
        for d in (USR, WIN):
            p = d / c
            if p.exists():
                return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


S = 2  # 2 倍分辨率
_cache = {}


def F(size, bold=False, latin=False):
    k = (size, bold, latin)
    if k not in _cache:
        if latin:
            c = ["Kaspersky Sans Display SemiBold.ttf" if bold else "Kaspersky Sans Display Regular.ttf",
                 "segoeuib.ttf" if bold else "segoeui.ttf"]
        else:
            c = ["msyhbd.ttc" if bold else "msyh.ttc", "simhei.ttf"]
        _cache[k] = _font(c, size * S)
    return _cache[k]


CJK = re.compile(r"[\u3000-\u9fff\uff00-\uffef]")


def font_for(text, size, bold):
    return F(size, bold, latin=not CJK.search(text))


def text(d, xy, s, size=15, bold=False, fill=INK, anchor="la"):
    d.text((xy[0] * S, xy[1] * S), s, font=font_for(s, size, bold), fill=fill, anchor=anchor)


def tw(d, s, size, bold=False):
    b = d.textbbox((0, 0), s, font=font_for(s, size, bold))
    return (b[2] - b[0]) / S


def rect(d, x, y, w, h, fill=None, outline=None, width=1, r=6):
    d.rounded_rectangle([x * S, y * S, (x + w) * S, (y + h) * S], radius=r * S, fill=fill,
                        outline=outline, width=width * S)


def arrow(d, pts, color=GREEN, width=2, head=8, both=False):
    p = [(x * S, y * S) for x, y in pts]
    d.line(p, fill=color, width=width * S, joint="curve")

    def tip(a, b):
        import math
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
        h = head * S
        l = (b[0] - h * math.cos(ang - 0.45), b[1] - h * math.sin(ang - 0.45))
        r = (b[0] - h * math.cos(ang + 0.45), b[1] - h * math.sin(ang + 0.45))
        d.polygon([b, l, r], fill=color)
    tip(p[-2], p[-1])
    if both:
        tip(p[1], p[0])


def label(d, x, y, s, size=12, fill=GREEN_D, bg=BG, anchor="mm"):
    w = tw(d, s, size) + 10
    h = size + 8
    rect(d, x - w / 2, y - h / 2, w, h, fill=bg, r=3)
    text(d, (x, y), s, size, fill=fill, anchor=anchor)


def chip(d, x, y, w, h, s, fill=WHITE, fg=INK, outline=LINE, size=13, bold=False):
    rect(d, x, y, w, h, fill=fill, outline=outline, r=4)
    text(d, (x + w / 2, y + h / 2), s, size, bold, fg, anchor="mm")


def canvas(w, h):
    im = Image.new("RGB", (w * S, h * S), BG)
    return im, ImageDraw.Draw(im)


def save(im, name):
    im.save(OUT / name, optimize=True)
    print("已生成", OUT / name)


# ---------------- 图 1：总体架构 ----------------
def arch():
    im, d = canvas(1000, 600)
    # 终端
    rect(d, 20, 70, 270, 360, fill=PANEL, r=10)
    text(d, (38, 86), "开发终端", 17, True)
    text(d, (38, 112), "Windows · Linux · 容器", 12, fill=GRAY)
    for i, n in enumerate(["Codex", "WorkBuddy", "OpenCode"]):
        chip(d, 38 + i * 82, 140, 76, 34, n, size=13, bold=True)
    arrow(d, [(155, 178), (155, 198)], GRAY, 2, 7)
    chip(d, 38, 202, 234, 46, "KAIP hook / 插件", fill=GREEN, fg=WHITE, outline=GREEN, size=15, bold=True)
    text(d, (155, 262), "执行前拦截：命令 · 写文件 · URL · Skill", 11, fill=GRAPH, anchor="mm")
    chip(d, 38, 282, 234, 46, "kaip-watch 后台监控", fill=WHITE, fg=INK, outline=GREEN, size=14, bold=True)
    text(d, (155, 343), "目录监控 · 防篡改自愈 · 心跳 · 自动升级", 11, fill=GRAPH, anchor="mm")
    text(d, (155, 395), "~/.kaip：凭据 · 策略 · 日志", 11, fill=GRAY, anchor="mm")

    # 平台
    rect(d, 360, 50, 300, 400, fill=INK, r=10)
    text(d, (380, 68), "KAIP 平台", 18, True, WHITE)
    text(d, (380, 96), "Linux 服务 / Docker 容器 · 端口 8080（HTTPS 443）", 11, fill=(190, 190, 190))
    mods = ["Agent 判定 API", "供应链扫描网关", "判定缓存", "KAIP 规则", "防护策略", "隔离区",
            "事件与告警", "SIEM 转发", "管理控制台", "客户端分发"]
    for i, m in enumerate(mods):
        cx, cy = 380 + (i % 2) * 135, 124 + (i // 2) * 52
        chip(d, cx, cy, 126, 40, m, fill=(52, 52, 50), fg=WHITE, outline=(80, 80, 78), size=13)
    rect(d, 380, 392, 261, 4, fill=GREEN, r=2)
    text(d, (510, 420), "/var/lib/kaip：数据库 · 隔离文件", 11, fill=(190, 190, 190), anchor="mm")

    # KSE
    rect(d, 730, 70, 250, 250, fill=GREEN, r=10)
    text(d, (748, 86), "Kaspersky Scan Engine", 17, True, WHITE)
    text(d, (748, 112), "KSE 2.2", 12, fill=(220, 245, 240))
    chip(d, 748, 140, 214, 50, "HTTP 1234", fill=WHITE, fg=GREEN_D, outline=WHITE, size=15, bold=True)
    text(d, (855, 202), "scanmemory · scanfile · checkurl", 11, fill=WHITE, anchor="mm")
    chip(d, 748, 222, 214, 50, "ICAP 1344", fill=WHITE, fg=GREEN_D, outline=WHITE, size=15, bold=True)
    text(d, (855, 290), "病毒库 · 启发式 · KSN 云信誉", 11, fill=WHITE, anchor="mm")

    # 连线：终端 ↔ 平台
    arrow(d, [(290, 225), (360, 225)], GREEN, 3, 10)
    arrow(d, [(360, 255), (290, 255)], GREEN_D, 3, 10)
    label(d, 325, 205, "判定请求", 11)
    label(d, 325, 275, "放行/阻断", 11)
    arrow(d, [(290, 305), (360, 305)], GRAY, 2, 8, both=True)
    label(d, 325, 322, "心跳·策略", 10, GRAY)
    # 平台 → KSE
    arrow(d, [(660, 165), (730, 165)], GREEN, 3, 10)
    label(d, 695, 145, "扫描", 11)
    # KSN
    chip(d, 760, 22, 190, 34, "KSN · 病毒库更新", fill=PANEL, fg=GRAPH, outline=LINE, size=12)
    arrow(d, [(855, 56), (855, 70)], GRAY, 2, 7, both=True)

    # 下载代理
    rect(d, 730, 360, 250, 90, fill=PANEL, outline=GREEN, width=2, r=10)
    text(d, (748, 374), "Squid 下载代理（可选）", 14, True)
    text(d, (748, 400), "3128 · HTTPS 解密", 12, fill=GRAPH)
    text(d, (748, 422), "不解密：卡巴斯基 / Windows Update", 11, fill=GRAY)
    arrow(d, [(855, 360), (855, 320)], GREEN, 3, 9)
    label(d, 890, 340, "ICAP", 11)
    arrow(d, [(155, 430), (155, 480), (855, 480), (855, 450)], GRAY, 2, 8)
    label(d, 330, 480, "Skill / 模型 / 安装包下载（经代理）", 11, GRAY)
    arrow(d, [(790, 450), (790, 466), (640, 466), (640, 450)], GRAY, 2, 7)
    label(d, 718, 466, "Syslog 5514", 10, GRAY)

    # 业务系统与 SIEM
    chip(d, 360, 520, 300, 50, "业务系统 · CI · 知识库（API Key）", fill=WHITE, fg=INK, outline=GREEN, size=13, bold=True)
    arrow(d, [(510, 520), (510, 450)], GREEN, 3, 10)
    label(d, 553, 500, "上传扫描", 11)
    chip(d, 730, 520, 250, 50, "SIEM（KUMA 等）", fill=WHITE, fg=INK, outline=LINE, size=13, bold=True)
    arrow(d, [(660, 545), (730, 545)], GRAY, 2, 8)
    label(d, 695, 530, "CEF", 10, GRAY)
    text(d, (20, 22), "图例", 11, True, GRAY)
    rect(d, 60, 20, 22, 14, fill=GREEN, r=2); text(d, (88, 22), "卡巴斯基引擎 / KAIP 防护", 11, fill=GRAY)
    rect(d, 250, 20, 22, 14, fill=INK, r=2); text(d, (278, 22), "KAIP 平台", 11, fill=GRAY)
    save(im, "arch.png")


# ---------------- 图 2：拦截判定流程 ----------------
def flow():
    im, d = canvas(1000, 430)
    steps = [("1", "Agent 工具调用", "执行命令 · 写/改文件\n运行代码 · URL · Skill"),
             ("2", "KAIP hook 截获", "提取脚本、文件、URL\n先过本地防篡改规则"),
             ("3", "平台判定", "名单 → 缓存 → KSE\n→ KAIP 规则"),
             ("4", "策略决策", "按防护策略得出\n放行 / 告警 / 阻断"),
             ("5", "返回 Agent", "阻断：工具调用被拒绝\n放行：Agent 继续执行")]
    w, gap, x0, y0 = 170, 27, 21, 30
    for i, (n, t, sub) in enumerate(steps):
        x = x0 + i * (w + gap)
        fill = INK if i == 2 else (GREEN if i in (1, 3) else PANEL)
        fg = WHITE if i in (1, 2, 3) else INK
        rect(d, x, y0, w, 150, fill=fill, r=10)
        d.ellipse([(x + 14) * S, (y0 + 14) * S, (x + 44) * S, (y0 + 44) * S], fill=WHITE if fill != PANEL else GREEN)
        text(d, (x + 29, y0 + 29), n, 15, True, GREEN_D if fill != PANEL else WHITE, anchor="mm")
        text(d, (x + 14, y0 + 60), t, 15, True, fg)
        for j, line in enumerate(sub.split("\n")):
            text(d, (x + 14, y0 + 92 + j * 22), line, 11, fill=(220, 230, 228) if fg == WHITE else GRAPH)
        if i < len(steps) - 1:
            arrow(d, [(x + w + 2, y0 + 75), (x + w + gap - 2, y0 + 75)], GREEN, 3, 9)
    # 判定 → 处置
    rows = [("CLEAN", "干净", "放行", PANEL, INK),
            ("DETECT", "KSE 检出恶意代码 / 恶意 URL", "阻断；文件同时隔离", GREEN, WHITE),
            ("RISK", "KAIP 规则命中（如 curl | bash）", "高危阻断，中危告警；不自动隔离", GREEN_L, INK),
            ("NON_SCANNED", "加密 / 损坏，无法扫描", "默认按未放行处理", GREEN_L, INK),
            ("ERROR", "KSE 不可用", "默认放行（fail_open）；规则命中仍阻断", (253, 244, 220), INK)]
    yb = 215
    text(d, (20, yb), "判定结果与默认处置（阻断模式）", 14, True)
    for i, (v, desc, act, bg, fg) in enumerate(rows):
        y = yb + 28 + i * 36
        rect(d, 20, y, 150, 30, fill=bg, r=4)
        text(d, (95, y + 15), v, 13, True, fg, anchor="mm")
        text(d, (190, y + 15), desc, 12, fill=GRAPH, anchor="lm")
        text(d, (600, y + 15), act, 12, True, INK, anchor="lm")
    d.line([(580 * S, (yb + 28) * S), (580 * S, (yb + 28 + 5 * 36 - 6) * S)], fill=LINE, width=S)
    save(im, "flow.png")


# ---------------- 图 3：部署模式 ----------------
def deploy():
    im, d = canvas(1000, 400)
    W, G = 300, 30
    titles = [("A", "同机部署", "PoC 与中小规模推荐"), ("B", "分机部署", "KSE 独立服务器"), ("C", "容器部署", "docker compose")]
    for i, (k, t, sub) in enumerate(titles):
        x = 20 + i * (W + G)
        rect(d, x, 20, W, 360, fill=PANEL, r=10)
        rect(d, x, 20, W, 6, fill=GREEN, r=2)
        text(d, (x + 18, 42), f"{k}  {t}", 17, True)
        text(d, (x + 18, 70), sub, 12, fill=GRAY)
    # A
    x = 20
    rect(d, x + 18, 100, W - 36, 250, fill=WHITE, outline=LINE, r=8)
    text(d, (x + 32, 112), "Linux 服务器", 13, True, GRAPH)
    chip(d, x + 40, 145, W - 80, 54, "KAIP 平台  :8080", fill=INK, fg=WHITE, outline=INK, size=14, bold=True)
    arrow(d, [(x + W / 2, 199), (x + W / 2, 245)], GREEN, 3, 9)
    label(d, x + W / 2 + 55, 222, "127.0.0.1:1234", 11)
    chip(d, x + 40, 249, W - 80, 54, "KSE  :1234 / :1344", fill=GREEN, fg=WHITE, outline=GREEN, size=14, bold=True)
    text(d, (x + W / 2, 325), "扫描目录 /opt/kaspersky/scanqueue", 11, fill=GRAY, anchor="mm")
    # B
    x = 20 + W + G
    chip(d, x + 18, 100, W - 36, 100, "", fill=WHITE, outline=LINE)
    text(d, (x + 32, 112), "KAIP 平台服务器", 13, True, GRAPH)
    chip(d, x + 40, 138, W - 80, 46, "KAIP 平台", fill=INK, fg=WHITE, outline=INK, size=14, bold=True)
    chip(d, x + 18, 250, W - 36, 100, "", fill=WHITE, outline=LINE)
    text(d, (x + 32, 262), "KSE 服务器", 13, True, GRAPH)
    chip(d, x + 40, 288, W - 80, 46, "KSE", fill=GREEN, fg=WHITE, outline=GREEN, size=14, bold=True)
    arrow(d, [(x + 110, 200), (x + 110, 250)], GREEN, 3, 9)
    label(d, x + 110, 225, "HTTP 1234", 11)
    arrow(d, [(x + 200, 250), (x + 200, 200)], GRAY, 2, 8)
    label(d, x + 225, 225, "NFS 只读", 11, GRAY)
    text(d, (x + W / 2, 366), "≥25MB 文件经 NFS 由 KSE 按路径扫描", 11, fill=GRAY, anchor="mm")
    # C
    x = 20 + 2 * (W + G)
    rect(d, x + 18, 100, W - 36, 250, fill=WHITE, outline=LINE, r=8)
    text(d, (x + 32, 112), "Docker 主机", 13, True, GRAPH)
    chip(d, x + 40, 142, W - 80, 46, "kaip-platform 容器", fill=INK, fg=WHITE, outline=INK, size=13, bold=True)
    text(d, (x + W / 2, 200), "host 网络 · UID 10001 · kaip-data 卷", 11, fill=GRAY, anchor="mm")
    chip(d, x + 40, 218, W - 80, 46, "OpenCode 容器 + KAIP", fill=GREEN_L, fg=GREEN_D, outline=GREEN, size=13, bold=True)
    text(d, (x + W / 2, 276), "入口脚本自动注册 · kaip-state 卷", 11, fill=GRAY, anchor="mm")
    chip(d, x + 40, 294, W - 80, 40, "KSE（宿主机原生安装）", fill=GREEN, fg=WHITE, outline=GREEN, size=13, bold=True)
    save(im, "deploy.png")


# ---------------- 图 4：防篡改与自愈 ----------------
def heal():
    im, d = canvas(1000, 250)
    nodes = [("Agent 试图篡改", "删除 hook、读取凭据、\n停止监控、卸载 KAIP", PANEL, INK),
             ("执行前阻断", "防篡改规则拦截\n事件 KAIP:Tamper.*", GREEN, WHITE),
             ("事后检测", "kaip-watch 每分钟\n校验文件与配置指纹", INK, WHITE),
             ("自动修复", "从平台下载官方客户端\n恢复 hook 与策略", GREEN, WHITE),
             ("告警上报", "控制台与 SIEM\n可见全过程", PANEL, INK)]
    w, gap = 170, 27
    for i, (t, sub, bg, fg) in enumerate(nodes):
        x = 21 + i * (w + gap)
        rect(d, x, 40, w, 150, fill=bg, r=10)
        text(d, (x + 14, 58), t, 15, True, fg)
        for j, line in enumerate(sub.split("\n")):
            text(d, (x + 14, 96 + j * 22), line, 11, fill=(220, 230, 228) if fg == WHITE else GRAPH)
        if i < len(nodes) - 1:
            arrow(d, [(x + w + 2, 115), (x + w + gap - 2, 115)], GREEN, 3, 9)
    text(d, (20, 212), "前提：防护策略开启「自我保护」与「自动修复」，终端运行 kaip-watch（默认安装）。", 12, fill=GRAY)
    save(im, "heal.png")


# ---------------- 封面底图（A4，150 dpi，无文字） ----------------
def cover():
    W, H = 1240, 1754
    im = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(im)
    for x in range(0, W, 62):
        d.line([(x, 0), (x, H)], fill=(36, 36, 34), width=1)
    for y in range(0, H, 62):
        d.line([(0, y), (W, y)], fill=(36, 36, 34), width=1)
    # 右下绿色斜切色块
    d.polygon([(W, 1050), (W, H), (430, H)], fill=GREEN)
    d.polygon([(W, 1250), (W, H), (760, H)], fill=GREEN_D)
    d.polygon([(W, 900), (W, 960), (330, H), (250, H)], fill=(0, 140, 118))
    im.save(OUT / "cover.png", optimize=True)
    print("已生成", OUT / "cover.png")


# ---------------- 16:9 幻灯片底图（无文字） ----------------
def wide(name, big=True):
    W, H = 1920, 1080
    im = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(im)
    for x in range(0, W, 64):
        d.line([(x, 0), (x, H)], fill=(36, 36, 34), width=1)
    for y in range(0, H, 64):
        d.line([(0, y), (W, y)], fill=(36, 36, 34), width=1)
    if big:   # 封面 / 结束页：右侧大面积斜切色块
        d.polygon([(W, 180), (W, H), (1050, H)], fill=GREEN)
        d.polygon([(W, 520), (W, H), (1420, H)], fill=GREEN_D)
        d.polygon([(W, 60), (W, 120), (990, H), (920, H)], fill=(0, 140, 118))
    else:     # 模块扉页：右下小色块
        d.polygon([(W, 640), (W, H), (1420, H)], fill=GREEN)
        d.polygon([(W, 860), (W, H), (1680, H)], fill=GREEN_D)
    im.save(OUT / name, optimize=True)
    print("已生成", OUT / name)


if __name__ == "__main__":
    arch()
    flow()
    deploy()
    heal()
    cover()
    wide("slide-cover.png", True)
    wide("slide-divider.png", False)
