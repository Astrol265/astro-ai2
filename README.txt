ASTRO SIGNALS FINAL

Files:
- server.js

Render:
1. Upload server.js to a GitHub repository.
2. Create a Render Web Service from the repository.
3. Build Command: leave empty.
4. Start Command: node server.js
5. Environment variable:
   GEMINI_API_KEY = your Google Gemini API key
6. Optional:
   GEMINI_MODEL = gemini-3.5-flash-lite

The app uses public Binance market data and a server-side Gemini request.
It performs a 3-minute live observation period, collects multiple snapshots,
then uses one Gemini request to confirm the strongest candidate. It returns
NO TRADE when the evidence does not pass the filters.

The evaluator uses an immutable signal snapshot, so it will not access
currentSignal.time after currentSignal has been cleared.

No model can guarantee a successful trade.
