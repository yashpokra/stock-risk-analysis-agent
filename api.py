from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

from graph import run_analysis


class AnalyzeRequest(BaseModel):
    ticker: str
    as_of_date: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    thread_id: Optional[str] = None
    decision: Optional[str] = None


app = FastAPI(title="Stock Risk Analysis API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):517[34]$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    ticker = req.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker is required")
    dates = [req.start_date, req.end_date, req.as_of_date]
    for selected_date in dates:
        if selected_date:
            try:
                datetime.strptime(selected_date, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="Dates must use YYYY-MM-DD format")
    if req.start_date and req.end_date and req.start_date > req.end_date:
        raise HTTPException(status_code=400, detail="Start date must be before end date")
    if req.decision and req.decision not in {"keep", "remove"}:
        raise HTTPException(status_code=400, detail="Decision must be keep or remove")
    return await run_analysis(ticker, req.as_of_date, req.start_date, req.end_date, req.thread_id, req.decision)