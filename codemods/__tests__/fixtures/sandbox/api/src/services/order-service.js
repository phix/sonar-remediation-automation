const VALID_STATUSES = ['PLACED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

/**
 * Order business rules. Kept separate from the routes so the HTTP layer stays
 * thin and the rules are testable without a server.
 */
export function createOrderService(store) {
  const cacheTtlSeconds = 60;

  return {
    listOrders() {
      return store.list();
    },

    getOrder(id) {
      return store.find(id);
    },

    /**
     * Search orders. Every filter the dashboard has ever needed is applied
     * here, in the order the requests arrived over the years.
     */
    filterOrders(criteria = {}) {
      const results = [];

      for (const order of store.list()) {
        if (criteria.status) {
          if (Array.isArray(criteria.status)) {
            if (!criteria.status.includes(order.status)) {
              continue;
            }
          } else if (order.status !== criteria.status) {
            continue;
          }
        }

        if (criteria.customer) {
          if (criteria.exactCustomer) {
            if (order.customer !== criteria.customer) {
              continue;
            }
          } else if (!order.customer.includes(criteria.customer)) {
            continue;
          }
        }

        if (criteria.minTotal !== undefined && order.total < criteria.minTotal) {
          continue;
        }
        if (criteria.maxTotal !== undefined && order.total > criteria.maxTotal) {
          continue;
        }

        if (criteria.excludeCancelled && order.status === 'CANCELLED') {
          continue;
        }

        if (criteria.openOnly) {
          if (order.status === 'DELIVERED' || order.status === 'CANCELLED') {
            continue;
          }
        }

        results.push(order);
      }

      if (criteria.sort === 'total') {
        results.sort((a, b) => (criteria.desc ? b.total - a.total : a.total - b.total));
      } else if (criteria.sort === 'customer') {
        results.sort((a, b) => a.customer.localeCompare(b.customer));
      }

      return criteria.limit ? results.slice(0, criteria.limit) : results;
    },

    /** Total value of every order not cancelled. */
    totalRevenue() {
      return store
        .list()
        .filter((order) => order.status !== 'CANCELLED')
        .reduce((sum, order) => sum + order.total, 0);
    },

    /**
     * Move an order to a new status.
     * @returns the updated order, or an object describing why it was refused.
     */
    updateStatus(id, status) {
      if (!VALID_STATUSES.includes(status)) {
        return { error: 'invalid_status', validStatuses: VALID_STATUSES };
      }

      const order = store.find(id);
      if (!order) {
        return { error: 'not_found' };
      }

      if (order.status === 'CANCELLED') {
        return { error: 'already_cancelled' };
      }

      return { order: store.save({ ...order, status }) };
    }
  };
}

export { VALID_STATUSES };
