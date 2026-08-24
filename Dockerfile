# Stage 1: build the frontend, then rewrite the hardcoded backend URL to a
# relative path (src/App.jsx itself is never touched — only the built output).
FROM node:20-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build && \
    find dist/assets -name '*.js' -exec sed -i 's#http://127\.0\.0\.1:8001##g' {} +

# Stage 2: the backend, now also serving the built frontend as static files.
FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api.py graph.py stock_mcp.py risk_mcp.py search_mcp.py prod_app.py ./
COPY --from=frontend-build /app/dist ./dist
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "prod_app:app", "--host", "0.0.0.0", "--port", "8000"]
