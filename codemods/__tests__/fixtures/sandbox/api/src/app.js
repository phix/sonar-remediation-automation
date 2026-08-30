import express from 'express';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.js';
import { createOrderService } from './services/order-service.js';
import { createOrderRouter } from './routes/orders.js';
import { createSessionGuard } from './auth/session.js';

export function createApp({ store = createStore() } = {}) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/session', createSessionGuard({ required: ['orders:read'] }), (req, res) =>
    res.json({ session: req.session })
  );
  app.use('/api/orders', createOrderRouter(createOrderService(store)));

  return app;
}
