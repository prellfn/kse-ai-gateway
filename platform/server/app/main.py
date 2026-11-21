"""KAIP 平台入口。

运行：uvicorn app.main:app --host 0.0.0.0 --port 8080
"""
import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import api_agent, api_console, api_supply, auth, db, siem
from .config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("kaip")

app = FastAPI(title="KAIP Platform", version="1.0.0",
              description="Kaspersky AI Protect 平台：AI Agent 运行时防护 + AI 供应链入口扫描")
app.include_router(api_agent.router)
app.include_router(api_supply.router)
app.include_router(api_console.router)
app.include_router(api_console.dl)

WEB = Path(__file__).resolve().parents[1] / "web"
app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.on_event("startup")
def startup():
    db.conn()
    auth.bootstrap()
    if settings.syslog_listen:
        siem.start_syslog_listener(settings.syslog_port)
    log.info("KAIP 平台启动：引擎模式=%s KSE=%s 数据目录=%s", settings.kse_mode, settings.kse_url, settings.data_dir)


@app.get("/healthz")
def healthz():
    return {"status": "ok", "engine": settings.kse_mode}


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


@app.exception_handler(Exception)
async def unhandled(request, exc):
    log.exception("未处理异常")
    return JSONResponse({"detail": f"服务器内部错误：{exc}"}, status_code=500)
