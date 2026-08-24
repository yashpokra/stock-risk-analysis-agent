from api import app
from fastapi.staticfiles import StaticFiles

# Serves the built frontend (dist/) alongside the existing /api/* routes
# already registered on this app in api.py. Routes registered first (the
# /api/* ones) still take priority; this mount only catches everything else.
app.mount("/", StaticFiles(directory="dist", html=True), name="frontend")
