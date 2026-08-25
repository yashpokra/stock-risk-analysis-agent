from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime

from graph import run_analysis


class AnalyzeRequest(BaseModel):
    ticker: str
    as_of_date: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    thread_id: Optional[str] = None
    decision: Optional[str] = None


app = FastAPI(title="Stock Risk Analysis API")


def _validate_date(selected_date: str) -> None:
    try:
        parsed = datetime.strptime(selected_date, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Enter a valid calendar date in YYYY-MM-DD format") from exc
    if parsed < date(2026, 8, 1) or parsed > date.today():
        raise HTTPException(status_code=400, detail="Date must be between 2026-08-01 and today")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5175",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):517[345]$",
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
            _validate_date(selected_date)
    if req.start_date and req.end_date and req.start_date > req.end_date:
        raise HTTPException(status_code=400, detail="Start date must be before end date")
    if req.decision and req.decision not in {"keep", "remove"}:
        raise HTTPException(status_code=400, detail="Decision must be keep or remove")
    return await run_analysis(ticker, req.as_of_date, req.start_date, req.end_date, req.thread_id, req.decision)
