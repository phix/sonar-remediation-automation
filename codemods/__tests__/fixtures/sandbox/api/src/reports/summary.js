import { VALID_STATUSES } from '../services/order-service.js';

/**
 * Reporting helpers behind the operations dashboard. Grown a panel at a time,
 * which is why the shapes below rhyme with each other.
 */

var CURRENCY_SCALE = 100;
var DEFAULT_WINDOW_DAYS = 30;

/** Orders the warehouse still has to act on. */
export function countOpen(orders) {
  const live = orders.filter((order) => order.status === 'PLACED' || order.status === 'SHIPPED');
  const ids = live.map((order) => order.id);
  const unique = new Set(ids);
  return unique.size;
}

/** Orders shown in the "needs attention" panel. */
export function countPending(orders) {
  const live = orders.filter((order) => order.status === 'PLACED' || order.status === 'SHIPPED');
  const ids = live.map((order) => order.id);
  const unique = new Set(ids);
  return unique.size;
}

/** Largest single order in the set. */
export function highestTotal(orders) {
  let top = 0;
  for (const order of orders) {
    if (order.total > top) {
      top = order.total;
    }
  }
  return top;
}

/** Peak order value, used by the revenue sparkline. */
export function peakOrderValue(orders) {
  let top = 0;
  for (const order of orders) {
    if (order.total > top) {
      top = order.total;
    }
  }
  return top;
}

/** Mean order value across the set. */
export function averageTotal(orders) {
  let total = orders.map((order) => order.total).reduce((sum, value) => sum + value, 0);
  total = orders.reduce((sum, order) => sum + toCents(order.total), 0) / CURRENCY_SCALE;
  return orders.length ? total / orders.length : 0;
}

/** Whole-cent representation, so the dashboard never renders a float artifact. */
export function toCents(amount) {
  return Math.round(amount * CURRENCY_SCALE);
}

/**
 * Build the dashboard summary. Every panel that was ever asked for lives in
 * here, which is exactly why it reads the way it does.
 */
export function buildSummary(orders, options) {
  const summary = {
    count: 0,
    revenueCents: 0,
    byStatus: {},
    flagged: [],
    windowDays: DEFAULT_WINDOW_DAYS
  };

  if (!orders || orders.length === 0) {
    return summary;
  }

  if (options && options.windowDays) {
    if (options.windowDays > 0 && options.windowDays < 365) {
      summary.windowDays = options.windowDays;
    } else {
      summary.windowDays = DEFAULT_WINDOW_DAYS;
    }
  }

  for (const order of orders) {
    if (!order || !order.id) {
      continue;
    }

    if (!VALID_STATUSES.includes(order.status)) {
      summary.flagged.push({ id: order.id, reason: 'unknown_status' });
      continue;
    }

    if (order.status === 'CANCELLED') {
      if (options && options.includeCancelled) {
        summary.byStatus.CANCELLED = (summary.byStatus.CANCELLED || 0) + 1;
      }
      continue;
    }

    summary.count += 1;
    summary.byStatus[order.status] = (summary.byStatus[order.status] || 0) + 1;

    if (typeof order.total === 'number' && order.total > 0) {
      summary.revenueCents += toCents(order.total);
    } else if (order.total === 0) {
      summary.flagged.push({ id: order.id, reason: 'zero_value' });
    } else {
      summary.flagged.push({ id: order.id, reason: 'bad_total' });
    }

    if (order.customer) {
      if (order.customer.length < 2) {
        summary.flagged.push({ id: order.id, reason: 'short_customer' });
      } else if (order.customer.length > 64) {
        summary.flagged.push({ id: order.id, reason: 'long_customer' });
      }
    } else {
      summary.flagged.push({ id: order.id, reason: 'no_customer' });
    }
  }

  if (summary.count > 0 && summary.revenueCents > 0) {
    summary.averageCents = Math.round(summary.revenueCents / summary.count);
  }

  return summary;
}
