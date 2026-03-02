import 'dotenv/config';
import express, { Request, Response } from 'express';
import { webhookHandler } from './feishu/webhook';
import { mcpRouter } from './mcp/handler';

const app = express();
const PORT = process.env.PORT ?? 3000;

// Parse JSON bodies and preserve rawBody for signature verification
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Persistent MCP server (handles all Copilot CLI tool calls via HTTP)
app.use('/mcp', mcpRouter);

// Feishu event webhook
app.post('/webhook/event', (req: Request, res: Response) => {
  webhookHandler(req, res).catch((err) => {
    console.error('webhookHandler error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  });
});

app.listen(PORT, () => {
  console.log(`feishu-copilot listening on port ${PORT}`);
});

export default app;
