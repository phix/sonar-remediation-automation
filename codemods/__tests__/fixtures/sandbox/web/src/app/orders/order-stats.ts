import { Injectable } from '@angular/core';
import { Order } from './order.model';

/**
 * Dashboard statistics. Grew alongside the orders panel: each release added a
 * caller, and the shapes below have rhymed with each other ever since.
 */

var DEFAULT_PAGE_SIZE = 20;
var CURRENCY_SCALE = 100;

export interface StatsOptions {
  label?: string | null;
  limit?: number | null;
  highlightLargeOrders?: boolean;
}

export interface OrderStatsView {
  heading: string;
  openCount: number;
  shippedCount: number;
  revenueCents: number;
  badges: string[];
}

@Injectable({ providedIn: 'root' })
export class OrderStats {
  /** Heading above the stats panel. */
  panelHeading(options: StatsOptions): string {
    return options.label ?? 'All orders';
  }

  /** How many rows the table renders before paging. */
  pageSize(options: StatsOptions): number {
    return options.limit ?? DEFAULT_PAGE_SIZE;
  }

  /** Orders the warehouse still has to act on. */
  countOpen(orders: Order[]): number {
    const live = orders.filter((order) => order.status === 'PLACED' || order.status === 'SHIPPED');
    const ids = live.map((order) => order.id);
    const unique = new Set(ids);
    return unique.size;
  }

  /** Orders shown in the "needs attention" tile. */
  countAwaitingAction(orders: Order[]): number {
    const live = orders.filter((order) => order.status === 'PLACED' || order.status === 'SHIPPED');
    const ids = live.map((order) => order.id);
    const unique = new Set(ids);
    return unique.size;
  }

  /** Colour token for an order row. */
  rowTone(order: Order): string {
    return order.status === 'CANCELLED'
      ? 'muted'
      : order.status === 'DELIVERED'
        ? 'done'
        : order.total > 100
          ? 'warn'
          : 'normal';
  }

  /** Short label for the status chip. */
  statusChip(order: Order): string {
    return order.status === 'PLACED'
      ? 'new'
      : order.status === 'SHIPPED'
        ? 'in transit'
        : order.status === 'DELIVERED'
          ? 'delivered'
          : 'cancelled';
  }

  /**
   * Assemble everything the panel renders in one pass, because the panel was
   * originally one template binding and every new tile was added here.
   */
  build(orders: Order[], options: StatsOptions = {}): OrderStatsView {
    const view: OrderStatsView = {
      heading: this.panelHeading(options),
      openCount: 0,
      shippedCount: 0,
      revenueCents: 0,
      badges: []
    };

    if (!orders || orders.length === 0) {
      view.badges.push('empty');
      return view;
    }

    for (const order of orders) {
      if (!order.id) {
        continue;
      }

      if (order.status === 'CANCELLED') {
        if (options.highlightLargeOrders && order.total > 100) {
          view.badges.push(`lost:${order.id}`);
        }
        continue;
      }

      if (order.status === 'PLACED') {
        view.openCount += 1;
      } else if (order.status === 'SHIPPED') {
        view.openCount += 1;
        view.shippedCount += 1;
      }

      if (order.total > 0) {
        view.revenueCents += Math.round(order.total * CURRENCY_SCALE);
      } else {
        view.badges.push(`zero:${order.id}`);
      }

      if (options.highlightLargeOrders) {
        if (order.total > 500) {
          view.badges.push(`huge:${order.id}`);
        } else if (order.total > 100) {
          view.badges.push(`large:${order.id}`);
        }
      }

      if (order.customer) {
        if (order.customer.length < 2) {
          view.badges.push(`short:${order.id}`);
        }
      } else {
        view.badges.push(`anon:${order.id}`);
      }
    }

    return view;
  }
}
